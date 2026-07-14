/** Media subsystem types — storage, generation requests, results,
 *  and provider adapter contract. */

import type { DataSource } from '../../llm/types/messages';
import type { Usage } from '../../llm/types/response';

export type MediaType = 'image' | 'audio' | 'video';

export interface MediaMeta {
  id: string;
  type: MediaType;
  mimeType: string;
  size: number;
  createdAt: number;
  provider: string;
  model?: string;
  prompt?: string;
  revisedPrompt?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  sampleRate?: number;
  params?: Record<string, unknown>;
  /** Provider-hosted URL (async video). Present when the bytes live remotely —
   *  the browser renders from this since a cross-origin byte-fetch is CORS-blocked. */
  sourceUrl?: string;
}

export interface MediaStore {
  save(id: string, data: Uint8Array, meta: MediaMeta): Promise<void>;
  load(id: string): Promise<{ data: Uint8Array; meta: MediaMeta } | null>;
  getMeta(id: string): Promise<MediaMeta | null>;
  delete(id: string): Promise<void>;
  list(filter?: { type?: MediaType; provider?: string }): Promise<string[]>;
  has(id: string): Promise<boolean>;
}

// ─── Generation requests ────────────────────────────────────────────────

export interface ImageGenRequest {
  provider: string;
  model?: string;
  prompt: string;
  params?: {
    n?: number;
    size?: string;
    aspectRatio?: string;
    /** Google `sampleImageSize` / Gemini `imageSize` (e.g. "1K", "2K"). */
    imageSize?: string;
    resolution?: string;
    quality?: string;
    /** OpenAI gpt-image `background` (transparent|opaque|auto). */
    background?: string;
    /** OpenAI gpt-image `output_format` (png|jpeg|webp). */
    outputFormat?: string;
    style?: string;
    /** OpenRouter image-to-image strength (0–1; lower = closer to the input). */
    strength?: number;
    responseFormat?: 'b64_json' | 'url';
  };
}

export interface ImageEditRequest extends ImageGenRequest {
  sourceImage: DataSource;
  mask?: DataSource;
}

export interface AudioGenRequest {
  provider: string;
  model?: string;
  input: string;
  params?: {
    voice?: string;
    format?: string;
    speed?: number;
    instructions?: string;
    sampleRate?: number;
    language?: string;
  };
}

export interface VideoGenRequest {
  provider: string;
  model?: string;
  prompt: string;
  /** First-frame image → image-to-video. */
  sourceImage?: DataSource;
  /** Input video → extend or edit an existing clip (see `params.videoMode`).
   *  The adapter routes to the provider's extension/edit endpoint instead of
   *  plain generation. */
  sourceVideo?: DataSource;
  params?: {
    duration?: number;
    aspectRatio?: string;
    resolution?: string;
    /** OpenAI Sora literal pixel `size` (e.g. "720x1280"). */
    size?: string;
    /** When `sourceVideo` is set, which operation to run. `extend` (default)
     *  continues the clip from its last frame; `edit` modifies it in place per
     *  the prompt. Ignored without `sourceVideo`. */
    videoMode?: 'extend' | 'edit';
  };
}

// ─── Generation results ─────────────────────────────────────────────────

export interface MediaResult {
  id: string;
  type: MediaType;
  mimeType: string;
  meta: MediaMeta;
}

export interface RawMediaResult {
  data: Uint8Array;
  mimeType: string;
  /** Provider-hosted URL for the asset, when it exists (async video). In the
   *  browser, cross-origin buckets (e.g. xAI vidgen) block a programmatic
   *  byte-fetch via CORS, so `data` may be empty and this URL is the only way
   *  to render (`<video src>` plays cross-origin without CORS) or to re-submit
   *  as a `sourceVideo`. */
  sourceUrl?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  sampleRate?: number;
  revisedPrompt?: string;
  /** Token usage the provider reported (token-priced media: gpt-image,
   *  gemini-tts). Drives accurate cost via the catalog's per-token rates. */
  usage?: Usage;
  providerMeta?: Record<string, unknown>;
}

export interface VideoStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  error?: string;
}

// ─── Provider adapter ───────────────────────────────────────────────────

import type { EngineFetch } from '../../network/types';

export interface MediaCapabilities {
  imageGeneration: boolean;
  imageEditing: boolean;
  audioGeneration: boolean;
  videoGeneration: boolean;
  audioStreaming: boolean;
  /** Provider can extend/edit an existing video (`sourceVideo` on the request).
   *  Undefined/false → passing `sourceVideo` throws. */
  videoExtension?: boolean;
}

/** All MediaProviderAdapter HTTP calls now go through the NetworkEngine
 *  queue (rate limits, retries, hooks, observability) instead of holding a
 *  private `fetchFn`. The adapter receives an EngineFetch per call from
 *  MediaOutput, which in turn was given engine.fetch by the caller.
 *
 *  Adapter responsibilities:
 *    - Build the right URL / headers / body for a provider operation.
 *    - Choose the correct response shape via HttpRequest.responseType
 *      ('json' for image-gen / video-status, 'arraybuffer' for binary
 *      audio / video downloads).
 *    - Parse the response body returned by EngineFetch into RawMediaResult. */
export interface MediaProviderAdapter {
  readonly name: string;
  capabilities(): MediaCapabilities;

  generateImage(req: ImageGenRequest, fetch: EngineFetch): Promise<RawMediaResult[]>;
  editImage?(req: ImageEditRequest, fetch: EngineFetch): Promise<RawMediaResult[]>;
  generateAudio(req: AudioGenRequest, fetch: EngineFetch): Promise<RawMediaResult>;

  submitVideo?(req: VideoGenRequest, fetch: EngineFetch): Promise<string>;
  getVideoStatus?(operationId: string, fetch: EngineFetch): Promise<VideoStatus>;
  downloadVideo?(operationId: string, fetch: EngineFetch): Promise<RawMediaResult>;
  cancelVideo?(operationId: string, fetch: EngineFetch): Promise<void>;
}

// ─── MediaOutput config ─────────────────────────────────────────────────

export interface MediaOutputConfig {
  pollIntervalMs?: number;
  maxPollWaitMs?: number;
}

export const MEDIA_OUTPUT_DEFAULTS: Required<MediaOutputConfig> = {
  pollIntervalMs: 5_000,
  maxPollWaitMs: 600_000,
};
