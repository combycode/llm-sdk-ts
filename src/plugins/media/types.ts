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

/** Which voice speaks. A unified alias (`'warm'`), a provider voice name
 *  (`'Kore'`), or a voice you own.
 *
 *  The object form exists for custom voices, whose ids are not names you can
 *  guess -- Google's are `voice_…`, created through its voices API. Widening
 *  rather than replacing: a string means exactly what it always meant, so no
 *  existing call changes. */
export type VoiceRef = string | { id: string };

/** One stretch of speech attributed to a speaker, for multi-speaker TTS.
 *
 *  Both halves are required together and the provider says so: measured
 *  2026-09-30, a request carrying `multiSpeakerVoiceConfig` without a speaker
 *  on every part is refused -- *"Multi-speaker generation requests must specify
 *  speech_metadata.speaker for each text part"*. So a caller gives segments and
 *  the adapter derives both sides from them. */
export interface SpeechSegment {
  /** Who says this. Must match a name in `params.speakers`. */
  speaker: string;
  /** What they say. */
  text: string;
  /** How to say it, in words -- `'excited, fast-paced'`. Per segment, so one
   *  line can be hesitant and the next certain. */
  style?: string;
}

export interface AudioGenRequest {
  provider: string;
  model?: string;
  /** The text to speak. Ignored when `params.segments` is set, which carries
   *  its own text per speaker. */
  input: string;
  params?: {
    /** The single voice for the whole output. */
    voice?: VoiceRef;
    /** Who is in the conversation, for multi-speaker TTS. Each `name` is what a
     *  segment refers to. Google only, and the model must support it. */
    speakers?: Array<{ name: string; voice: VoiceRef }>;
    /** The script, when more than one voice speaks. Supersedes `input`. */
    segments?: SpeechSegment[];
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
    /** Whether the generated video carries an audio track. Both xAI and Veo
     *  generate audio by DEFAULT, so this is really "give me a silent video".
     *
     *  Honoured on xAI (`generate_audio`), on both `grok-imagine-video` and
     *  `grok-imagine-video-1.5` -- measured 2026-09-30, where a wrongly typed
     *  value is refused `422 invalid type: string, expected a boolean`, which
     *  is how we know the field is read rather than ignored.
     *
     *  Not sent on Google: the parameter exists on Veo, but only on Vertex /
     *  Gemini Enterprise, and the Developer API this library speaks refuses it
     *  -- google-genai throws client-side rather than send it there. Not sent
     *  on OpenAI Sora, which has no such parameter. On those providers the
     *  video comes back as the provider defaults it, audio and all. */
    generateAudio?: boolean;
    /** Voices to condition the generated audio on, as xAI voice-catalog preset
     *  ids (`[{ voiceId: 'ara' }]`). At most three.
     *
     *  **xAI `grok-imagine-video-1.5` only.** Measured 2026-09-30: the older
     *  `grok-imagine-video` refuses the field outright with a 400 saying it is
     *  not supported for that model. An unknown voice id is refused with the
     *  whole catalog listed in the error, so no client-side voice list is kept
     *  here -- it would be a second copy of something the server already tells
     *  you, and custom ids from `/v1/custom-voices` are accepted too.
     *
     *  Kept in `params` rather than a provider escape hatch for the same reason
     *  `size` is: `params` is where a generation knob lives, and the providers
     *  that do not understand one ignore it. */
    referenceAudios?: Array<{ voiceId: string }>;
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
