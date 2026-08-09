/** transcribe() — openai multipart adapter + helper routing, via a fake
 *  EngineFetch (no network).
 *
 *  The response fixtures below are trimmed copies of REAL bodies captured from
 *  /v1/audio/transcriptions on 2026-08-09, not invented shapes — including the
 *  details that differ per model (whisper numbers segments, the diarizing model
 *  uses `seg_N` strings and has no `words`). */

import { describe, expect, it } from 'bun:test';
import { transcribe } from '../../../src/helpers/transcribe';
import type { EngineHandle } from '../../../src/helpers/engine';
import { HookBus } from '../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';
import { OpenAITranscriptionAdapter } from '../../../src/llm/providers/openai/transcription';
import type { EngineFetch, HttpRequest, HttpResponse } from '../../../src/network/types';

function capturingFetch(body: unknown): { fetch: EngineFetch; last: () => HttpRequest } {
  let captured: HttpRequest | undefined;
  const fetch: EngineFetch = async (req): Promise<HttpResponse> => {
    captured = req;
    return { status: 200, headers: {}, body };
  };
  return { fetch, last: () => captured as HttpRequest };
}

const BYTES = new Uint8Array([1, 2, 3]);

function form(req: HttpRequest): FormData {
  return req.body as FormData;
}

// ─── request assembly ────────────────────────────────────────────────────────

describe('OpenAITranscriptionAdapter — request', () => {
  it('POSTs multipart to /v1/audio/transcriptions and returns the text', async () => {
    const { fetch, last } = capturingFetch({ text: 'hello' });
    const adapter = new OpenAITranscriptionAdapter({ apiKey: 'k' });
    const res = await adapter.transcribe(
      { bytes: BYTES, mimeType: 'audio/wav', model: 'gpt-4o-transcribe' },
      fetch,
    );
    expect(res.text).toBe('hello');
    const req = last();
    expect(req.url).toContain('/v1/audio/transcriptions');
    expect(req.rawBody).toBe(true);
    expect(req.body).toBeInstanceOf(FormData);
    expect(form(req).get('model')).toBe('gpt-4o-transcribe');
  });

  it('passes a language hint when given', async () => {
    const { fetch, last } = capturingFetch({ text: 'bonjour' });
    await new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
      { bytes: BYTES, mimeType: 'audio/wav', model: 'm', language: 'fr' },
      fetch,
    );
    expect(form(last()).get('language')).toBe('fr');
  });

  it('sends keywords and languages as REPEATED [] keys', async () => {
    const { fetch, last } = capturingFetch({ text: 'x' });
    await new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
      {
        bytes: BYTES,
        mimeType: 'audio/wav',
        model: 'gpt-transcribe',
        keywords: ['Zylberquist', 'Praxil'],
        languages: ['en', 'de'],
      },
      fetch,
    );
    const f = form(last());
    // The bracket suffix is load-bearing: `languages=en` (scalar) is accepted with a
    // 200 and then ignored, so a scalar spelling would look like it worked.
    expect(f.getAll('keywords[]')).toEqual(['Zylberquist', 'Praxil']);
    expect(f.getAll('languages[]')).toEqual(['en', 'de']);
    expect(f.get('languages')).toBeNull();
    expect(f.get('keywords')).toBeNull();
  });

  it('omits array keys entirely when the options are absent or empty', async () => {
    const { fetch, last } = capturingFetch({ text: 'x' });
    await new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
      { bytes: BYTES, mimeType: 'audio/wav', model: 'm', keywords: [], languages: undefined },
      fetch,
    );
    const f = form(last());
    expect(f.getAll('keywords[]')).toEqual([]);
    expect(f.getAll('languages[]')).toEqual([]);
    expect(f.get('response_format')).toBeNull();
  });

  it('wordTimestamps selects verbose_json with both granularities', async () => {
    const { fetch, last } = capturingFetch({ text: 'x' });
    await new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
      { bytes: BYTES, mimeType: 'audio/wav', model: 'whisper-1', wordTimestamps: true },
      fetch,
    );
    const f = form(last());
    expect(f.get('response_format')).toBe('verbose_json');
    // Word granularity alone 400s ("only supported with response_format=verbose_json"),
    // and asking for word without segment loses the segment list.
    expect(f.getAll('timestamp_granularities[]')).toEqual(['segment', 'word']);
  });

  it('diarization selects diarized_json and no granularities', async () => {
    const { fetch, last } = capturingFetch({ text: 'x' });
    await new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
      { bytes: BYTES, mimeType: 'audio/wav', model: 'gpt-4o-transcribe-diarize', diarization: true },
      fetch,
    );
    const f = form(last());
    expect(f.get('response_format')).toBe('diarized_json');
    expect(f.getAll('timestamp_granularities[]')).toEqual([]);
  });

  it('refuses to combine wordTimestamps with diarization', async () => {
    const { fetch } = capturingFetch({ text: 'x' });
    // They map to different response_format values; no model serves both, so silently
    // picking one would hand back a transcript missing what the caller asked for.
    await expect(
      new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
        { bytes: BYTES, mimeType: 'audio/wav', model: 'm', wordTimestamps: true, diarization: true },
        fetch,
      ),
    ).rejects.toThrow(/cannot be combined/);
  });

  it('forwards model-gated options rather than dropping them for the wrong model', async () => {
    const { fetch, last } = capturingFetch({ text: 'x' });
    // whisper-1 400s on keywords. We send anyway: a 400 naming the parameter tells the
    // caller their keywords did nothing; a silent drop does not.
    await new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
      { bytes: BYTES, mimeType: 'audio/wav', model: 'whisper-1', keywords: ['Praxil'] },
      fetch,
    );
    expect(form(last()).getAll('keywords[]')).toEqual(['Praxil']);
  });

  it('surfaces the provider error body on a failure status', async () => {
    const fetch: EngineFetch = async () => ({
      status: 400,
      headers: {},
      body: { error: { message: "The 'languages' parameter is not supported for this model." } },
    });
    await expect(
      new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
        { bytes: BYTES, mimeType: 'audio/wav', model: 'gpt-4o-transcribe', languages: ['en'] },
        fetch,
      ),
    ).rejects.toThrow(/not supported for this model/);
  });
});

// ─── response parsing, per real body shape ───────────────────────────────────

describe('OpenAITranscriptionAdapter — response', () => {
  it('reads detected languages and duration from a gpt-transcribe body', async () => {
    const { fetch } = capturingFetch({
      text: 'Please escalate the Zylberquist incident.',
      languages: [{ code: 'en' }],
      usage: { type: 'duration', seconds: 8 },
    });
    const res = await new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
      { bytes: BYTES, mimeType: 'audio/wav', model: 'gpt-transcribe' },
      fetch,
    );
    expect(res.languages).toEqual([{ code: 'en' }]);
    expect(res.durationSeconds).toBe(8);
    expect(res.segments).toBeUndefined();
  });

  it('reads segments and words from a verbose_json body', async () => {
    const { fetch } = capturingFetch({
      task: 'transcribe',
      language: 'english',
      duration: 14.95,
      text: 'Hello. This is Alice.',
      segments: [
        { id: 0, seek: 0, start: 0, end: 5.66, text: ' Hello. This is Alice.', tokens: [1, 2] },
        { id: 1, seek: 0, start: 6.26, end: 11, text: ' This is Bob.', tokens: [3] },
      ],
      words: [{ word: 'Hello', start: 0, end: 0.72 }],
      usage: { type: 'duration', seconds: 15 },
    });
    const res = await new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
      { bytes: BYTES, mimeType: 'audio/wav', model: 'whisper-1', wordTimestamps: true },
      fetch,
    );
    // `id: 0` is a real segment id — a truthiness check would drop it.
    expect(res.segments?.[0]).toEqual({ id: '0', start: 0, end: 5.66, text: ' Hello. This is Alice.' });
    expect(res.segments).toHaveLength(2);
    expect(res.segments?.[0].speaker).toBeUndefined();
    expect(res.words).toEqual([{ word: 'Hello', start: 0, end: 0.72 }]);
    // Top-level duration wins over the usage copy; both are present here.
    expect(res.durationSeconds).toBe(14.95);
  });

  it('reads speaker labels from a diarized_json body', async () => {
    const { fetch } = capturingFetch({
      text: 'Hello; this is Alice.',
      task: 'transcribe',
      duration: 14.95,
      segments: [
        {
          type: 'transcript.text.segment',
          text: ' Hello; this is Alice.',
          speaker: 'A',
          start: 0.3,
          end: 5.45,
          id: 'seg_0',
        },
        {
          type: 'transcript.text.segment',
          text: ' I disagree.',
          speaker: 'B',
          start: 6,
          end: 7.8,
          id: 'seg_1',
        },
      ],
      usage: { type: 'tokens', total_tokens: 592 },
    });
    const res = await new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
      { bytes: BYTES, mimeType: 'audio/wav', model: 'gpt-4o-transcribe-diarize', diarization: true },
      fetch,
    );
    expect(res.segments?.map((s) => s.speaker)).toEqual(['A', 'B']);
    expect(res.segments?.[0].id).toBe('seg_0');
    // This model bills by token, so duration comes only from the top level.
    expect(res.durationSeconds).toBe(14.95);
    expect(res.words).toBeUndefined();
  });

  it('leaves every structured field undefined for a plain json body', async () => {
    const { fetch } = capturingFetch({ text: 'hello' });
    const res = await new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
      { bytes: BYTES, mimeType: 'audio/wav', model: 'gpt-4o-transcribe' },
      fetch,
    );
    // R3: `text` is the only guaranteed field; absent structure must not appear as
    // empty arrays, which a consumer would read as "ran and found nothing".
    expect(res).toEqual({ text: 'hello' });
  });

  it('drops malformed entries instead of emitting NaN timings', async () => {
    const { fetch } = capturingFetch({
      text: 'x',
      languages: [{ code: 'en' }, { notACode: 1 }],
      segments: [{ start: 0, end: 1, text: 'ok' }, { text: 'no timing' }],
      words: [{ word: 'ok', start: 0, end: 1 }, { word: 'bad' }],
    });
    const res = await new OpenAITranscriptionAdapter({ apiKey: 'k' }).transcribe(
      { bytes: BYTES, mimeType: 'audio/wav', model: 'm' },
      fetch,
    );
    expect(res.languages).toEqual([{ code: 'en' }]);
    expect(res.segments).toHaveLength(1);
    expect(res.words).toHaveLength(1);
  });
});

// ─── helper routing + costing ────────────────────────────────────────────────

function makeEngine(fetch: EngineFetch, hooks = new HookBus()): EngineHandle {
  const catalog = new ModelCatalog();
  catalog.set('openai', 'gpt-4o-transcribe', { pricing: { perMinute: 0.006 } });
  catalog.set('openai', 'gpt-transcribe', { pricing: { perMinute: 0.006 } });
  return { apiKeys: { openai: 'k', google: 'g' }, fetch, hooks, catalog } as unknown as EngineHandle;
}

describe('transcribe() — provider routing', () => {
  it('routes openai to the transcription endpoint', async () => {
    const { fetch, last } = capturingFetch({ text: 'hello' });
    const res = await transcribe({
      model: 'openai/gpt-4o-transcribe',
      engine: makeEngine(fetch),
      audio: BYTES,
    });
    expect(res.text).toBe('hello');
    expect(last().url).toContain('/v1/audio/transcriptions');
  });

  it('passes the structured options through to the request', async () => {
    const { fetch, last } = capturingFetch({ text: 'hello', languages: [{ code: 'en' }] });
    const res = await transcribe({
      model: 'openai/gpt-transcribe',
      engine: makeEngine(fetch),
      audio: BYTES,
      keywords: ['Praxil'],
      languages: ['en'],
    });
    const f = form(last());
    expect(f.getAll('keywords[]')).toEqual(['Praxil']);
    expect(f.getAll('languages[]')).toEqual(['en']);
    expect(res.languages).toEqual([{ code: 'en' }]);
  });

  it('prices from the provider-reported duration when the caller gives none', async () => {
    const { fetch } = capturingFetch({ text: 'hi', usage: { type: 'duration', seconds: 120 } });
    const hooks = new HookBus();
    let cost = -1;
    hooks.on('onCostEntry', ({ entry }) => {
      cost = entry.cost.total;
    });
    await transcribe({ model: 'openai/gpt-transcribe', engine: makeEngine(fetch, hooks), audio: BYTES });
    // 120 s at $0.006/min = $0.012. The raw bytes are not a parseable WAV, so before
    // this the only outcome available was an honest zero.
    expect(cost).toBeCloseTo(0.012, 6);
  });

  it('lets an explicit audioDurationSeconds win over the provider figure', async () => {
    const { fetch } = capturingFetch({ text: 'hi', usage: { type: 'duration', seconds: 120 } });
    const hooks = new HookBus();
    let cost = -1;
    hooks.on('onCostEntry', ({ entry }) => {
      cost = entry.cost.total;
    });
    await transcribe({
      model: 'openai/gpt-transcribe',
      engine: makeEngine(fetch, hooks),
      audio: BYTES,
      audioDurationSeconds: 60,
    });
    expect(cost).toBeCloseTo(0.006, 6);
  });

  it('warns instead of silently dropping structured options on a generateContent provider', async () => {
    const fetch: EngineFetch = async () => ({
      status: 200,
      headers: {},
      body: { candidates: [{ content: { parts: [{ text: 'plain transcript' }] } }] },
    });
    const hooks = new HookBus();
    const warnings: { code: string; message: string }[] = [];
    hooks.on('onWarning', (w) => {
      warnings.push({ code: w.code, message: w.message });
    });
    const res = await transcribe({
      model: 'google/gemini-3.6-flash',
      engine: makeEngine(fetch, hooks),
      audio: BYTES,
      diarization: true,
      keywords: ['Praxil'],
    });
    expect(res.text).toBe('plain transcript');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe('transcription_option_unsupported');
    expect(warnings[0].message).toContain('keywords');
    expect(warnings[0].message).toContain('diarization');
  });

  it('stays silent on a generateContent provider when no structured option was asked for', async () => {
    const fetch: EngineFetch = async () => ({
      status: 200,
      headers: {},
      body: { candidates: [{ content: { parts: [{ text: 'plain' }] } }] },
    });
    const hooks = new HookBus();
    let warned = 0;
    hooks.on('onWarning', () => {
      warned++;
    });
    await transcribe({
      model: 'google/gemini-3.6-flash',
      engine: makeEngine(fetch, hooks),
      audio: BYTES,
      language: 'en',
    });
    expect(warned).toBe(0);
  });
});
