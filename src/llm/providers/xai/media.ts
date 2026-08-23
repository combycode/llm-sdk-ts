/** xAI media adapter — images, TTS, video. All HTTP through EngineFetch. */

import { isBrowser } from '../../../runtime/runtime';
import { base64ToBytes } from '../../../util/base64';
import { sniffImageMime } from '../../../util/image-mime';
import { buildFromSpec } from '../../../wire/interpreter';
import type { Registry } from '../../../wire/interpreter';
import { serviceSpec } from '../../../wire/service-specs';
import { makeRegistry } from '../../wire-transforms';
import type { EngineFetch, HttpRequest } from '../../../network/types';
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

export interface XAIMediaAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class XAIMediaAdapter implements MediaProviderAdapter {
  readonly name = 'xai';
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: XAIMediaAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.x.ai';
  }

  capabilities(): MediaCapabilities {
    return {
      imageGeneration: true,
      imageEditing: true,
      audioGeneration: true,
      videoGeneration: true,
      audioStreaming: true,
      videoExtension: true,
    };
  }

  /** Named code the specs cannot express as data — image/video source refs. */
  private readonly wireRegistry: Registry = makeRegistry({});

  /** Build one request from its spec, then add the engine metadata.
   *
   *  `provider`, `model` and `responseType` are routing and decoding concerns that
   *  never reach xAI, so the specs do not model them. */
  private fromSpec(
    specId: string,
    req: object,
    model: string,
    responseType: 'json' | 'arraybuffer' = 'json',
  ): HttpRequest {
    const built = buildFromSpec(
      serviceSpec(specId),
      { ...req, model } as never,
      this.wireRegistry,
      'xai',
      undefined,
      { baseURL: this.baseURL, apiKey: this.apiKey },
    );
    return { ...(built as object), provider: 'xai', model, responseType } as HttpRequest;
  }

  /** Text-to-image. */
  buildImageRequest(req: ImageGenRequest, model = req.model ?? 'grok-imagine-image'): HttpRequest {
    return this.fromSpec('xai/images.generations', req, model);
  }

  /** Image-to-image edit — JSON with a data-URL or file_id, no multipart, no mask. */
  buildEditImageRequest(req: ImageEditRequest, model = req.model ?? 'grok-imagine-image'): HttpRequest {
    return this.fromSpec('xai/images.edits', req, model);
  }

  /** TTS. arraybuffer because the response is audio bytes. */
  buildAudioRequest(req: AudioGenRequest, model = req.model ?? ''): HttpRequest {
    return this.fromSpec('xai/tts', req, model, 'arraybuffer');
  }

  /** Video submission, routed by input and mode:
   *    no sourceVideo                  -> /v1/videos/generations
   *    sourceVideo + videoMode extend  -> /v1/videos/extensions  (duration only)
   *    sourceVideo + videoMode edit    -> /v1/videos/edits       (prompt + video)
   *  Three endpoints with three different field sets, so three specs. */
  buildVideoRequest(req: VideoGenRequest, model = req.model ?? 'grok-imagine-video'): HttpRequest {
    const id = !req.sourceVideo
      ? 'xai/videos.generations'
      : (req.params?.videoMode ?? 'extend') === 'edit'
        ? 'xai/videos.edits'
        : 'xai/videos.extensions';
    return this.fromSpec(id, req, model);
  }

  async generateImage(req: ImageGenRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    const model = req.model ?? 'grok-imagine-image';
    const res = await fetch(this.buildImageRequest(req, model));
    return this.parseImages(res.body as Record<string, unknown>, model, fetch);
  }

  /** Image-to-image edit via `/v1/images/edits` (JSON; base64 data-URL or
   *  file_id, no multipart, no mask). */
  async editImage(req: ImageEditRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    const model = req.model ?? 'grok-imagine-image';
    const res = await fetch(this.buildEditImageRequest(req, model));
    return this.parseImages(res.body as Record<string, unknown>, model, fetch);
  }

  /** Parse an images response (b64_json inline or url to download), attaching
   *  xAI's provider cost (usage.cost_in_usd_ticks) to the first item. */
  private async parseImages(
    data: Record<string, unknown>,
    model: string,
    fetch: EngineFetch,
  ): Promise<RawMediaResult[]> {
    const items = (data.data as Array<Record<string, unknown>>) ?? [];
    const results: RawMediaResult[] = [];
    for (const item of items) {
      if (item.b64_json) {
        // xAI (grok-imagine) returns JPEG bytes but no mime — sniff it, don't
        // assume PNG, or the mislabel breaks downstream image-to-video.
        const bytes = base64ToBytes(item.b64_json as string);
        results.push({
          data: bytes,
          mimeType: sniffImageMime(bytes) ?? 'image/png',
          revisedPrompt: item.revised_prompt as string | undefined,
        });
      } else if (item.url) {
        const imgRes = await fetch({
          url: item.url as string,
          method: 'GET',
          headers: {},
          body: undefined,
          provider: 'xai',
          model,
          responseType: 'arraybuffer',
        });
        results.push({
          data: imgRes.body as Uint8Array,
          mimeType: imgRes.headers['content-type'] ?? 'image/png',
          revisedPrompt: item.revised_prompt as string | undefined,
        });
      }
    }
    if (results[0] && data.usage) results[0].providerMeta = { usage: data.usage };
    return results;
  }

  async generateAudio(req: AudioGenRequest, fetch: EngineFetch): Promise<RawMediaResult> {
    const model = req.model ?? '';
    const res = await fetch(this.buildAudioRequest(req, model));

    const buffer = res.body as Uint8Array;
    const format = req.params?.format ?? 'mp3';
    const mimeMap: Record<string, string> = {
      mp3: 'audio/mp3',
      wav: 'audio/wav',
      pcm: 'audio/pcm',
      mulaw: 'audio/mulaw',
      alaw: 'audio/alaw',
    };

    return { data: buffer, mimeType: mimeMap[format] ?? 'audio/mp3' };
  }

  async submitVideo(req: VideoGenRequest, fetch: EngineFetch): Promise<string> {
    const model = req.model ?? 'grok-imagine-video';
    const res = await fetch(this.buildVideoRequest(req, model));
    const data = res.body as Record<string, unknown>;
    return (data.request_id as string) ?? (data.id as string) ?? '';
  }

  async getVideoStatus(operationId: string, fetch: EngineFetch): Promise<VideoStatus> {
    const res = await fetch({
      url: `${this.baseURL}/v1/videos/${operationId}`,
      method: 'GET',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: undefined,
      provider: 'xai',
      model: '',
      responseType: 'json',
    });
    if (res.status >= 400) return { status: 'failed', error: `HTTP ${res.status}` };

    const data = res.body as Record<string, unknown>;
    const state = (data.status as string) ?? '';
    const video = data.video as { url?: string } | undefined;
    const progress = data.progress as number | undefined;

    // xAI reports terminal success as `status: "done"` with the URL under
    // `video.url` (NOT `completed`/`download_url` — those never arrive, so the
    // old check polled until timeout even after the server was finished).
    if (state === 'done' || state === 'completed' || state === 'ready' || video?.url || data.download_url) {
      return { status: 'completed', progress };
    }
    if (state === 'failed' || state === 'error' || state === 'expired') {
      return { status: 'failed', error: (data.error as string) ?? 'Unknown error' };
    }
    return { status: 'processing', progress };
  }

  async downloadVideo(operationId: string, fetch: EngineFetch): Promise<RawMediaResult> {
    const statusRes = await fetch({
      url: `${this.baseURL}/v1/videos/${operationId}`,
      method: 'GET',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: undefined,
      provider: 'xai',
      model: '',
      responseType: 'json',
    });
    if (statusRes.status >= 400) {
      throw new Error(`xAI video download failed: HTTP ${statusRes.status}`);
    }

    const data = statusRes.body as Record<string, unknown>;
    const video = data.video as { url?: string; duration?: number } | undefined;
    // Real shape: `video: { url, duration }`. Keep the flat fallbacks for safety.
    const downloadUrl = video?.url ?? (data.download_url as string) ?? (data.url as string);
    if (!downloadUrl) throw new Error('No download URL in video response');
    const durationSec = video?.duration ?? (data.duration as number | undefined);
    const base: RawMediaResult = {
      data: new Uint8Array(0),
      mimeType: 'video/mp4',
      sourceUrl: downloadUrl,
      durationMs: durationSec ? durationSec * 1000 : undefined,
      // Provider-reported cost (usage.cost_in_usd_ticks), when present.
      providerMeta: data.usage ? { usage: data.usage } : undefined,
    };

    // The video lives on a cross-origin bucket (vidgen.x.ai) that sends no CORS
    // headers, so a programmatic byte-fetch is blocked in the browser. There we
    // return the URL only — `<video src>` plays it cross-origin without CORS,
    // and it can be re-submitted as a `sourceVideo`. Node/Bun fetch the bytes.
    if (isBrowser()) return base;

    const videoRes = await fetch({
      url: downloadUrl,
      method: 'GET',
      headers: {},
      body: undefined,
      provider: 'xai',
      model: '',
      responseType: 'arraybuffer',
    });

    return { ...base, data: videoRes.body as Uint8Array };
  }

  async cancelVideo(operationId: string, fetch: EngineFetch): Promise<void> {
    await fetch({
      url: `${this.baseURL}/v1/videos/${operationId}/cancel`,
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: {},
      provider: 'xai',
      model: '',
      responseType: 'json',
    });
  }
}
