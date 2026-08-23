/** OpenAI media adapter — image generation (/v1/images/generations) and TTS
 *  (/v1/audio/speech). All HTTP calls flow through an injected EngineFetch
 *  so they share the NetworkEngine queue, rate-limits, retry, and hooks. */

import { base64ToBytes } from '../../../util/base64';
import { buildFromSpec } from '../../../wire/interpreter';
import type { Registry } from '../../../wire/interpreter';
import { mediaSpec } from '../../../wire/media-specs';
import { makeRegistry } from '../../wire-transforms';
import type { EngineFetch, HttpRequest } from '../../../network/types';
import { emptyUsage, type Usage } from '../../types/response';
import type {
  AudioGenRequest,
  ImageEditRequest,
  ImageGenRequest,
  MediaCapabilities,
  MediaProviderAdapter,
  RawMediaResult,
  VideoGenRequest,
  VideoStatus,
} from '../../../plugins/media/types';

export interface OpenAIMediaAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** Map OpenAI Images `usage` (image-token billing) to the universal Usage. */
function mapOpenAIImageUsage(u: Record<string, unknown> | undefined): Usage | undefined {
  if (!u) return undefined;
  return {
    ...emptyUsage(),
    inputTokens: Number(u.input_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    totalTokens: Number(u.total_tokens ?? 0),
  };
}

export class OpenAIMediaAdapter implements MediaProviderAdapter {
  readonly name = 'openai';
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: OpenAIMediaAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.openai.com';
  }

  capabilities(): MediaCapabilities {
    return {
      imageGeneration: true,
      imageEditing: true,
      audioGeneration: true,
      videoGeneration: true,
      audioStreaming: false,
    };
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
  }

  /** Named code the specs cannot express as data — image-source normalisation. */
  private readonly wireRegistry: Registry = makeRegistry({ openaiResponses: this });

  /** Build one media request from its spec, then add the engine metadata.
   *
   *  `provider`, `model` and `responseType` are NOT wire: the NetworkEngine routes
   *  and decodes with them and no provider ever sees them, so the specs do not
   *  model them and this layer keeps supplying them. */
  private fromSpec(
    specId: string,
    req: object,
    model: string,
    responseType: 'json' | 'arraybuffer',
  ): HttpRequest {
    const built = buildFromSpec(
      mediaSpec(specId),
      { ...req, model } as never,
      this.wireRegistry,
      'openai',
      undefined,
      { baseURL: this.baseURL, apiKey: this.apiKey },
    );
    return { ...(built as object), provider: 'openai', model, responseType } as HttpRequest;
  }

  // ─── request builders ──────────────────────────────────────────────────
  //
  // Separated from the methods that fetch and parse, so a request can be built
  // and asserted without performing it. Every method below used to assemble its
  // request inline, which meant the only way to see what the adapter would send
  // was to intercept the network.

  /** Text-to-image. */
  /** Text-to-image.
   *
   *  The spec forks by family, and the fork is real: gpt-image-1 always returns
   *  b64_json and REJECTS `response_format`, while dall-e-3 / dall-e-2 still
   *  require it. */
  buildGenerateImageRequest(
    req: ImageGenRequest,
    model = req.model ?? 'gpt-image-1',
  ): HttpRequest {
    return this.fromSpec(
      model.startsWith('gpt-image-')
        ? 'openai/images.generations'
        : 'openai/images.generations@dall-e',
      req,
      model,
      'json',
    );
  }

  /** Image-to-image edit. Generation's field set minus `style`, plus the source
   *  image and an optional mask. */
  /** Image-to-image edit. */
  buildEditImageRequest(req: ImageEditRequest, model = req.model ?? 'gpt-image-1'): HttpRequest {
    return this.fromSpec('openai/images.edits', req, model, 'json');
  }

  /** TTS. `responseType` is arraybuffer because the response is audio bytes. */
  /** TTS. `responseType` is arraybuffer because the response is audio bytes —
   *  transport decoding, which is the engine's business rather than the wire's. */
  buildAudioRequest(req: AudioGenRequest, model: string): HttpRequest {
    return this.fromSpec('openai/audio.speech', req, model, 'arraybuffer');
  }

  /** Sora video submission. `seconds` goes on the wire as a string. */
  /** Sora video submission. */
  buildVideoRequest(req: VideoGenRequest, model = req.model ?? 'sora-2'): HttpRequest {
    return this.fromSpec('openai/videos', req, model, 'json');
  }

  async generateImage(req: ImageGenRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    const res = await fetch(this.buildGenerateImageRequest(req));
    return this.parseImages(res.body as Record<string, unknown>);
  }

  /** Parse `/v1/images/{generations,edits}` response → RawMediaResult[], with
   *  the request-level usage attached to the first item (billed once). */
  private parseImages(data: Record<string, unknown>): RawMediaResult[] {
    const items = (data.data as Array<Record<string, unknown>>) ?? [];
    const usage = mapOpenAIImageUsage(data.usage as Record<string, unknown> | undefined);
    return items.map((item, i) => ({
      data: base64ToBytes((item.b64_json as string) ?? ''),
      mimeType: 'image/png',
      revisedPrompt: item.revised_prompt as string | undefined,
      usage: i === 0 ? usage : undefined,
    }));
  }

  /** Image-to-image edit via `/v1/images/edits` (JSON, base64 data-URL or
   *  file_id references). */
  async editImage(req: ImageEditRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    const res = await fetch(this.buildEditImageRequest(req));
    return this.parseImages(res.body as Record<string, unknown>);
  }

  async generateAudio(req: AudioGenRequest, fetch: EngineFetch): Promise<RawMediaResult> {
    const model = req.model;
    if (!model) throw new Error('OpenAI TTS requires a model (e.g. "tts-1", "gpt-4o-mini-tts")');

    const res = await fetch(this.buildAudioRequest(req, model));

    const buffer = res.body as Uint8Array;
    const format = req.params?.format ?? 'mp3';
    const mimeMap: Record<string, string> = {
      mp3: 'audio/mp3',
      wav: 'audio/wav',
      pcm: 'audio/pcm',
      opus: 'audio/opus',
      aac: 'audio/aac',
      flac: 'audio/flac',
    };

    return { data: buffer, mimeType: mimeMap[format] ?? 'audio/mp3' };
  }

  // ─── Sora video (async: create → poll → download) ──────────────────────
  async submitVideo(req: VideoGenRequest, fetch: EngineFetch): Promise<string> {
    const res = await fetch(this.buildVideoRequest(req));
    const data = res.body as Record<string, unknown>;
    return (data.id as string) ?? '';
  }

  async getVideoStatus(videoId: string, fetch: EngineFetch): Promise<VideoStatus> {
    const res = await fetch({
      url: `${this.baseURL}/v1/videos/${videoId}`,
      method: 'GET',
      headers: this.authHeaders(),
      body: undefined,
      provider: 'openai',
      model: '',
      responseType: 'json',
    });
    if (res.status >= 400) return { status: 'failed', error: `HTTP ${res.status}` };

    const data = res.body as Record<string, unknown>;
    const s = data.status as string;
    const progress = typeof data.progress === 'number' ? data.progress : undefined;
    if (s === 'completed') return { status: 'completed', progress };
    if (s === 'failed') {
      const err = data.error as Record<string, unknown> | undefined;
      return { status: 'failed', error: (err?.message as string) ?? 'failed' };
    }
    return { status: 'processing', progress };
  }

  async downloadVideo(videoId: string, fetch: EngineFetch): Promise<RawMediaResult> {
    const res = await fetch({
      url: `${this.baseURL}/v1/videos/${videoId}/content`,
      method: 'GET',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: undefined,
      provider: 'openai',
      model: '',
      responseType: 'arraybuffer',
    });
    if (res.status >= 400) throw new Error(`OpenAI Sora download failed: HTTP ${res.status}`);
    return { data: res.body as Uint8Array, mimeType: 'video/mp4' };
  }
}
