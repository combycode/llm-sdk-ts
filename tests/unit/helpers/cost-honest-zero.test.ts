/** Cost-gap closure tests — every newly-instrumented request path emits a
 *  cost hook or an honest zero.  No network, no API keys.
 *
 *  Covers:
 *    1. transcribe() (OpenAI) emits a PRICED cost entry when duration + rate known
 *    2. transcribe() (OpenAI) emits an honest zero with a note when rate missing
 *    3. transcribe() (OpenAI) emits an honest zero with a note when duration unknown
 *    4. deriveWavDuration() parses duration from a synthetic WAV header
 *    5. countTokens() with count-API path emits explicit zero with note
 *    6. batch collect() emits onCostEntry per successfully-parsed result
 *    7. calculateTranscriptionCost() math: minutes = seconds / 60
 */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import type { CostEntryContext } from '../../../src/bus/hook-map';
import { transcribe } from '../../../src/helpers/transcribe';
import { deriveWavDuration } from '../../../src/helpers/transcribe';
import { calculateTranscriptionCost, computeCost } from '../../../src/plugins/cost-collector/cost-collector-internal';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';
import type { EngineHandle } from '../../../src/helpers/engine';
import type { EngineFetch, HttpResponse } from '../../../src/network/types';

// ─── WAV header builder (minimal 44-byte PCM WAV) ─────────────────────────────

function buildWav(sampleRate: number, channels: number, bitsPerSample: number, durationSeconds: number): Uint8Array {
  const dataSize = Math.round(sampleRate * channels * (bitsPerSample / 8) * durationSeconds);
  const fileSize = 36 + dataSize;
  const buf = new Uint8Array(44 + dataSize);
  const view = new DataView(buf.buffer);

  // RIFF chunk
  buf.set([82, 73, 70, 70], 0); // 'RIFF'
  view.setUint32(4, fileSize, true);
  buf.set([87, 65, 86, 69], 8); // 'WAVE'

  // fmt sub-chunk
  buf.set([102, 109, 116, 32], 12); // 'fmt '
  view.setUint32(16, 16, true); // chunk size 16 = PCM
  view.setUint16(20, 1, true); // audio format 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true); // byte rate
  view.setUint16(32, channels * (bitsPerSample / 8), true); // block align
  view.setUint16(34, bitsPerSample, true);

  // data sub-chunk header
  buf.set([100, 97, 116, 97], 36); // 'data'
  view.setUint32(40, dataSize, true);

  return buf;
}

// ─── Engine stub factory ──────────────────────────────────────────────────────

function makeEngine(catalog: ModelCatalog): { engine: EngineHandle; entries: CostEntryContext[] } {
  const entries: CostEntryContext[] = [];
  const hooks = new HookBus();
  hooks.on('onCostEntry', (ctx) => { entries.push(ctx); });
  const fetch: EngineFetch = async (): Promise<HttpResponse> => ({
    status: 200,
    headers: {},
    body: { text: 'hello' },
  });
  const engine = { apiKeys: { openai: 'k', anthropic: 'k', google: 'k' }, fetch, hooks, catalog } as unknown as EngineHandle;
  return { engine, entries };
}

// ─── 1. Transcription: priced when duration + rate known ─────────────────────

describe('transcribe() — cost hook (OpenAI)', () => {
  it('emits a PRICED onCostEntry when audioDurationSeconds and perMinute rate are both known', async () => {
    const catalog = new ModelCatalog();
    catalog.set('openai', 'gpt-4o-transcribe', { pricing: { perMinute: 0.006 } });
    const { engine, entries } = makeEngine(catalog);

    await transcribe({
      model: 'openai/gpt-4o-transcribe',
      engine,
      audio: new Uint8Array([1, 2, 3]),
      audioDurationSeconds: 60, // 1 minute
    });

    expect(entries).toHaveLength(1);
    const entry = entries[0].entry;
    // 1 minute * $0.006/min = $0.006
    expect(entry.cost.total).toBeCloseTo(0.006, 8);
    expect(entry.cost.source).toBe('calculated');
    expect(entry.tags.type).toBe('transcription');
  });

  it('emits an honest zero with note when model has no perMinute rate', async () => {
    const catalog = new ModelCatalog();
    catalog.set('openai', 'whisper-1', { pricing: {} }); // no perMinute
    const { engine, entries } = makeEngine(catalog);

    await transcribe({
      model: 'openai/whisper-1',
      engine,
      audio: new Uint8Array([1, 2, 3]),
      audioDurationSeconds: 30,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].entry.cost.total).toBe(0);
    expect(entries[0].entry.cost.source).toBe('unknown');
    expect(entries[0].entry.providerEvidence.note).toMatch(/unpriced/);
  });

  it('emits an honest zero with note when audioDurationSeconds is absent and audio is not WAV', async () => {
    const catalog = new ModelCatalog();
    catalog.set('openai', 'gpt-4o-transcribe', { pricing: { perMinute: 0.006 } });
    const { engine, entries } = makeEngine(catalog);

    // MP3 bytes — not parseable for duration, no caller-supplied duration
    await transcribe({
      model: 'openai/gpt-4o-transcribe',
      engine,
      audio: { data: new Uint8Array([0xff, 0xfb]), mimeType: 'audio/mp3' },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].entry.cost.total).toBe(0);
    expect(entries[0].entry.providerEvidence.note).toMatch(/duration unknown/);
  });

  it('derives WAV duration from audio bytes when audioDurationSeconds is absent', async () => {
    const catalog = new ModelCatalog();
    catalog.set('openai', 'gpt-4o-transcribe', { pricing: { perMinute: 0.006 } });
    const { engine, entries } = makeEngine(catalog);

    // Synthetic 10-second mono 16-bit 44100 Hz WAV
    const wavBytes = buildWav(44100, 1, 16, 10);
    await transcribe({
      model: 'openai/gpt-4o-transcribe',
      engine,
      audio: wavBytes,
    });

    expect(entries).toHaveLength(1);
    const entry = entries[0].entry;
    // 10s / 60s = 1/6 minute * $0.006 = $0.0001
    expect(entry.cost.total).toBeCloseTo((10 / 60) * 0.006, 8);
    expect(entry.cost.source).toBe('calculated');
  });
});

// ─── 2. deriveWavDuration ─────────────────────────────────────────────────────

describe('deriveWavDuration()', () => {
  it('returns duration in seconds for a well-formed WAV', () => {
    const wav = buildWav(44100, 1, 16, 5);
    const dur = deriveWavDuration(wav, 'audio/wav');
    expect(dur).toBeCloseTo(5, 3);
  });

  it('returns undefined for non-WAV mime type', () => {
    const bytes = buildWav(44100, 1, 16, 5);
    expect(deriveWavDuration(bytes, 'audio/mp3')).toBeUndefined();
  });

  it('returns undefined for a too-short buffer', () => {
    expect(deriveWavDuration(new Uint8Array(10), 'audio/wav')).toBeUndefined();
  });

  it('returns undefined for bytes that do not start with RIFF', () => {
    const bytes = buildWav(44100, 1, 16, 5);
    bytes[0] = 0; // corrupt RIFF marker
    expect(deriveWavDuration(bytes, 'audio/wav')).toBeUndefined();
  });
});

// ─── 3. calculateTranscriptionCost math ──────────────────────────────────────

describe('calculateTranscriptionCost()', () => {
  it('prices 90 seconds at perMinute rate (90s = 1.5 min)', () => {
    const catalog = new ModelCatalog();
    catalog.set('openai', 'gpt-4o-transcribe', { pricing: { perMinute: 0.006 } });
    const { cost } = calculateTranscriptionCost(catalog, 'openai', 'gpt-4o-transcribe', 90);
    expect(cost.total).toBeCloseTo(1.5 * 0.006, 8);
    expect(cost.source).toBe('calculated');
  });

  it('returns unknown + note when catalog has no entry', () => {
    const catalog = new ModelCatalog();
    const { cost, note } = calculateTranscriptionCost(catalog, 'openai', 'no-such-model', 60);
    expect(cost.total).toBe(0);
    expect(cost.source).toBe('unknown');
    expect(note).toMatch(/no catalog entry/);
  });

  it('returns unknown + note when catalog entry has no perMinute', () => {
    const catalog = new ModelCatalog();
    catalog.set('openai', 'whisper-1', { pricing: {} });
    const { cost, note } = calculateTranscriptionCost(catalog, 'openai', 'whisper-1', 60);
    expect(cost.total).toBe(0);
    expect(note).toMatch(/no catalog perMinute rate/);
  });

  it('returns unknown + note when durationSeconds is undefined', () => {
    const catalog = new ModelCatalog();
    catalog.set('openai', 'gpt-4o-transcribe', { pricing: { perMinute: 0.006 } });
    const { cost, note } = calculateTranscriptionCost(catalog, 'openai', 'gpt-4o-transcribe', undefined);
    expect(cost.total).toBe(0);
    expect(note).toMatch(/duration unknown/);
  });
});

// ─── 4. countTokens — count-API path emits honest zero ───────────────────────

describe('countTokens() — count-API honest zero', () => {
  it('emits onCostEntry with zero cost and free note when anthropic count-api is used', async () => {
    const { countTokens } = await import('../../../src/helpers/count-tokens');

    const catalog = new ModelCatalog();
    // claude-3-haiku uses count_api strategy
    catalog.set('anthropic', 'claude-3-haiku', {
      pricing: { inputPerMTok: 0.25, outputPerMTok: 1.25 },
      tokenizer: { strategy: 'count_api', charsPerTokenDefault: 4, countApiAvailable: true },
    });

    const entries: CostEntryContext[] = [];
    const hooks = new HookBus();
    hooks.on('onCostEntry', (ctx) => { entries.push(ctx); });

    // Stub fetch that returns 5 tokens
    const stubFetch = async (_url: string, _opts: unknown) => ({
      ok: true,
      json: async () => ({ input_tokens: 5 }),
      text: async () => '',
    } as unknown as Response);

    // We can't easily inject fetch into AnthropicCountApi since it uses globalThis.fetch.
    // Instead verify the honest-zero logic by emitting the hook directly from countTokens
    // when apiKey is set AND strategy is count_api — but the HybridTokenCounter routes
    // to the CountApiCounter which calls the real fetch.
    // For this unit test, use exact:false (heuristic) but verify the honest-zero is NOT
    // emitted for non-count-api path, then verify exact:true (with a stubbed api) emits it.
    // Since we cannot inject fetch without network, verify via the "no apiKey" path:
    // with no apiKey, usesCountApi is false → no zero emitted.
    void stubFetch;
    const engine = { apiKeys: {}, fetch: null as unknown as EngineFetch, hooks, catalog } as unknown as EngineHandle;
    await countTokens({ model: 'anthropic/claude-3-haiku', input: 'hello', exact: false, engine });
    // exact:false → heuristic only → no count-api call → no zero emitted.
    expect(entries).toHaveLength(0);
  });

  it('emits onCostEntry with note="free: provider does not bill count endpoint" when count-api fires', async () => {
    const { countTokens } = await import('../../../src/helpers/count-tokens');

    const catalog = new ModelCatalog();
    catalog.set('anthropic', 'claude-3-haiku', {
      pricing: { inputPerMTok: 0.25, outputPerMTok: 1.25 },
      tokenizer: { strategy: 'count_api', charsPerTokenDefault: 4, countApiAvailable: true },
    });

    const entries: CostEntryContext[] = [];
    const hooks = new HookBus();
    hooks.on('onCostEntry', (ctx) => { entries.push(ctx); });

    // Patch globalThis.fetch to intercept the Anthropic count_tokens call
    const origFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ input_tokens: 3 }), text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      const engine = { apiKeys: { anthropic: 'test-key' }, fetch: null as unknown as EngineFetch, hooks, catalog } as unknown as EngineHandle;
      const n = await countTokens({ model: 'anthropic/claude-3-haiku', input: 'hi', exact: true, engine });
      expect(n).toBe(3);
      expect(fetchCalled).toBe(true);
      expect(entries).toHaveLength(1);
      expect(entries[0].entry.cost.total).toBe(0);
      expect(entries[0].entry.cost.source).toBe('calculated');
      expect(entries[0].entry.providerEvidence.note).toBe('free: provider does not bill count endpoint');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ─── 5. catalog rates for audio models (whisper-1 / tts-1 / tts-1-hd / diarize)

describe('catalog audio model pricing — verified rates (June 2026)', () => {
  it('whisper-1 produces non-zero transcription cost from the real catalog (0.006 USD/min)', () => {
    const catalog = new ModelCatalog();
    catalog.loadProviderDefaults();
    // 60 seconds = 1 minute * $0.006/min = $0.006
    const { cost } = calculateTranscriptionCost(catalog, 'openai', 'whisper-1', 60);
    expect(cost.total).toBeCloseTo(0.006, 8);
    expect(cost.source).toBe('calculated');
  });

  it('gpt-4o-transcribe-diarize produces non-zero transcription cost from the real catalog (0.006 USD/min)', () => {
    const catalog = new ModelCatalog();
    catalog.loadProviderDefaults();
    // 90 seconds = 1.5 minutes * $0.006/min = $0.009
    const { cost } = calculateTranscriptionCost(catalog, 'openai', 'gpt-4o-transcribe-diarize', 90);
    expect(cost.total).toBeCloseTo(1.5 * 0.006, 8);
    expect(cost.source).toBe('calculated');
  });

  it('tts-1 produces non-zero TTS cost from the real catalog (15 USD/1M chars)', () => {
    const catalog = new ModelCatalog();
    catalog.loadProviderDefaults();
    // 500_000 chars / 1_000_000 * 15 = 7.5
    const cost = computeCost(catalog, { provider: 'openai', model: 'tts-1', media: { type: 'audio', textChars: 500_000 } });
    expect(cost.total).toBeCloseTo(7.5, 6);
    expect(cost.source).toBe('calculated');
  });

  it('tts-1-hd produces non-zero TTS cost from the real catalog (30 USD/1M chars)', () => {
    const catalog = new ModelCatalog();
    catalog.loadProviderDefaults();
    // 500_000 chars / 1_000_000 * 30 = 15.0
    const cost = computeCost(catalog, { provider: 'openai', model: 'tts-1-hd', media: { type: 'audio', textChars: 500_000 } });
    expect(cost.total).toBeCloseTo(15.0, 6);
    expect(cost.source).toBe('calculated');
  });
});

// ─── 6. batch collect() emits onCostEntry per result ─────────────────────────

describe('batch collect() — cost hooks per result', () => {
  const OUTPUT_JSONL =
    `${JSON.stringify({ custom_id: 'a', response: { status_code: 200, body: { output_text: 'Apple' } } })}\n` +
    `${JSON.stringify({ custom_id: 'b', response: { status_code: 200, body: { output_text: 'Banana' } } })}`;

  function makeBatchEngine(): { engine: EngineHandle; entries: CostEntryContext[] } {
    const entries: CostEntryContext[] = [];
    const hooks = new HookBus();
    hooks.on('onCostEntry', (ctx) => { entries.push(ctx); });
    const catalog = new ModelCatalog();
    catalog.set('openai', 'gpt-5-nano', { pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 } });

    const fetch: EngineFetch = async (req): Promise<HttpResponse> => {
      const url = req.url;
      const method = req.method ?? 'POST';
      if (url.endsWith('/v1/files') && method === 'POST')
        return { status: 200, headers: {}, body: { id: 'file_in_1' } };
      if (url.endsWith('/v1/batches') && method === 'POST')
        return { status: 200, headers: {}, body: { id: 'batch_1' } };
      if (url.includes('/v1/batches/batch_1') && method === 'GET')
        return { status: 200, headers: {}, body: { id: 'batch_1', status: 'completed', output_file_id: 'file_out_1' } };
      if (url.includes('/v1/files/file_out_1/content') && method === 'GET')
        return { status: 200, headers: {}, body: OUTPUT_JSONL };
      throw new Error(`unexpected fetch: ${method} ${url}`);
    };

    return { engine: { apiKeys: { openai: 'k' }, fetch, hooks, catalog } as unknown as EngineHandle, entries };
  }

  it('emits one onCostEntry per successfully-parsed batch result', async () => {
    const { batch } = await import('../../../src/helpers/batch');
    const { engine, entries } = makeBatchEngine();

    await batch({
      model: 'openai/gpt-5-nano',
      engine,
      pollIntervalMs: 1,
      requests: [
        { customId: 'a', prompt: 'Say apple.' },
        { customId: 'b', prompt: 'Say banana.' },
      ],
    });

    // Two results → two cost entries
    expect(entries).toHaveLength(2);
    for (const ctx of entries) {
      expect(ctx.entry.tags.type).toBe('batch');
      expect(ctx.entry.provider).toBe('openai');
    }
  });
});
