/** OpenAI transcription adapter — POST /v1/audio/transcriptions (multipart).
 *  All HTTP flows through the injected EngineFetch (rawBody multipart, like the
 *  batch file upload). gpt-4o-transcribe / whisper return `{ text }`. */

import type { EngineFetch } from '../../../network/types';

export interface OpenAITranscriptionAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export interface TranscriptionRequest {
  bytes: Uint8Array;
  mimeType: string;
  model: string;
  language?: string;
}

export class OpenAITranscriptionAdapter {
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: OpenAITranscriptionAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.openai.com';
  }

  async transcribe(req: TranscriptionRequest, fetch: EngineFetch): Promise<string> {
    const form = new FormData();
    // Cast: TS narrows Uint8Array<ArrayBufferLike> out of BlobPart (SharedArrayBuffer
    // concern); the bytes are a plain Uint8Array at runtime.
    const blob = new Blob([req.bytes as unknown as BlobPart], { type: req.mimeType });
    form.append('file', blob, filenameFor(req.mimeType));
    form.append('model', req.model);
    if (req.language) form.append('language', req.language);

    const res = await fetch({
      url: `${this.baseURL}/v1/audio/transcriptions`,
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      rawBody: true,
      provider: 'openai',
      model: req.model,
      responseType: 'json',
    });
    if (res.status >= 400) {
      throw new Error(`OpenAI transcription failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return (res.body as { text?: string })?.text ?? '';
  }
}

/** A filename with a supported extension — the transcriptions endpoint needs one. */
function filenameFor(mimeType: string): string {
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'audio.mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'audio.m4a';
  if (mimeType.includes('ogg')) return 'audio.ogg';
  if (mimeType.includes('flac')) return 'audio.flac';
  if (mimeType.includes('webm')) return 'audio.webm';
  return 'audio.wav';
}
