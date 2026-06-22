/** MediaOutput — separate-endpoint media generation (images, audio, video).
 *
 *  All HTTP calls flow through an injected EngineFetch (NetworkEngine queue).
 *  Persists raw bytes to MediaStore, emits onMediaGenerated (which carries
 *  cost-relevant metadata for CostCollector to price). Inline media (e.g.
 *  Google generateContent images, OpenAI image_generation tool) is handled
 *  by core LLM adapters + an onCompletion subscriber, NOT this class. */

import type { HookBus } from '../../bus/hook-bus';
import type { MediaOutputPart } from '../../llm/types/messages';
import { emptyUsage, type Usage } from '../../llm/types/response';
import type { EngineFetch } from '../../network/types';
import type { ModelCatalog } from '../model-catalog/catalog';
import {
  MEDIA_OUTPUT_DEFAULTS,
  type AudioGenRequest,
  type ImageEditRequest,
  type ImageGenRequest,
  type MediaMeta,
  type MediaOutputConfig,
  type MediaProviderAdapter,
  type MediaResult,
  type MediaStore,
  type MediaType,
  type RawMediaResult,
  type VideoGenRequest,
} from './types';

export interface MediaOutputInit {
  hooks: HookBus;
  mediaStore: MediaStore;
  /** Network fetch — all adapter HTTP goes through this so calls flow through
   *  the NetworkEngine queue (rate-limit, retry, hooks). Typically engine.fetch. */
  fetch: EngineFetch;
  providers?: Map<string, MediaProviderAdapter>;
  catalog?: ModelCatalog;
  config?: MediaOutputConfig;
  /** Trace session id (engine.sessionId); each op mints its own requestId. */
  sessionId?: string;
}

export class MediaOutput {
  private hooks: HookBus;
  private mediaStore: MediaStore;
  private fetch: EngineFetch;
  private providers: Map<string, MediaProviderAdapter>;
  private catalog: ModelCatalog | null;
  private pollIntervalMs: number;
  private maxPollWaitMs: number;
  private sessionId?: string;

  constructor(init: MediaOutputInit) {
    this.hooks = init.hooks;
    this.mediaStore = init.mediaStore;
    this.fetch = init.fetch;
    this.providers = init.providers ?? new Map();
    this.catalog = init.catalog ?? null;
    this.pollIntervalMs = init.config?.pollIntervalMs ?? MEDIA_OUTPUT_DEFAULTS.pollIntervalMs;
    this.maxPollWaitMs = init.config?.maxPollWaitMs ?? MEDIA_OUTPUT_DEFAULTS.maxPollWaitMs;
    this.sessionId = init.sessionId;
  }

  /** Mint a trace + a fetch that stamps it onto every request this op makes. */
  private tracedOp(): { trace: import('../../network/types').TraceContext; fetch: EngineFetch } {
    const trace = {
      sessionId: this.sessionId,
      requestId: `req_${crypto.randomUUID().slice(0, 12)}`,
    };
    const fetch: EngineFetch = (req, options) => this.fetch({ ...req, trace }, options);
    return { trace, fetch };
  }

  registerProvider(name: string, adapter: MediaProviderAdapter): void {
    this.providers.set(name, adapter);
  }

  async generateImage(req: ImageGenRequest): Promise<MediaResult[]> {
    const adapter = this.getAdapter(req.provider);
    if (!adapter.capabilities().imageGeneration) {
      throw new Error(`Provider ${req.provider} does not support image generation`);
    }
    const { trace, fetch } = this.tracedOp();
    const rawResults = await adapter.generateImage(req, fetch);
    return this.saveResults(
      rawResults,
      'image',
      req.provider,
      req.model,
      req.prompt,
      undefined,
      req.params?.resolution,
      trace,
    );
  }

  async editImage(req: ImageEditRequest): Promise<MediaResult[]> {
    const adapter = this.getAdapter(req.provider);
    if (!adapter.capabilities().imageEditing || !adapter.editImage) {
      throw new Error(`Provider ${req.provider} does not support image editing`);
    }
    const { trace, fetch } = this.tracedOp();
    const rawResults = await adapter.editImage(req, fetch);
    return this.saveResults(
      rawResults,
      'image',
      req.provider,
      req.model,
      req.prompt,
      undefined,
      req.params?.resolution,
      trace,
    );
  }

  async generateAudio(req: AudioGenRequest): Promise<MediaResult> {
    const adapter = this.getAdapter(req.provider);
    if (!adapter.capabilities().audioGeneration) {
      throw new Error(`Provider ${req.provider} does not support audio generation`);
    }
    const { trace, fetch } = this.tracedOp();
    const raw = await adapter.generateAudio(req, fetch);
    const results = await this.saveResults(
      [raw],
      'audio',
      req.provider,
      req.model,
      undefined,
      req.input,
      undefined,
      trace,
    );
    return results[0];
  }

  async generateVideo(req: VideoGenRequest): Promise<MediaResult> {
    const adapter = this.getAdapter(req.provider);
    if (!adapter.capabilities().videoGeneration || !adapter.submitVideo) {
      throw new Error(`Provider ${req.provider} does not support video generation`);
    }
    const { trace, fetch } = this.tracedOp();
    const operationId = await adapter.submitVideo(req, fetch);
    return this.pollVideoCompletion(adapter, operationId, req, fetch, trace);
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private getAdapter(provider: string): MediaProviderAdapter {
    const adapter = this.providers.get(provider);
    if (!adapter) {
      throw new Error(
        `No media adapter registered for provider: ${provider}. Call registerProvider() first.`,
      );
    }
    return adapter;
  }

  private async saveResults(
    rawResults: RawMediaResult[],
    type: MediaType,
    provider: string,
    model?: string,
    prompt?: string,
    input?: string,
    resolution?: string,
    trace?: import('../../network/types').TraceContext,
  ): Promise<MediaResult[]> {
    const results: MediaResult[] = [];
    const prefix = type === 'image' ? 'img' : type === 'audio' ? 'aud' : 'vid';

    for (const raw of rawResults) {
      const id = `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
      const meta: MediaMeta = {
        id,
        type,
        mimeType: raw.mimeType,
        size: raw.data.length,
        createdAt: Date.now(),
        provider,
        model,
        prompt: prompt ?? input,
        revisedPrompt: raw.revisedPrompt,
        width: raw.width,
        height: raw.height,
        durationMs: raw.durationMs,
        sampleRate: raw.sampleRate,
      };

      await this.mediaStore.save(id, raw.data, meta);
      results.push({ id, type, mimeType: raw.mimeType, meta });
    }

    // Emit one cost-bearing event covering the batch. CostCollector subscribes
    // and prices via the cost engine (provider/token/per-unit/flat).
    const totalDurationSeconds = results.reduce(
      (sum, r) => sum + (r.meta.durationMs ?? 0) / 1000,
      0,
    );
    await this.hooks.emit('onMediaGenerated', {
      parts: results.map((r) => buildMediaPart(r)),
      stored: true,
      provider,
      source: 'media_output',
      model,
      mediaType: type,
      count: results.length,
      textInput: input,
      durationSeconds: totalDurationSeconds || undefined,
      usage: aggregateUsage(rawResults),
      resolution,
      providerEvidence: rawResults.find((r) => r.providerMeta)?.providerMeta,
      trace,
    });

    return results;
  }

  private async pollVideoCompletion(
    adapter: MediaProviderAdapter,
    operationId: string,
    req: VideoGenRequest,
    fetch: EngineFetch,
    trace: import('../../network/types').TraceContext,
  ): Promise<MediaResult> {
    if (!adapter.getVideoStatus || !adapter.downloadVideo) {
      throw new Error('Adapter missing getVideoStatus/downloadVideo for async video');
    }

    const start = Date.now();

    while (Date.now() - start < this.maxPollWaitMs) {
      const status = await adapter.getVideoStatus(operationId, fetch);

      if (status.status === 'completed') {
        const raw = await adapter.downloadVideo(operationId, fetch);
        const results = await this.saveResults(
          [raw],
          'video',
          req.provider,
          req.model,
          req.prompt,
          undefined,
          req.params?.resolution,
          trace,
        );
        return results[0];
      }

      if (status.status === 'failed') {
        await this.hooks.emit('onMediaError', {
          id: operationId,
          type: 'video',
          provider: req.provider,
          error: status.error ?? 'Video generation failed',
          operationId,
        });
        throw new Error(`Video generation failed: ${status.error}`);
      }

      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }

    throw new Error(`Video generation timed out after ${this.maxPollWaitMs}ms`);
  }
}

function buildMediaPart(r: MediaResult): MediaOutputPart {
  if (r.type === 'image') {
    return { type: 'image_output', mediaId: r.id, mimeType: r.mimeType };
  }
  if (r.type === 'audio') {
    return { type: 'audio_output', mediaId: r.id, mimeType: r.mimeType };
  }
  return { type: 'video_output', mediaId: r.id, mimeType: r.mimeType };
}

/** Sum token usage across a media batch, or undefined when no item reported any
 *  (unit-priced media). */
function aggregateUsage(rawResults: RawMediaResult[]): Usage | undefined {
  const withUsage = rawResults.filter((r) => r.usage);
  if (withUsage.length === 0) return undefined;
  const total = emptyUsage();
  for (const { usage } of withUsage) {
    if (!usage) continue;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.totalTokens += usage.totalTokens;
    total.cachedTokens += usage.cachedTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    total.reasoningTokens += usage.reasoningTokens;
  }
  return total;
}
