/** transcribe() — speech-to-text, unified across providers.
 *
 *  Two provider shapes:
 *    - openai: a dedicated /v1/audio/transcriptions multipart endpoint
 *      (gpt-4o-transcribe / whisper). Routed to OpenAITranscriptionAdapter.
 *    - generateContent providers (google, …): transcription is just a normal
 *      completion with the audio attached, so reuse complete(). */

import { calculateTranscriptionCost } from '../plugins/cost-collector/cost-collector-internal';
import { OpenAITranscriptionAdapter } from '../llm/providers/openai/transcription';
import type { AudioInput } from '../llm/types/audio';
import type { AudioPart, ContentPart } from '../llm/types/messages';
import type { ProviderName } from '../llm/types/provider';
import { base64ToBytes } from '../util/base64';
import { isNamespacedModelId, parseModelId } from './client-resolver';
import { loadContent } from './content';
import type { EngineHandle } from './engine';
import { coreRegistry } from './engine';
import { complete } from './one-shot';

const DEFAULT_TRANSCRIBE_PROMPT = 'Transcribe this audio. Reply with only the spoken words.';

export interface TranscribeOptions {
  model: string;
  provider?: ProviderName;
  apiKey?: string;
  /** Audio source: a file path, raw bytes, or an AudioInput (with explicit
   *  mimeType for raw/stream audio). */
  audio: string | Uint8Array | AudioInput;
  /** Optional language hint (BCP-47, e.g. "en"). */
  language?: string;
  /** Prompt used for generateContent-style providers (ignored by openai). */
  prompt?: string;
  /** Caller-supplied audio duration in seconds.  Used to price OpenAI
   *  transcription calls (the API does not return duration).  When omitted,
   *  the helper tries to parse duration from a WAV header; other formats
   *  emit an honest zero with a note. */
  audioDurationSeconds?: number;
  engine?: EngineHandle;
}

export interface TranscribeResult {
  text: string;
}

export async function transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
  const engine = opts.engine ?? coreRegistry.get();
  const { provider, model } = resolveModel(opts.model, opts.provider);
  const apiKey = opts.apiKey ?? engine.apiKeys[provider];
  if (!apiKey) {
    throw new Error(
      `transcribe: no API key for provider "${provider}". Pass apiKey or set engine.apiKeys["${provider}"].`,
    );
  }

  const { data, mimeType: declaredMime } = normalizeAudio(opts.audio);

  if (provider === 'openai') {
    const { bytes, mimeType } = await loadAudioBytes(data, declaredMime);
    const adapter = new OpenAITranscriptionAdapter({ apiKey });
    const text = await adapter.transcribe(
      { bytes, mimeType, model, language: opts.language },
      engine.fetch,
    );
    const durationSeconds = opts.audioDurationSeconds ?? deriveWavDuration(bytes, mimeType);
    emitTranscriptionCost(engine, provider, model, durationSeconds);
    return { text };
  }

  // generateContent providers (google, …): STT is a normal completion.
  const { text } = await complete({
    model: opts.model,
    provider,
    apiKey,
    engine,
    prompt: opts.prompt ?? DEFAULT_TRANSCRIBE_PROMPT,
    attachments: [data],
    maxTokens: 1024,
  });
  return { text };
}

function normalizeAudio(audio: string | Uint8Array | AudioInput): {
  data: string | Uint8Array;
  mimeType?: string;
} {
  if (typeof audio === 'string' || audio instanceof Uint8Array) return { data: audio };
  return { data: audio.data, mimeType: audio.mimeType };
}

function resolveModel(
  model: string,
  provider?: ProviderName,
): { provider: ProviderName; model: string } {
  if (isNamespacedModelId(model)) {
    const [p, m] = parseModelId(model);
    return { provider: p, model: m };
  }
  if (!provider) {
    throw new Error(
      `transcribe: bare model "${model}" requires a provider (or use "provider/model").`,
    );
  }
  return { provider, model };
}

async function loadAudioBytes(
  data: string | Uint8Array,
  declaredMime?: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (data instanceof Uint8Array) return { bytes: data, mimeType: declaredMime ?? 'audio/wav' };
  const part = (await loadContent(data)) as ContentPart;
  if (part.type === 'audio') {
    const s = (part as AudioPart).source;
    if (s.type === 'base64') {
      return {
        bytes: base64ToBytes(s.data),
        mimeType: declaredMime ?? s.mimeType,
      };
    }
  }
  throw new Error('transcribe: could not load audio bytes from the given source');
}

/** Emit a cost hook for an OpenAI transcription call.  Uses `calculateTranscriptionCost`
 *  which returns an honest zero with a note when no `perMinute` rate exists or
 *  when duration is unknown. */
function emitTranscriptionCost(
  engine: EngineHandle,
  provider: string,
  model: string,
  durationSeconds: number | undefined,
): void {
  const { cost, note } = calculateTranscriptionCost(engine.catalog, provider, model, durationSeconds);
  const entry = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    provider,
    model,
    tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
    cost,
    providerEvidence: note ? { note } : {},
    tags: { provider, model, type: 'transcription' } as Record<string, string | undefined>,
  };
  engine.hooks.emitSync('onCostEntry', { entry, runningTotal: 0 });
}

/** WAV PCM duration from raw bytes — pure arithmetic, cross-env.
 *  Reads sample-rate (bytes 24-27) and data-chunk size from the RIFF header.
 *  Returns undefined for non-WAV or malformed data. */
export function deriveWavDuration(bytes: Uint8Array, mimeType: string): number | undefined {
  if (!mimeType.includes('wav') && !mimeType.includes('wave')) return undefined;
  if (bytes.length < WAV_MIN_HEADER_BYTES) return undefined;
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (riff !== WAV_RIFF_MARKER) return undefined;
  const sampleRate = readUint32LE(bytes, WAV_SAMPLE_RATE_OFFSET);
  if (sampleRate === 0) return undefined;
  const numChannels = readUint16LE(bytes, WAV_CHANNELS_OFFSET);
  const bitsPerSample = readUint16LE(bytes, WAV_BITS_PER_SAMPLE_OFFSET);
  // Find the 'data' sub-chunk which contains the raw audio size.
  const dataSize = findWavDataChunkSize(bytes);
  if (dataSize == null || numChannels === 0 || bitsPerSample === 0) return undefined;
  const bytesPerSample = bitsPerSample / WAV_BITS_PER_BYTE;
  return dataSize / (sampleRate * numChannels * bytesPerSample);
}

const WAV_MIN_HEADER_BYTES = 44;
const WAV_RIFF_MARKER = 'RIFF';
const WAV_DATA_MARKER = 'data';
const WAV_SAMPLE_RATE_OFFSET = 24;
const WAV_CHANNELS_OFFSET = 22;
const WAV_BITS_PER_SAMPLE_OFFSET = 34;
const WAV_BITS_PER_BYTE = 8;
const WAV_DATA_SEARCH_START = 36;

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/** Scan for the 'data' sub-chunk starting at offset 36 and return its size. */
function findWavDataChunkSize(bytes: Uint8Array): number | undefined {
  let offset = WAV_DATA_SEARCH_START;
  while (offset + WAV_DATA_CHUNK_HEADER_SIZE <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = readUint32LE(bytes, offset + WAV_CHUNK_SIZE_OFFSET);
    if (id === WAV_DATA_MARKER) return size;
    offset += WAV_DATA_CHUNK_HEADER_SIZE + size;
  }
  return undefined;
}

const WAV_DATA_CHUNK_HEADER_SIZE = 8;
const WAV_CHUNK_SIZE_OFFSET = 4;
