/** OpenAI media adapter — image generation (/v1/images/generations) and TTS
 *  (/v1/audio/speech). All HTTP calls flow through an injected EngineFetch
 *  so they share the NetworkEngine queue, rate-limits, retry, and hooks. */

import { base64ToBytes } from '../../../util/base64';
import type { EngineFetch } from '../../../network/types';
import { resolveVoice } from '../../audio/voices';
import { emptyUsage, type Usage } from '../../types/response';
import { normalizeImageSource, openaiImageRef } from '../../../plugins/media/source-image';
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

  async generateImage(req: ImageGenRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    const model = req.model ?? 'gpt-image-1';
    const body: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      n: req.params?.n ?? 1,
    };
    // gpt-image-1 always returns b64_json and rejects the parameter; older
    // dall-e-3 / dall-e-2 endpoints still accept (and need) the explicit format.
    if (!model.startsWith('gpt-image-')) {
      body.response_format = 'b64_json';
    }
    if (req.params?.size) body.size = req.params.size;
    if (req.params?.quality) body.quality = req.params.quality;
    if (req.params?.style) body.style = req.params.style;
    if (req.params?.background) body.background = req.params.background;
    if (req.params?.outputFormat) body.output_format = req.params.outputFormat;

    const res = await fetch({
      url: `${this.baseURL}/v1/images/generations`,
      method: 'POST',
      headers: this.authHeaders(),
      body,
      provider: 'openai',
      model,
      responseType: 'json',
    });

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
    const model = req.model ?? 'gpt-image-1';
    const body: Record<string, unknown> = {
      model,
      prompt: req.prompt,
      images: [openaiImageRef(normalizeImageSource(req.sourceImage))],
      n: req.params?.n ?? 1,
    };
    if (req.mask) body.mask = openaiImageRef(normalizeImageSource(req.mask));
    if (req.params?.size) body.size = req.params.size;
    if (req.params?.quality) body.quality = req.params.quality;
    if (req.params?.background) body.background = req.params.background;
    if (req.params?.outputFormat) body.output_format = req.params.outputFormat;

    const res = await fetch({
      url: `${this.baseURL}/v1/images/edits`,
      method: 'POST',
      headers: this.authHeaders(),
      body,
      provider: 'openai',
      model,
      responseType: 'json',
    });
    return this.parseImages(res.body as Record<string, unknown>);
  }

  async generateAudio(req: AudioGenRequest, fetch: EngineFetch): Promise<RawMediaResult> {
    const model = req.model;
    if (!model) throw new Error('OpenAI TTS requires a model (e.g. "tts-1", "gpt-4o-mini-tts")');

    const body: Record<string, unknown> = {
      model,
      input: req.input,
      voice: resolveVoice('openai', req.params?.voice) ?? 'alloy',
    };
    if (req.params?.format) body.response_format = req.params.format;
    if (req.params?.speed) body.speed = req.params.speed;
    if (req.params?.instructions) body.instructions = req.params.instructions;

    const res = await fetch({
      url: `${this.baseURL}/v1/audio/speech`,
      method: 'POST',
      headers: this.authHeaders(),
      body,
      provider: 'openai',
      model,
      responseType: 'arraybuffer',
    });

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
    const model = req.model ?? 'sora-2';
    const body: Record<string, unknown> = { model, prompt: req.prompt };
    if (req.params?.duration) body.seconds = String(req.params.duration);
    if (req.params?.size) body.size = req.params.size;
    if (req.sourceImage) {
      body.input_reference = openaiImageRef(normalizeImageSource(req.sourceImage));
    }

    const res = await fetch({
      url: `${this.baseURL}/v1/videos`,
      method: 'POST',
      headers: this.authHeaders(),
      body,
      provider: 'openai',
      model,
      responseType: 'json',
    });
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
