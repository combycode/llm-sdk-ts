/** The media corpus: every request shape the media adapters build, once.
 *
 *  The chat corpus cannot describe these — media requests do not go through
 *  `buildRequest(NormalizedRequest)`. Each family has its own entry point
 *  (`buildImageRequest`, `buildAudioRequest`, `buildVideoRequest`, …) and its own
 *  request type, and several return a full envelope (url + method + multipart)
 *  rather than a body.
 *
 *  This exists for the same reason the chat freeze does, and the reason is not
 *  hypothetical: `openaiAudioFormat` and `resolveVoiceOpenAI` sat behind a guard in
 *  a spec the chat corpus drove 6,380 times without either ever executing, because
 *  no frozen request carried an audio part. Sixteen more transforms are in that
 *  state right now, all of them in these families. A spec that is never executed is
 *  a spec nobody has checked.
 */

import type { DataSource } from '../../../src/llm/types/messages';
import type {
  AudioGenRequest,
  ImageEditRequest,
  ImageGenRequest,
  VideoGenRequest,
} from '../../../src/plugins/media/types';

/** Small, valid, deterministic sources. `mimeType` — NOT `mediaType`, which is
 *  what `DataSource` actually uses; getting that wrong froze a malformed image
 *  part that proved nothing, and crashed the audio one outright. */
export const PNG: DataSource = { type: 'base64', mimeType: 'image/png', data: 'aGk=' };
export const WAV: DataSource = { type: 'base64', mimeType: 'audio/wav', data: 'UklGRg==' };
export const MP4: DataSource = { type: 'base64', mimeType: 'video/mp4', data: 'AAAAGGZ0' };

export interface MediaCase {
  /** Stable key in the frozen corpus. */
  name: string;
  /** Which adapter method to drive. */
  kind: 'image' | 'imageEdit' | 'audio' | 'video';
  /** Model id passed explicitly, so a default change is visible rather than silent. */
  model: string;
  req: ImageGenRequest | ImageEditRequest | AudioGenRequest | VideoGenRequest;
}

const img = (provider: string, prompt: string, params?: ImageGenRequest['params']): ImageGenRequest => ({
  provider,
  prompt,
  ...(params ? { params } : {}),
});

/** OpenAI media: images (both endpoint generations), speech, and Sora video. */
export const OPENAI_MEDIA: MediaCase[] = [
  { name: 'image.gpt-image-1.minimal', kind: 'image', model: 'gpt-image-1', req: img('openai', 'a cat') },
  {
    name: 'image.gpt-image-1.params',
    kind: 'image',
    model: 'gpt-image-1',
    req: img('openai', 'a cat', {
      n: 2,
      size: '1024x1024',
      quality: 'high',
      background: 'transparent',
      outputFormat: 'png',
    }),
  },
  // dall-e still takes response_format, which gpt-image-1 rejects: the one place
  // the OpenAI image wire genuinely forks by model.
  { name: 'image.dall-e-3', kind: 'image', model: 'dall-e-3', req: img('openai', 'a cat', { style: 'vivid', responseFormat: 'b64_json' }) },
  { name: 'image.dall-e-2', kind: 'image', model: 'dall-e-2', req: img('openai', 'a cat', { n: 3, size: '512x512' }) },
  {
    name: 'imageEdit.minimal',
    kind: 'imageEdit',
    model: 'gpt-image-1',
    req: { ...img('openai', 'add a hat'), sourceImage: PNG } as ImageEditRequest,
  },
  {
    name: 'imageEdit.masked',
    kind: 'imageEdit',
    model: 'gpt-image-1',
    req: {
      ...img('openai', 'add a hat', { n: 1, size: '1024x1024', style: 'natural' }),
      sourceImage: PNG,
      mask: PNG,
    } as ImageEditRequest,
  },
  {
    name: 'audio.speech',
    kind: 'audio',
    model: 'gpt-4o-mini-tts',
    req: { provider: 'openai', input: 'hello there', params: { voice: 'alloy', format: 'wav', speed: 1.1, instructions: 'cheerful' } } as AudioGenRequest,
  },
  {
    name: 'audio.speech.defaults',
    kind: 'audio',
    model: 'gpt-4o-mini-tts',
    req: { provider: 'openai', input: 'hello there' } as AudioGenRequest,
  },
  {
    name: 'video.minimal',
    kind: 'video',
    model: 'sora-2',
    req: { provider: 'openai', prompt: 'a wave' } as VideoGenRequest,
  },
  {
    name: 'video.params',
    kind: 'video',
    model: 'sora-2',
    req: { provider: 'openai', prompt: 'a wave', params: { duration: 8, size: '720x1280' } } as VideoGenRequest,
  },
  {
    name: 'video.fromImage',
    kind: 'video',
    model: 'sora-2',
    req: { provider: 'openai', prompt: 'animate', sourceImage: PNG } as VideoGenRequest,
  },
];

/** Google media: Imagen predict, Gemini generateContent image, TTS, Veo. */
export const GOOGLE_MEDIA: MediaCase[] = [
  { name: 'image.imagen.minimal', kind: 'image', model: 'imagen-4.0-generate-001', req: img('google', 'a cat') },
  {
    name: 'image.imagen.params',
    kind: 'image',
    model: 'imagen-4.0-generate-001',
    req: img('google', 'a cat', { n: 4, aspectRatio: '16:9', imageSize: '2K' }),
  },
  // Gemini image generation is generateContent, not predict — a different wire
  // entirely, chosen by the model id.
  { name: 'image.gemini.minimal', kind: 'image', model: 'gemini-2.5-flash-image', req: img('google', 'a cat') },
  {
    name: 'image.gemini.params',
    kind: 'image',
    model: 'gemini-2.5-flash-image',
    req: img('google', 'a cat', { aspectRatio: '1:1', imageSize: '1K' }),
  },
  {
    name: 'imageEdit.gemini',
    kind: 'imageEdit',
    model: 'gemini-2.5-flash-image',
    req: { ...img('google', 'add a hat'), sourceImage: PNG } as ImageEditRequest,
  },
  {
    name: 'audio.tts',
    kind: 'audio',
    model: 'gemini-2.5-flash-preview-tts',
    req: { provider: 'google', input: 'hello there', params: { voice: 'Kore' } } as AudioGenRequest,
  },
  {
    name: 'audio.tts.defaultVoice',
    kind: 'audio',
    model: 'gemini-2.5-flash-preview-tts',
    req: { provider: 'google', input: 'hello there' } as AudioGenRequest,
  },
  {
    name: 'video.veo.minimal',
    kind: 'video',
    model: 'veo-3.1-generate-preview',
    req: { provider: 'google', prompt: 'a wave' } as VideoGenRequest,
  },
  {
    name: 'video.veo.params',
    kind: 'video',
    model: 'veo-3.1-generate-preview',
    req: { provider: 'google', prompt: 'a wave', params: { duration: 6, aspectRatio: '16:9', resolution: '1080p' } } as VideoGenRequest,
  },
  {
    name: 'video.veo.fromImage',
    kind: 'video',
    model: 'veo-3.1-generate-preview',
    req: { provider: 'google', prompt: 'animate', sourceImage: PNG } as VideoGenRequest,
  },
];

export const MEDIA_SUITES: Array<{ provider: string; cases: MediaCase[] }> = [
  { provider: 'openai', cases: OPENAI_MEDIA },
  { provider: 'google', cases: GOOGLE_MEDIA },
];
