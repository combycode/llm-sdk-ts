/** The corpus for the remaining families: embeddings, realtime, xai/openrouter
 *  media, batch and files.
 *
 *  Each has its own entry point and its own request type, so neither the chat nor
 *  the media corpus can reach them. Kept as plain data here so the freeze script
 *  and the differential cannot disagree about what a case is.
 */

import type { DataSource } from '../../../src/llm/types/messages';
import type { EmbedRequest } from '../../../src/plugins/embeddings/types';
import type { ImageEditRequest, ImageGenRequest, AudioGenRequest, VideoGenRequest } from '../../../src/plugins/media/types';

export const PNG: DataSource = { type: 'base64', mimeType: 'image/png', data: 'aGk=' };
export const MP4: DataSource = { type: 'base64', mimeType: 'video/mp4', data: 'AAAAGGZ0' };

// ── embeddings ───────────────────────────────────────────────────────────────
export interface EmbedCase {
  name: string;
  provider: 'openai' | 'openrouter' | 'google';
  req: EmbedRequest;
}

export const EMBED_CASES: EmbedCase[] = [
  // A single string must still reach the wire as an array.
  { name: 'single', provider: 'openai', req: { model: 'text-embedding-3-small', input: 'hello' } },
  { name: 'batch', provider: 'openai', req: { model: 'text-embedding-3-small', input: ['a', 'b', 'c'] } },
  { name: 'single', provider: 'openrouter', req: { model: 'openai/text-embedding-3-small', input: 'hello' } },
  { name: 'batch', provider: 'openrouter', req: { model: 'openai/text-embedding-3-small', input: ['a', 'b'] } },
  // Google embeds one text per call and wants a `models/` prefix it may or may
  // not already have — both forms have to land on the same URL.
  { name: 'bare', provider: 'google', req: { model: 'gemini-embedding-001', input: 'hello' } },
  { name: 'prefixed', provider: 'google', req: { model: 'models/gemini-embedding-001', input: 'hello' } },
];

// ── xai media ────────────────────────────────────────────────────────────────
export interface XaiMediaCase {
  name: string;
  kind: 'image' | 'imageEdit' | 'audio' | 'video' | 'videoEdit' | 'videoExtend';
  model: string;
  req: ImageGenRequest | ImageEditRequest | AudioGenRequest | VideoGenRequest;
}

export const XAI_MEDIA_CASES: XaiMediaCase[] = [
  { name: 'image.minimal', kind: 'image', model: 'grok-2-image', req: { provider: 'xai', prompt: 'a cat' } },
  {
    name: 'image.params',
    kind: 'image',
    model: 'grok-2-image',
    req: { provider: 'xai', prompt: 'a cat', params: { n: 2, responseFormat: 'b64_json' } },
  },
  {
    name: 'imageEdit',
    kind: 'imageEdit',
    model: 'grok-2-image',
    req: { provider: 'xai', prompt: 'add a hat', sourceImage: PNG } as ImageEditRequest,
  },
  {
    name: 'audio',
    kind: 'audio',
    model: 'grok-tts',
    req: { provider: 'xai', input: 'hello', params: { voice: 'alloy', format: 'wav' } } as AudioGenRequest,
  },
  { name: 'video', kind: 'video', model: 'grok-video', req: { provider: 'xai', prompt: 'a wave' } as VideoGenRequest },
  {
    name: 'video.fromImage',
    kind: 'video',
    model: 'grok-video',
    req: { provider: 'xai', prompt: 'animate', sourceImage: PNG } as VideoGenRequest,
  },
  // sourceVideo routes to a different endpoint entirely, chosen by videoMode.
  {
    name: 'video.extend',
    kind: 'videoExtend',
    model: 'grok-video',
    req: { provider: 'xai', prompt: 'keep going', sourceVideo: MP4, params: { videoMode: 'extend' } } as VideoGenRequest,
  },
  {
    name: 'video.edit',
    kind: 'videoEdit',
    model: 'grok-video',
    req: { provider: 'xai', prompt: 'make it night', sourceVideo: MP4, params: { videoMode: 'edit' } } as VideoGenRequest,
  },
];

// ── openrouter media ─────────────────────────────────────────────────────────
export interface OrMediaCase {
  name: string;
  kind: 'image' | 'imageEdit' | 'audio';
  model: string;
  req: ImageGenRequest | ImageEditRequest | AudioGenRequest;
}

export const OPENROUTER_MEDIA_CASES: OrMediaCase[] = [
  { name: 'image.minimal', kind: 'image', model: 'google/gemini-2.5-flash-image', req: { provider: 'openrouter', prompt: 'a cat' } },
  {
    name: 'image.config',
    kind: 'image',
    model: 'google/gemini-2.5-flash-image',
    req: { provider: 'openrouter', prompt: 'a cat', params: { n: 2, aspectRatio: '16:9' } },
  },
  {
    name: 'imageEdit',
    kind: 'imageEdit',
    model: 'google/gemini-2.5-flash-image',
    req: { provider: 'openrouter', prompt: 'add a hat', sourceImage: PNG } as ImageEditRequest,
  },
  {
    name: 'audio',
    kind: 'audio',
    model: 'google/gemini-2.5-flash-preview-tts',
    req: { provider: 'openrouter', input: 'hello', params: { voice: 'Kore' } } as AudioGenRequest,
  },
];

// ── realtime ─────────────────────────────────────────────────────────────────
//
// A session's outbound side is three artifacts, not one request: the connection
// descriptor, the handshake frame, and the per-turn frames. All three are built
// without a socket, which is why they can be frozen at all.
export interface RealtimeCase {
  name: string;
  provider: 'openai' | 'google';
  config: { model: string; modalities?: Array<'text' | 'audio'>; voice?: string; instructions?: string };
  turns: Array<{ name: string; input: { text?: string; audio?: Uint8Array }; turnComplete?: boolean }>;
}

const PCM = new Uint8Array([0, 1, 2, 3]);

export const REALTIME_CASES: RealtimeCase[] = [
  {
    name: 'text',
    provider: 'openai',
    config: { model: 'gpt-realtime' },
    turns: [
      { name: 'text', input: { text: 'hello' } },
      // turnComplete:false withholds response.create and leaves the turn open —
      // where Gemini expresses the same thing as a field on its single frame.
      { name: 'text.open', input: { text: 'hello' }, turnComplete: false },
    ],
  },
  {
    name: 'audio',
    provider: 'openai',
    config: { model: 'gpt-realtime', modalities: ['text', 'audio'], voice: 'alloy', instructions: 'be brief' },
    turns: [
      { name: 'audio', input: { audio: PCM } },
      { name: 'both', input: { text: 'and this', audio: PCM } },
    ],
  },
  {
    name: 'text',
    provider: 'google',
    config: { model: 'gemini-3.1-flash-live-preview' },
    turns: [
      { name: 'text', input: { text: 'hello' } },
      { name: 'text.open', input: { text: 'hello' }, turnComplete: false },
    ],
  },
  {
    name: 'audio',
    provider: 'google',
    config: {
      model: 'models/gemini-3.1-flash-live-preview',
      modalities: ['audio'],
      voice: 'Kore',
      instructions: 'be brief',
    },
    turns: [{ name: 'audio', input: { audio: PCM } }],
  },
];

// ── batch ────────────────────────────────────────────────────────────────────
//
// Every provider does batching differently: Anthropic posts the requests inline,
// OpenAI uploads a JSONL file first and references it, xAI creates an empty batch
// then adds requests to it, and Google submits inline under a model-scoped URL.
// Four shapes, one interface.
export interface BatchCase {
  provider: 'anthropic' | 'openai' | 'google' | 'xai';
  op: 'submit' | 'getStatus' | 'getResults' | 'cancel';
}

export const BATCH_REQUESTS = [
  { customId: 'r1', body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] } },
  { customId: 'r2', body: { model: 'm', messages: [{ role: 'user', content: 'yo' }] } },
];

export const BATCH_ID = 'batch_abc';

export const BATCH_CASES: BatchCase[] = [
  { provider: 'anthropic', op: 'submit' },
  { provider: 'anthropic', op: 'getStatus' },
  { provider: 'anthropic', op: 'getResults' },
  { provider: 'anthropic', op: 'cancel' },
  { provider: 'openai', op: 'submit' },
  { provider: 'openai', op: 'getStatus' },
  // getResults is TWO calls on OpenAI: read the batch for its output_file_id,
  // then fetch that file. Both are captured, in order.
  { provider: 'openai', op: 'getResults' },
  { provider: 'openai', op: 'cancel' },
  { provider: 'google', op: 'submit' },
  { provider: 'google', op: 'getStatus' },
  { provider: 'google', op: 'getResults' },
  { provider: 'google', op: 'cancel' },
  { provider: 'xai', op: 'submit' },
  { provider: 'xai', op: 'getStatus' },
  { provider: 'xai', op: 'getResults' },
  { provider: 'xai', op: 'cancel' },
];

// ── files ────────────────────────────────────────────────────────────────────
//
// Four providers, four upload shapes: OpenAI and Anthropic post multipart, xAI
// borrows OpenAI's, and Google runs a two-step resumable upload where the first
// call carries only headers. `remoteId` is deliberately given in the awkward form
// each provider actually hands back.
export interface FileCase {
  provider: 'anthropic' | 'openai' | 'google' | 'xai';
  op: 'upload' | 'delete' | 'getInfo' | 'list';
}

export const FILE_CASES: FileCase[] = [
  { provider: 'anthropic', op: 'upload' },
  { provider: 'anthropic', op: 'delete' },
  { provider: 'anthropic', op: 'getInfo' },
  { provider: 'anthropic', op: 'list' },
  { provider: 'openai', op: 'upload' },
  { provider: 'openai', op: 'delete' },
  { provider: 'openai', op: 'getInfo' },
  { provider: 'openai', op: 'list' },
  { provider: 'google', op: 'upload' },
  { provider: 'google', op: 'delete' },
  { provider: 'google', op: 'getInfo' },
  { provider: 'google', op: 'list' },
  { provider: 'xai', op: 'upload' },
];

/** The id each provider hands back, in its own format. Google's is a full uri,
 *  which `googleFileName` has to reduce to a bare name. */
export const FILE_REMOTE_ID: Record<string, string> = {
  anthropic: 'file_abc',
  openai: 'file-abc',
  google: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
  xai: 'file_abc',
};

// ── media lifecycle, moderation, transcription ───────────────────────────────
//
// The generation call is only half of a media job: the rest is polling the
// operation, downloading the bytes, and cancelling. Those were the last requests
// in the library with no spec, on the reasoning that a server-supplied URL cannot
// be described — which was wrong. A URL that arrives at runtime is an INPUT, the
// same as a batch id.
export interface LifecycleCase {
  provider: 'openai' | 'google' | 'xai';
  op: 'videoStatus' | 'videoDownload' | 'videoCancel';
}

export const LIFECYCLE_CASES: LifecycleCase[] = [
  { provider: 'openai', op: 'videoStatus' },
  { provider: 'openai', op: 'videoDownload' },
  { provider: 'google', op: 'videoStatus' },
  { provider: 'google', op: 'videoDownload' },
  { provider: 'google', op: 'videoCancel' },
  { provider: 'xai', op: 'videoStatus' },
  { provider: 'xai', op: 'videoDownload' },
  { provider: 'xai', op: 'videoCancel' },
];

export const OPERATION_ID: Record<string, string> = {
  openai: 'video_123',
  google: 'models/veo-3.1/operations/op_1',
  xai: 'req_1',
};

/** Moderation takes a string, an array, or content parts — all three reach the
 *  wire untouched, so all three are frozen. */
export const MODERATION_CASES: Array<{ name: string; input: unknown }> = [
  { name: 'string', input: 'hello' },
  { name: 'array', input: ['a', 'b'] },
  { name: 'parts', input: [{ type: 'text', text: 'hi' }] },
];

/** Transcription's multipart is the richest in the library: repeated keys and two
 *  mutually exclusive response formats. */
export const TRANSCRIPTION_CASES: Array<{ name: string; req: Record<string, unknown> }> = [
  {
    name: 'minimal',
    req: { model: 'gpt-transcribe', bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
  },
  {
    name: 'language',
    req: {
      model: 'gpt-transcribe',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav',
      language: 'en',
    },
  },
  {
    name: 'lists',
    req: {
      model: 'gpt-transcribe',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/mpeg',
      languages: ['en', 'fr'],
      keywords: ['orxa', 'combycode'],
    },
  },
  {
    name: 'wordTimestamps',
    req: {
      model: 'gpt-transcribe',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav',
      wordTimestamps: true,
    },
  },
  {
    name: 'diarization',
    req: {
      model: 'gpt-transcribe',
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/wav',
      diarization: true,
    },
  },
];
