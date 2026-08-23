/** OpenRouter media adapter. OpenRouter has NO dedicated media endpoints —
 *  image (and audio) generation go through `POST /api/v1/chat/completions` with
 *  a `modalities` field; output comes back on `message.images[]` /
 *  `message.audio`. Cost is the provider-reported `usage.cost`. */

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

  /** Named code the specs cannot express as data — the data-URL and image_config. */
  private readonly wireRegistry: Registry = makeRegistry({ openrouterMedia: this });

  /** Build one request from its spec, then add the engine metadata. */
  private fromSpec(specId: string, req: object, model: string): HttpRequest {
    const built = buildFromSpec(
      serviceSpec(specId),
      { ...req, model } as never,
      this.wireRegistry,
      'openrouter',
      undefined,
      { baseURL: this.baseURL, apiKey: this.apiKey },
    );
    return { ...(built as object), provider: 'openrouter', model, responseType: 'json' } as HttpRequest;
  }

  /** Text-to-image. OpenRouter has no image endpoint: images come back from
   *  chat/completions with `modalities: ['image','text']`. */
  buildImageRequest(req: ImageGenRequest, model = req.model ?? ''): HttpRequest {
    return this.fromSpec('openrouter/media.image', req, model);
  }

  /** Image-to-image: the same call with the source image as a second content part. */
  buildEditImageRequest(req: ImageEditRequest, model = req.model ?? ''): HttpRequest {
    return this.fromSpec('openrouter/media.imageEdit', req, model);
  }

  /** Audio out, again through chat/completions. */
  buildAudioRequest(req: AudioGenRequest, model = req.model ?? ''): HttpRequest {
    return this.fromSpec('openrouter/media.audio', req, model);
  }

  /** Exposed for the wire registry: `image_config` from normalised params. */
  imageConfig(params: ImageGenRequest['params']): Record<string, unknown> {
    const cfg: Record<string, unknown> = {};
    if (params?.aspectRatio) cfg.aspect_ratio = params.aspectRatio;
    if (params?.imageSize) cfg.image_size = params.imageSize;
    if (params?.strength != null) cfg.strength = params.strength;
    return cfg;
  }

  async generateImage(req: ImageGenRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    return this.chatImage(this.buildImageRequest(req), req.model ?? '', fetch);
  }

  async editImage(req: ImageEditRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    return this.chatImage(this.buildEditImageRequest(req), req.model ?? '', fetch);
  }

  async generateAudio(req: AudioGenRequest, fetch: EngineFetch): Promise<RawMediaResult> {
    const model = req.model ?? '';
    const data = await this.chat(this.buildAudioRequest(req, model), fetch);
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

  private async chat(request: HttpRequest, fetch: EngineFetch): Promise<Record<string, unknown>> {
    const res = await fetch(request);
    return res.body as Record<string, unknown>;
  }

  private async chatImage(
    request: HttpRequest,
    _model: string,
    fetch: EngineFetch,
  ): Promise<RawMediaResult[]> {
    const data = await this.chat(request, fetch);
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
