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

/** A language a provider reports detecting in transcribed audio.
 *
 *  An object rather than a bare `string` on purpose: providers already annotate
 *  detections and will annotate them further (confidence, spans). A `string[]`
 *  could only grow by becoming a different type, which is exactly the breaking
 *  change CONSTITUTION.md R3 forbids. */
export interface TranscriptLanguage {
  /** Language code as the provider reported it (typically ISO-639-1, e.g. `en`). */
  code: string;
}

/** One word with its timing, in seconds from the start of the audio. */
export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

/** A timed run of transcript text.
 *
 *  `speaker` is present only when diarization ran; no provider surface currently
 *  returns speakers and word timings together (see `transcribe()`), so a segment
 *  carries whichever the chosen model produces. */
export interface TranscriptSegment {
  /** Provider segment id, normalised to a string (whisper numbers them, the
   *  diarizing models use `seg_N`). */
  id?: string;
  start: number;
  end: number;
  text: string;
  /** Speaker label, e.g. `A` / `B`, or a name from the provider's known-speaker list. */
  speaker?: string;
}
