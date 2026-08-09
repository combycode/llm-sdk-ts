/** OpenAI transcription adapter — POST /v1/audio/transcriptions (multipart).
 *  All HTTP flows through the injected EngineFetch (rawBody multipart, like the
 *  batch file upload).
 *
 *  Three response shapes come back from one endpoint, selected by `response_format`
 *  and constrained by the model (all verified on the wire, 2026-08-09):
 *
 *  | model                     | `json`                        | `verbose_json`      | `diarized_json`     |
 *  |---------------------------|-------------------------------|---------------------|---------------------|
 *  | `gpt-transcribe`          | text + detected `languages`   | 400                 | 400                 |
 *  | `gpt-4o-transcribe`       | text                          | 400                 | 400                 |
 *  | `whisper-1`               | text                          | segments + words    | 400                 |
 *  | `gpt-4o-transcribe-diarize` | text                        | -                   | segments + speakers |
 *
 *  No model returns everything: speaker labels and word timings live on different
 *  models. `keywords` / `languages` are `gpt-transcribe`-only and 400 elsewhere. */

import type {
  TranscriptLanguage,
  TranscriptSegment,
  TranscriptWord,
} from '../../types/audio';
import type { EngineFetch } from '../../../network/types';

export interface OpenAITranscriptionAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export interface TranscriptionRequest {
  bytes: Uint8Array;
  mimeType: string;
  model: string;
  /** The language of the input audio (ISO-639-1). Improves accuracy and latency.
   *  Supported by `whisper-1` / `gpt-4o-transcribe`; NOT by `gpt-transcribe`,
   *  which uses `languages` instead. */
  language?: string;
  /** Candidate languages for the input audio (ISO-639-1). `gpt-transcribe` only. */
  languages?: string[];
  /** Words or phrases that steer spelling of names and jargon. `gpt-transcribe` only. */
  keywords?: string[];
  /** Ask for segment + word timings (`response_format: verbose_json`). `whisper-1` only. */
  wordTimestamps?: boolean;
  /** Ask for speaker-labelled segments (`response_format: diarized_json`).
   *  `gpt-4o-transcribe-diarize` only. */
  diarization?: boolean;
}

export interface OpenAITranscriptionResult {
  text: string;
  /** Languages the model reports detecting. Returned unconditionally by `gpt-transcribe`. */
  languages?: TranscriptLanguage[];
  segments?: TranscriptSegment[];
  words?: TranscriptWord[];
  /** Audio duration in seconds as the provider measured it — this is the quantity
   *  duration-billed models charge on, so it beats any local estimate. */
  durationSeconds?: number;
}

export class OpenAITranscriptionAdapter {
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: OpenAITranscriptionAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.openai.com';
  }

  async transcribe(
    req: TranscriptionRequest,
    fetch: EngineFetch,
  ): Promise<OpenAITranscriptionResult> {
    const res = await fetch({
      url: `${this.baseURL}/v1/audio/transcriptions`,
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: buildForm(req),
      rawBody: true,
      provider: 'openai',
      model: req.model,
      responseType: 'json',
    });
    if (res.status >= 400) {
      throw new Error(`OpenAI transcription failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return parseTranscription(res.body);
  }
}

/** Multipart body. Arrays repeat the key with a `[]` suffix — the scalar spelling
 *  (`languages=en`) is accepted and then silently ignored, so it must not be used. */
function buildForm(req: TranscriptionRequest): FormData {
  if (req.wordTimestamps && req.diarization) {
    throw new Error(
      'transcribe: wordTimestamps and diarization cannot be combined — they select different ' +
        'OpenAI response formats (verbose_json vs diarized_json), and no model serves both.',
    );
  }

  const form = new FormData();
  // Cast: TS narrows Uint8Array<ArrayBufferLike> out of BlobPart (SharedArrayBuffer
  // concern); the bytes are a plain Uint8Array at runtime.
  const blob = new Blob([req.bytes as unknown as BlobPart], { type: req.mimeType });
  form.append('file', blob, filenameFor(req.mimeType));
  form.append('model', req.model);
  if (req.language) form.append('language', req.language);
  for (const code of req.languages ?? []) form.append('languages[]', code);
  for (const keyword of req.keywords ?? []) form.append('keywords[]', keyword);

  // Every option below is model-gated upstream, and we forward it rather than
  // dropping it for the "wrong" model: a 400 naming the parameter is a far better
  // outcome than silently transcribing without what the caller asked for
  // (CONSTITUTION.md R4 — gating is internal, but silence is not a gate).
  if (req.diarization) {
    form.append('response_format', 'diarized_json');
  } else if (req.wordTimestamps) {
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    form.append('timestamp_granularities[]', 'word');
  }
  return form;
}

interface RawTranscription {
  text?: string;
  duration?: number;
  languages?: { code?: string }[];
  segments?: { id?: string | number; start?: number; end?: number; text?: string; speaker?: string }[];
  words?: { word?: string; start?: number; end?: number }[];
  usage?: { type?: string; seconds?: number };
}

export function parseTranscription(body: unknown): OpenAITranscriptionResult {
  const raw = (body ?? {}) as RawTranscription;
  const result: OpenAITranscriptionResult = { text: raw.text ?? '' };

  const languages = (raw.languages ?? [])
    .filter((l) => typeof l?.code === 'string')
    .map((l) => ({ code: l.code as string }));
  if (languages.length > 0) result.languages = languages;

  const segments = (raw.segments ?? [])
    .filter((s) => typeof s?.start === 'number' && typeof s?.end === 'number')
    .map((s) => {
      const segment: TranscriptSegment = {
        start: s.start as number,
        end: s.end as number,
        text: s.text ?? '',
      };
      // whisper numbers segments from 0, so `id: 0` is real and must survive.
      if (s.id != null) segment.id = String(s.id);
      if (s.speaker != null) segment.speaker = s.speaker;
      return segment;
    });
  if (segments.length > 0) result.segments = segments;

  const words = (raw.words ?? [])
    .filter((w) => typeof w?.word === 'string' && typeof w?.start === 'number' && typeof w?.end === 'number')
    .map((w) => ({ word: w.word as string, start: w.start as number, end: w.end as number }));
  if (words.length > 0) result.words = words;

  // `verbose_json` / `diarized_json` report it at the top level; the token-billed
  // models report it only inside a duration-typed usage object.
  const duration =
    typeof raw.duration === 'number'
      ? raw.duration
      : raw.usage?.type === 'duration' && typeof raw.usage.seconds === 'number'
        ? raw.usage.seconds
        : undefined;
  if (duration != null) result.durationSeconds = duration;

  return result;
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
