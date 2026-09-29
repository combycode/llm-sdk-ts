/** Google media adapter — Imagen (:predict) + Veo (:predictLongRunning).
 *  All HTTP calls go through an injected EngineFetch (NetworkEngine queue). */

import { buildFromSpec } from '../../../wire/interpreter';
import type { Registry } from '../../../wire/interpreter';
import { mediaSpec } from '../../../wire/media-specs';
import { makeRegistry } from '../../wire-transforms';
import type { EngineFetch, HttpRequest } from '../../../network/types';
import { base64ToBytes } from '../../../util/base64';
import { ensurePlayableAudio } from '../../../util/wav';
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

/** The default Google image model.
 *
 *  Was `imagen-4.0-generate-001` until 2026-09-29, when a live check found its
 *  `:predict` endpoint answering 404 on the Developer API -- so the DEFAULT image
 *  path was broken. `gemini-3.1-flash-image` is the model Google's own docs call
 *  the go-to image generator, and it was verified generating an image through
 *  `generateContent` in the same check. */
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image';

/** Imagen `:predict` is gone from the Developer API, and that is NOT yet acted on
 *  beyond the default above.
 *
 *  Measured 2026-09-29: `models/imagen-4.0-generate-001:predict` answers 404,
 *  "is not found for API version v1beta, or is not supported for predict", and
 *  both Google SDKs deleted their Developer-API converters -- `generate_images`
 *  raises "only supported in Gemini Enterprise Agent Platform mode".
 *
 *  Routing `imagen*` to a typed refusal was tried and REVERTED: it breaks the
 *  frozen media corpus and the spec/adapter parity check, both of which record
 *  the `:predict` envelope as this adapter's contract. Re-freezing a corpus is a
 *  deliberate act, and an Enterprise deployment can still reach that endpoint --
 *  so who decides, and on what evidence, is the open question. Until then a
 *  caller who NAMES an imagen model gets Google's own 404, and a caller who
 *  names nothing gets a model that works. */

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

  /** Named code the specs cannot express as data — image-source normalisation. */
  private readonly wireRegistry: Registry = makeRegistry({ google: this });

  /** Build one media request from its spec, then add the engine metadata.
   *
   *  `provider`, `model` and `responseType` are engine concerns, not wire: nothing
   *  a provider sees, so the specs do not model them. Every Google media response
   *  is JSON, including Veo's operation handle and the base64 inline data. */
  /** Build one media request from its spec, then add the engine metadata.
   *
   *  `bodyKind: none` arrives as `noBody`; the engine wants the field absent. */
  private fromSpec(
    specId: string,
    req: object,
    model: string,
    responseType: 'json' | 'arraybuffer' = 'json',
  ): HttpRequest {
    const built = buildFromSpec(
      mediaSpec(specId),
      { ...req, model } as never,
      this.wireRegistry,
      'google',
      undefined,
      { baseURL: this.baseURL, apiKey: this.apiKey },
    ) as unknown as Record<string, unknown>;
    const { noBody, body, ...rest } = built;
    return {
      ...rest,
      ...(noBody ? {} : { body }),
      provider: 'google',
      model,
      responseType,
    } as HttpRequest;
  }

  // ─── request builders ────────────────────────────────────────────────
  //
  // Split out from the methods that fetch and parse, so a request can be built,
  // inspected and asserted without performing it. Everything above this line
  // used to construct its request inline, which meant the only way to see what
  // the adapter would send was to intercept the network.

  /** Veo returns a long-running operation; these poll and cancel it. */
  buildOperationStatusRequest(operationId: string): HttpRequest {
    // Routed under `operations`, the queue LRO polling has always used.
    return this.fromSpec('google/media.operation.status', { operationId }, 'operations');
  }
  buildOperationCancelRequest(operationId: string): HttpRequest {
    return this.fromSpec('google/media.operation.cancel', { operationId }, 'operations');
  }
  /** Google appends the key to the download URI too, which is why fetching the
   *  generated bytes is a spec rather than a bare GET. */
  buildDownloadRequest(downloadUrl: string): HttpRequest {
    return this.fromSpec('google/media.download', { downloadUrl }, 'operations', 'arraybuffer');
  }

  /** Imagen image generation: the Vertex-style `:predict` envelope.
   *  Kept so an Enterprise deployment can still build the request; the
   *  Developer-API paths refuse it. */
  buildImagenRequest(req: ImageGenRequest, model = req.model ?? 'imagen-4.0-generate-001'): HttpRequest {
    return this.fromSpec('google/imagen@predict', req, model);
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
  /** Veo video submission — a long-running operation, hence the endpoint. */
  buildVideoRequest(req: VideoGenRequest, model = req.model ?? 'veo-3.1-generate-preview'): HttpRequest {
    return this.fromSpec('google/veo@predictLongRunning', req, model);
  }

  /** The complete image request, whichever of the two Google image paths applies:
   *  Imagen models use `:predict`, gemini-* models generate inline via
   *  `:generateContent` steered by responseModalities. */
  /** The complete image request, whichever of the two Google image paths applies.
   *
   *  Imagen models use `:predict`; gemini-* models generate inline via
   *  `:generateContent` steered by responseModalities. Different endpoint, body and
   *  response — the fork is a genuine wire difference, not a preference. */
  buildImageRequest(req: ImageGenRequest, model = req.model ?? DEFAULT_IMAGE_MODEL): HttpRequest {
    return this.fromSpec(
      model.startsWith('imagen') ? 'google/imagen@predict' : 'google/gemini-image@generateContent',
      req,
      model,
    );
  }

  /** Gemini TTS: the same inline path with an AUDIO modality and a speechConfig. */
  /** Gemini TTS: the inline path with an AUDIO modality and a speechConfig. */
  buildAudioRequest(
    req: AudioGenRequest,
    model = req.model ?? 'gemini-2.5-flash-preview-tts',
  ): HttpRequest {
    return this.fromSpec('google/gemini-tts@generateContent', req, model);
  }

  /** Image-to-image edit: image generation plus the source image as a second part. */
  /** Image-to-image edit: image generation plus the source image as a second part. */
  buildEditImageRequest(
    req: ImageEditRequest,
    model = req.model ?? 'gemini-2.5-flash-image',
  ): HttpRequest {
    return this.fromSpec('google/gemini-image-edit@generateContent', req, model);
  }

  async generateImage(req: ImageGenRequest, fetch: EngineFetch): Promise<RawMediaResult[]> {
    const model = req.model ?? DEFAULT_IMAGE_MODEL;

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
    const res = await fetch(this.buildOperationStatusRequest(operationId));
    if (res.status >= 400) return { status: 'failed', error: `HTTP ${res.status}` };

    const data = res.body as Record<string, unknown>;
    if (data.done) return { status: 'completed' };
    if (data.error) return { status: 'failed', error: JSON.stringify(data.error) };
    return { status: 'processing' };
  }

  async downloadVideo(operationId: string, fetch: EngineFetch): Promise<RawMediaResult> {
    const statusRes = await fetch(this.buildOperationStatusRequest(operationId));
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
      // Routed under `operations` so LRO downloads share that queue.
      const videoRes = await fetch({
        ...this.buildDownloadRequest(url),
        model: 'operations',
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
    await fetch(this.buildOperationCancelRequest(operationId));
  }
}
