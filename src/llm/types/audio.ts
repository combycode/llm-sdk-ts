/** Shared audio types — one shape for voice/format options and raw audio input
 *  across complete() / generateAudio() / createRealtime() / transcribe(). */

export type AudioFormat = 'wav' | 'mp3' | 'pcm16' | 'opus' | 'flac' | 'aac';

/** Output audio controls. `voice` accepts a provider voice id OR a unified alias
 *  (see resolveVoice). */
export interface AudioOptions {
  voice?: string;
  format?: AudioFormat;
  /** Sample rate (Hz) for raw/PCM output. */
  sampleRate?: number;
}

/** Audio input source. A file path is MIME-detected; raw bytes should declare
 *  `mimeType` (and `sampleRate` for PCM). */
export interface AudioInput {
  data: Uint8Array | string;
  mimeType?: string;
  sampleRate?: number;
}
