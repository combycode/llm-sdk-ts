/** xAI media adapter — images, TTS, video. All HTTP through EngineFetch. */

import { base64ToBytes } from '../../../util/base64';
import { sniffImageMime } from '../../../util/image-mime';
import { normalizeImageSource, xaiImageRef } from '../../../plugins/media/source-image';
import type { EngineFetch } from '../../../network/types';
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
    };
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
  }

  async generateImage(req: ImageGenRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    const model = req.model ?? 'grok-imagine-image';
    const body: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      n: req.params?.n ?? 1,
      response_format: req.params?.responseFormat ?? 'b64_json',
    };
    if (req.params?.aspectRatio) body.aspect_ratio = req.params.aspectRatio;
    if (req.params?.resolution) body.resolution = req.params.resolution;

    const res = await fetch({
      url: `${this.baseURL}/v1/images/generations`,
      method: 'POST',
      headers: this.authHeaders(),
      body,
      provider: 'xai',
      model,
      responseType: 'json',
    });
    return this.parseImages(res.body as Record<string, unknown>, model, fetch);
  }

  /** Image-to-image edit via `/v1/images/edits` (JSON; base64 data-URL or
   *  file_id, no multipart, no mask). */
  async editImage(req: ImageEditRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    const model = req.model ?? 'grok-imagine-image';
    const body: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      image: xaiImageRef(normalizeImageSource(req.sourceImage)),
      response_format: req.params?.responseFormat ?? 'b64_json',
    };
    if (req.params?.aspectRatio) body.aspect_ratio = req.params.aspectRatio;
    if (req.params?.resolution) body.resolution = req.params.resolution;

    const res = await fetch({
      url: `${this.baseURL}/v1/images/edits`,
      method: 'POST',
      headers: this.authHeaders(),
      body,
      provider: 'xai',
      model,
      responseType: 'json',
    });
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
    const body: Record<string, unknown> = {
      text: req.input,
      voice: req.params?.voice ?? 'eve',
      language: req.params?.language ?? 'en',
    };
    if (req.params?.format) body.codec = req.params.format;
    if (req.params?.sampleRate) body.sample_rate = req.params.sampleRate;

    const res = await fetch({
      url: `${this.baseURL}/v1/tts`,
      method: 'POST',
      headers: this.authHeaders(),
      body,
      provider: 'xai',
      model,
      responseType: 'arraybuffer',
    });

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
    const body: Record<string, unknown> = { model, prompt: req.prompt };
    if (req.params?.duration) body.duration = req.params.duration;
    if (req.params?.aspectRatio) body.aspect_ratio = req.params.aspectRatio;
    if (req.params?.resolution) body.resolution = req.params.resolution;
    // First-frame image → image-to-video.
    if (req.sourceImage) body.image = xaiImageRef(normalizeImageSource(req.sourceImage));

    const res = await fetch({
      url: `${this.baseURL}/v1/videos/generations`,
      method: 'POST',
      headers: this.authHeaders(),
      body,
      provider: 'xai',
      model,
      responseType: 'json',
    });
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

    if (state === 'completed' || state === 'ready' || data.download_url) {
      return { status: 'completed' };
    }
    if (state === 'failed' || state === 'error') {
      return { status: 'failed', error: (data.error as string) ?? 'Unknown error' };
    }
    return { status: 'processing', progress: data.progress as number | undefined };
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
    const downloadUrl = (data.download_url as string) ?? (data.url as string);
    if (!downloadUrl) throw new Error('No download URL in video response');

    const videoRes = await fetch({
      url: downloadUrl,
      method: 'GET',
      headers: {},
      body: undefined,
      provider: 'xai',
      model: '',
      responseType: 'arraybuffer',
    });

    return {
      data: videoRes.body as Uint8Array,
      mimeType: 'video/mp4',
      durationMs: (data.duration as number) ? (data.duration as number) * 1000 : undefined,
      // Provider-reported cost (usage.cost_in_usd_ticks), when present.
      providerMeta: data.usage ? { usage: data.usage } : undefined,
    };
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
