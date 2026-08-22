/** Google media adapter — Imagen (:predict) + Veo (:predictLongRunning).
 *  All HTTP calls go through an injected EngineFetch (NetworkEngine queue). */

import type { EngineFetch, HttpRequest } from '../../../network/types';
import { base64ToBytes } from '../../../util/base64';
import {
  googleImagePart,
  googleVeoImage,
  normalizeImageSource,
} from '../../../util/source-image';
import { ensurePlayableAudio } from '../../../util/wav';
import { resolveVoice } from '../../audio/voices';
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

export interface GoogleMediaAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** Map Gemini `usageMetadata` to the universal Usage (token-priced media). */
function mapGeminiUsage(
  u: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined,
): Usage | undefined {
  if (!u) return undefined;
  return {
    ...emptyUsage(),
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    totalTokens: u.totalTokenCount ?? 0,
  };
}

export class GoogleMediaAdapter implements MediaProviderAdapter {
  readonly name = 'google';
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: GoogleMediaAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://generativelanguage.googleapis.com';
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

  // ─── request builders ────────────────────────────────────────────────
  //
  // Split out from the methods that fetch and parse, so a request can be built,
  // inspected and asserted without performing it. Everything above this line
  // used to construct its request inline, which meant the only way to see what
  // the adapter would send was to intercept the network.

  /** Imagen image generation: the Vertex-style `:predict` envelope. */
  buildImagenRequest(req: ImageGenRequest, model = req.model ?? 'imagen-4.0-generate-001'): HttpRequest {
    const parameters: Record<string, unknown> = { sampleCount: req.params?.n ?? 1 };
    if (req.params?.aspectRatio) parameters.aspectRatio = req.params.aspectRatio;
    if (req.params?.imageSize) parameters.sampleImageSize = req.params.imageSize;
    return {
      url: `${this.baseURL}/v1beta/models/${model}:predict?key=${this.apiKey}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { instances: [{ prompt: req.prompt }], parameters },
      provider: 'google',
      model,
      responseType: 'json',
    };
  }

  /** The inline-media path shared by gemini image generation, editing and TTS. */
  buildGenerateContentRequest(
    model: string,
    text: string,
    generationConfig: Record<string, unknown>,
    extraParts: Array<Record<string, unknown>> = [],
  ): HttpRequest {
    return {
      url: `${this.baseURL}/v1beta/models/${model}:generateContent?key=${this.apiKey}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { contents: [{ parts: [{ text }, ...extraParts] }], generationConfig },
      provider: 'google',
      model,
      responseType: 'json',
    };
  }

  /** Veo video submission — a long-running operation, hence the endpoint. */
  buildVideoRequest(req: VideoGenRequest, model = req.model ?? 'veo-3.1-generate-preview'): HttpRequest {
    const instance: Record<string, unknown> = { prompt: req.prompt };
    // First-frame image → image-to-video.
    if (req.sourceImage) instance.image = googleVeoImage(normalizeImageSource(req.sourceImage));
    const parameters: Record<string, unknown> = {};
    if (req.params?.duration) parameters.durationSeconds = req.params.duration;
    if (req.params?.aspectRatio) parameters.aspectRatio = req.params.aspectRatio;
    if (req.params?.resolution) parameters.resolution = req.params.resolution;
    return {
      url: `${this.baseURL}/v1beta/models/${model}:predictLongRunning?key=${this.apiKey}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { instances: [instance], parameters },
      provider: 'google',
      model,
      responseType: 'json',
    };
  }

  /** `generationConfig` for the gemini image paths — generation and editing take
   *  the same one. */
  private imageGenerationConfig(params: ImageGenRequest['params']): Record<string, unknown> {
    const generationConfig: Record<string, unknown> = { responseModalities: ['IMAGE'] };
    const image: Record<string, unknown> = {};
    if (params?.aspectRatio) image.aspectRatio = params.aspectRatio;
    if (params?.imageSize) image.imageSize = params.imageSize;
    if (Object.keys(image).length) generationConfig.imageConfig = image;
    return generationConfig;
  }

  /** The complete image request, whichever of the two Google image paths applies:
   *  Imagen models use `:predict`, gemini-* models generate inline via
   *  `:generateContent` steered by responseModalities. */
  buildImageRequest(req: ImageGenRequest, model = req.model ?? 'imagen-4.0-generate-001'): HttpRequest {
    return model.startsWith('imagen')
      ? this.buildImagenRequest(req, model)
      : this.buildGenerateContentRequest(model, req.prompt, this.imageGenerationConfig(req.params));
  }

  /** Gemini TTS: the same inline path with an AUDIO modality and a speechConfig. */
  buildAudioRequest(
    req: AudioGenRequest,
    model = req.model ?? 'gemini-2.5-flash-preview-tts',
  ): HttpRequest {
    const voiceName = resolveVoice('google', req.params?.voice) ?? 'Kore';
    return this.buildGenerateContentRequest(model, req.input, {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    });
  }

  /** Image-to-image edit: image generation plus the source image as a second part. */
  buildEditImageRequest(
    req: ImageEditRequest,
    model = req.model ?? 'gemini-2.5-flash-image',
  ): HttpRequest {
    return this.buildGenerateContentRequest(
      model,
      req.prompt,
      this.imageGenerationConfig(req.params),
      [googleImagePart(normalizeImageSource(req.sourceImage))],
    );
  }

  async generateImage(req: ImageGenRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    const model = req.model ?? 'imagen-4.0-generate-001';

    // Two distinct Google image paths: Imagen models use the `:predict` endpoint;
    // gemini-* image models generate inline via `generateContent` + responseModalities.
    if (!model.startsWith('imagen')) {
      const { items, usage } = await this.parseGenerateContent(
        await fetch(this.buildImageRequest(req, model)),
      );
      return items.map((m, i) => ({
        data: base64ToBytes(m.data),
        mimeType: m.mimeType ?? 'image/png',
        usage: i === 0 ? usage : undefined,
      }));
    }

    const res = await fetch(this.buildImagenRequest(req, model));
    const data = res.body as Record<string, unknown>;
    const predictions = (data.predictions as Array<Record<string, unknown>>) ?? [];

    return predictions.map((pred) => {
      const b64 = (pred.bytesBase64Encoded as string) ?? '';
      return {
        data: base64ToBytes(b64),
        mimeType: (pred.mimeType as string) ?? 'image/png',
      };
    });
  }

  async generateAudio(req: AudioGenRequest, fetch: EngineFetch): Promise<RawMediaResult> {
    // Gemini TTS is inline generateContent with responseModalities:['AUDIO'] +
    // speechConfig (no separate media endpoint).
    const media = await this.parseGenerateContent(await fetch(this.buildAudioRequest(req)));
    const first = media.items[0];
    if (!first) throw new Error('Google TTS: no audio returned by generateContent');
    // Gemini TTS returns bare little-endian 16-bit PCM (`audio/l16; rate=...`);
    // wrap it in a WAV container so it's playable everywhere.
    const playable = ensurePlayableAudio(base64ToBytes(first.data), first.mimeType ?? 'audio/wav');
    return { ...playable, usage: media.usage };
  }

  /** Image-to-image edit: gemini generateContent with the source image as an
   *  extra inline/file part next to the instruction. */
  async editImage(req: ImageEditRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    const { items, usage } = await this.parseGenerateContent(
      await fetch(this.buildEditImageRequest(req)),
    );
    return items.map((m, i) => ({
      data: base64ToBytes(m.data),
      mimeType: m.mimeType ?? 'image/png',
      usage: i === 0 ? usage : undefined,
    }));
  }

  /** Collect inlineData parts + reported usage from a `:generateContent`
   *  response. The request half is `buildGenerateContentRequest`; keeping the two
   *  apart is what lets a request be asserted without performing it. */
  private parseGenerateContent(res: {
    body: unknown;
  }): { items: Array<{ mimeType?: string; data: string }>; usage?: Usage } {
    const data = res.body as {
      candidates?: Array<{
        content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    };
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const items = parts
      .filter((p) => p.inlineData?.data)
      .map((p) => ({ mimeType: p.inlineData?.mimeType, data: p.inlineData?.data as string }));
    return { items, usage: mapGeminiUsage(data.usageMetadata) };
  }

  async submitVideo(req: VideoGenRequest, fetch: EngineFetch): Promise<string> {
    const model = req.model ?? 'veo-3.1-generate-preview';
    const res = await fetch(this.buildVideoRequest(req, model));
    const data = res.body as Record<string, unknown>;
    return (data.name as string) ?? '';
  }

  async getVideoStatus(operationId: string, fetch: EngineFetch): Promise<VideoStatus> {
    const res = await fetch({
      url: `${this.baseURL}/v1beta/${operationId}?key=${this.apiKey}`,
      method: 'GET',
      headers: { 'x-goog-api-key': this.apiKey },
      body: undefined,
      provider: 'google',
      model: 'operations', // LRO poll/download/cancel: stable "google/operations" queue, not "google/"
      responseType: 'json',
    });
    if (res.status >= 400) return { status: 'failed', error: `HTTP ${res.status}` };

    const data = res.body as Record<string, unknown>;
    if (data.done) return { status: 'completed' };
    if (data.error) return { status: 'failed', error: JSON.stringify(data.error) };
    return { status: 'processing' };
  }

  async downloadVideo(operationId: string, fetch: EngineFetch): Promise<RawMediaResult> {
    const statusRes = await fetch({
      url: `${this.baseURL}/v1beta/${operationId}?key=${this.apiKey}`,
      method: 'GET',
      headers: { 'x-goog-api-key': this.apiKey },
      body: undefined,
      provider: 'google',
      model: 'operations', // LRO poll/download/cancel: stable "google/operations" queue, not "google/"
      responseType: 'json',
    });
    if (statusRes.status >= 400) {
      throw new Error(`Google Veo download failed: HTTP ${statusRes.status}`);
    }

    const data = statusRes.body as Record<string, unknown>;
    const response = (data.response as Record<string, unknown>) ?? data;
    // Veo nests the samples under `generateVideoResponse`.
    const gvr = response.generateVideoResponse as Record<string, unknown> | undefined;
    const videos =
      (gvr?.generatedSamples as Array<Record<string, unknown>>) ??
      (response.generatedSamples as Array<Record<string, unknown>>) ??
      (response.videos as Array<Record<string, unknown>>) ??
      [];

    if (videos.length === 0) throw new Error('No video in response');
    const video = videos[0];

    const downloadUri =
      ((video.video as Record<string, unknown>)?.uri as string) ??
      (video.uri as string) ??
      (video.downloadUri as string);

    if (downloadUri) {
      // The Google files download URL is authenticated — pass the API key.
      const url = downloadUri.includes('key=')
        ? downloadUri
        : `${downloadUri}${downloadUri.includes('?') ? '&' : '?'}key=${this.apiKey}`;
      const videoRes = await fetch({
        url,
        method: 'GET',
        headers: { 'x-goog-api-key': this.apiKey },
        body: undefined,
        provider: 'google',
        model: 'operations', // video-file download for the LRO: same google/operations queue
        responseType: 'arraybuffer',
      });
      return { data: videoRes.body as Uint8Array, mimeType: 'video/mp4' };
    }

    const b64 = ((video.video as Record<string, unknown>)?.bytesBase64Encoded as string) ?? '';
    return {
      data: base64ToBytes(b64),
      mimeType: 'video/mp4',
    };
  }

  async cancelVideo(operationId: string, fetch: EngineFetch): Promise<void> {
    await fetch({
      url: `${this.baseURL}/v1beta/${operationId}:cancel?key=${this.apiKey}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {},
      provider: 'google',
      model: 'operations', // LRO poll/download/cancel: stable "google/operations" queue, not "google/"
      responseType: 'json',
    });
  }
}
