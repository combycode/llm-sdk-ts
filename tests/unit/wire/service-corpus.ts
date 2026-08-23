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
