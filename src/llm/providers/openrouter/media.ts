/** OpenRouter media adapter. OpenRouter has NO dedicated media endpoints —
 *  image (and audio) generation go through `POST /api/v1/chat/completions` with
 *  a `modalities` field; output comes back on `message.images[]` /
 *  `message.audio`. Cost is the provider-reported `usage.cost`. */

import type { EngineFetch } from '../../../network/types';
import { normalizeImageSource, toDataUrl } from '../../../plugins/media/source-image';
import type {
  AudioGenRequest,
  ImageEditRequest,
  ImageGenRequest,
  MediaCapabilities,
  MediaProviderAdapter,
  RawMediaResult,
} from '../../../plugins/media/types';
import { base64ToBytes } from '../../../util/base64';
import { emptyUsage, type Usage } from '../../types/response';

export interface OpenRouterMediaAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class OpenRouterMediaAdapter implements MediaProviderAdapter {
  readonly name = 'openrouter';
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: OpenRouterMediaAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://openrouter.ai';
  }

  capabilities(): MediaCapabilities {
    return {
      imageGeneration: true,
      imageEditing: true,
      audioGeneration: true, // via modalities:['audio']; no TTS models in catalog yet
      videoGeneration: false, // OpenRouter has no video output
      audioStreaming: false,
    };
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
  }

  async generateImage(req: ImageGenRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    return this.chatImage(req.model ?? '', req.prompt, this.imageConfig(req.params), [], fetch);
  }

  async editImage(req: ImageEditRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    const part = {
      type: 'image_url',
      image_url: { url: toDataUrl(normalizeImageSource(req.sourceImage)) },
    };
    return this.chatImage(req.model ?? '', req.prompt, this.imageConfig(req.params), [part], fetch);
  }

  async generateAudio(req: AudioGenRequest, fetch: EngineFetch): Promise<RawMediaResult> {
    const model = req.model ?? '';
    const body: Record<string, unknown> = {
      model,
      modalities: ['audio', 'text'],
      audio: { voice: req.params?.voice ?? 'alloy', format: req.params?.format ?? 'mp3' },
      messages: [{ role: 'user', content: req.input }],
    };
    const data = await this.chat(body, model, fetch);
    const audio = (data.choices as Array<{ message?: { audio?: { data?: string; format?: string } } }>)?.[0]
      ?.message?.audio;
    if (!audio?.data) throw new Error('OpenRouter: no audio in response');
    return {
      data: base64ToBytes(audio.data),
      mimeType: `audio/${audio.format ?? 'mp3'}`,
      usage: mapOpenRouterUsage(data.usage as Record<string, unknown> | undefined),
      providerMeta: data.usage ? { usage: data.usage } : undefined,
    };
  }

  /** image_config from normalized params (aspect_ratio / image_size / strength). */
  private imageConfig(params: ImageGenRequest['params']): Record<string, unknown> {
    const cfg: Record<string, unknown> = {};
    if (params?.aspectRatio) cfg.aspect_ratio = params.aspectRatio;
    if (params?.imageSize) cfg.image_size = params.imageSize;
    if (params?.strength != null) cfg.strength = params.strength;
    return cfg;
  }

  private async chat(
    body: Record<string, unknown>,
    model: string,
    fetch: EngineFetch,
  ): Promise<Record<string, unknown>> {
    const res = await fetch({
      url: `${this.baseURL}/api/v1/chat/completions`,
      method: 'POST',
      headers: this.authHeaders(),
      body,
      provider: 'openrouter',
      model,
      responseType: 'json',
    });
    return res.body as Record<string, unknown>;
  }

  private async chatImage(
    model: string,
    prompt: string,
    imageConfig: Record<string, unknown>,
    extraParts: Array<Record<string, unknown>>,
    fetch: EngineFetch,
  ): Promise<RawMediaResult[]> {
    const content = [{ type: 'text', text: prompt }, ...extraParts];
    const body: Record<string, unknown> = {
      model,
      modalities: ['image', 'text'],
      messages: [{ role: 'user', content }],
    };
    if (Object.keys(imageConfig).length) body.image_config = imageConfig;

    const data = await this.chat(body, model, fetch);
    const msg = (data.choices as Array<{ message?: { images?: Array<Record<string, unknown>> } }>)?.[0]
      ?.message;
    const images = msg?.images ?? [];
    const usage = mapOpenRouterUsage(data.usage as Record<string, unknown> | undefined);
    const providerMeta = data.usage ? { usage: data.usage } : undefined;

    return images.map((img, i) => {
      const url = ((img.image_url as { url?: string })?.url ?? img.url) as string;
      const b64 = url.includes(',') ? url.slice(url.indexOf(',') + 1) : url;
      const mime = /^data:(.*?);/.exec(url)?.[1] ?? 'image/png';
      return {
        data: base64ToBytes(b64),
        mimeType: mime,
        // Attach usage + provider cost to the first item (billed once).
        usage: i === 0 ? usage : undefined,
        providerMeta: i === 0 ? providerMeta : undefined,
      };
    });
  }
}

/** OpenRouter `usage` → universal Usage (token-priced fallback; cost wins via
 *  providerMeta). */
function mapOpenRouterUsage(u: Record<string, unknown> | undefined): Usage | undefined {
  if (!u) return undefined;
  return {
    ...emptyUsage(),
    inputTokens: Number(u.prompt_tokens ?? 0),
    outputTokens: Number(u.completion_tokens ?? 0),
    totalTokens: Number(u.total_tokens ?? 0),
  };
}
