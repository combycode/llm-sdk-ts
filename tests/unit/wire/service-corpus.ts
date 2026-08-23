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
  { provider: 'google', op: 'submit' },
  { provider: 'google', op: 'getStatus' },
  { provider: 'google', op: 'cancel' },
  { provider: 'xai', op: 'submit' },
  { provider: 'xai', op: 'getStatus' },
  { provider: 'xai', op: 'getResults' },
  { provider: 'xai', op: 'cancel' },
];
