/** transcribe() — key resolution, source loading, and WAV chunk walking.
 *  (Adapter request/response shapes live in transcribe.test.ts.)
 *
 *  Behaviour pinned here:
 *   - A missing key throws before any HTTP, naming transcribe, the provider,
 *     and both ways to supply a key.
 *   - `audio` may be raw bytes, an {data, mimeType} pair, or a path. A path is
 *     loaded from disk and its MIME decided by extension; anything that does
 *     not load as AUDIO is rejected with an explicit error rather than being
 *     sent as whatever it happened to be.
 *   - An explicit mimeType overrides the one detected while loading.
 *   - WAV duration is derived by WALKING the RIFF sub-chunks, not by assuming
 *     `data` sits at offset 36 — real recorders put LIST/fact chunks first,
 *     and a fixed offset silently mis-prices those files. The walk stops
 *     (returning undefined) rather than looping when no `data` chunk exists.
 *
 *  No network: engine.fetch is a stub. Temp files are written under
 *  tests/.tmp-transcribe-rest and removed afterwards. */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { deriveWavDuration, transcribe } from '../../../src/helpers/transcribe';
import { HookBus } from '../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../src/catalog/catalog';
import type { EngineHandle } from '../../../src/helpers/engine';
import type { EngineFetch, HttpRequest, HttpResponse } from '../../../src/network/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DIR = 'tests/.tmp-transcribe-rest';
const WAV_PATH = `${DIR}/sample.wav`;
const PNG_PATH = `${DIR}/not-audio.png`;

/** A minimal 44-byte WAV: 8kHz mono 8-bit, `data` chunk right at offset 36. */
function wavHeader(dataSize: number, extraChunks: Uint8Array = new Uint8Array(0)): Uint8Array {
  const head = new Uint8Array(36 + extraChunks.length + 8 + dataSize);
  const view = new DataView(head.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) head[offset + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, head.length - 8, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 8000, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  head.set(extraChunks, 36);
  ascii(36 + extraChunks.length, 'data');
  view.setUint32(36 + extraChunks.length + 4, dataSize, true);
  return head;
}

/** A `LIST` sub-chunk of `payload` bytes — the thing real recorders put before `data`. */
function listChunk(payload: number): Uint8Array {
  const chunk = new Uint8Array(8 + payload);
  const view = new DataView(chunk.buffer);
  for (let i = 0; i < 4; i++) chunk[i] = 'LIST'.charCodeAt(i);
  view.setUint32(4, payload, true);
  return chunk;
}

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(WAV_PATH, wavHeader(8000));
  // PNG magic bytes so the loader classifies it as an image, not audio.
  writeFileSync(PNG_PATH, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
});

afterAll(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {}
});

function capturingFetch(body: unknown): { fetch: EngineFetch; last: () => HttpRequest | undefined } {
  let captured: HttpRequest | undefined;
  const fetch: EngineFetch = async (req): Promise<HttpResponse> => {
    captured = req;
    return { status: 200, headers: {}, body };
  };
  return { fetch, last: () => captured };
}

function makeEngine(fetch: EngineFetch, apiKeys: Record<string, string> = { openai: 'k' }): EngineHandle {
  const catalog = new ModelCatalog();
  catalog.set('openai', 'gpt-4o-transcribe', { pricing: { perMinute: 0.006 } });
  return { apiKeys, fetch, hooks: new HookBus(), catalog } as unknown as EngineHandle;
}

// ─── Key resolution ───────────────────────────────────────────────────────────

describe('transcribe() — API key resolution', () => {
  it('throws before any HTTP when no key is available', async () => {
    const { fetch, last } = capturingFetch({ text: 'x' });
    await expect(
      transcribe({
        model: 'openai/gpt-4o-transcribe',
        engine: makeEngine(fetch, {}),
        audio: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow(
      /transcribe: no API key for provider "openai"\. Pass apiKey or set engine\.apiKeys\["openai"\]\./,
    );
    expect(last()).toBeUndefined();
  });

  it('accepts a direct apiKey when the engine has none', async () => {
    const { fetch } = capturingFetch({ text: 'ok' });
    const res = await transcribe({
      model: 'openai/gpt-4o-transcribe',
      apiKey: 'direct',
      engine: makeEngine(fetch, {}),
      audio: new Uint8Array([1, 2, 3]),
    });
    expect(res.text).toBe('ok');
  });
});

// ─── Audio source loading ─────────────────────────────────────────────────────

describe('transcribe() — audio sources', () => {
  it('loads a path from disk and sends its bytes', async () => {
    const { fetch, last } = capturingFetch({ text: 'from file' });
    const res = await transcribe({
      model: 'openai/gpt-4o-transcribe',
      engine: makeEngine(fetch),
      audio: WAV_PATH,
    });
    expect(res.text).toBe('from file');
    const file = (last()?.body as FormData).get('file') as File;
    expect(file.size).toBe(8044); // the WAV we wrote, byte for byte
  });

  it('an explicit mimeType overrides the one detected while loading', async () => {
    const { fetch, last } = capturingFetch({ text: 'x' });
    await transcribe({
      model: 'openai/gpt-4o-transcribe',
      engine: makeEngine(fetch),
      audio: { data: WAV_PATH, mimeType: 'audio/mpeg' },
    });
    const file = (last()?.body as FormData).get('file') as File;
    expect(file.type).toBe('audio/mpeg');
  });

  it('rejects a path that does not load as audio', async () => {
    const { fetch } = capturingFetch({ text: 'x' });
    await expect(
      transcribe({
        model: 'openai/gpt-4o-transcribe',
        engine: makeEngine(fetch),
        audio: PNG_PATH,
      }),
    ).rejects.toThrow('transcribe: could not load audio bytes from the given source');
  });

  it('raw bytes are sent as audio/wav unless a mimeType says otherwise', async () => {
    const { fetch, last } = capturingFetch({ text: 'x' });
    await transcribe({
      model: 'openai/gpt-4o-transcribe',
      engine: makeEngine(fetch),
      audio: new Uint8Array([1, 2, 3]),
    });
    expect(((last()?.body as FormData).get('file') as File).type).toBe('audio/wav');

    const second = capturingFetch({ text: 'x' });
    await transcribe({
      model: 'openai/gpt-4o-transcribe',
      engine: makeEngine(second.fetch),
      audio: { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/ogg' },
    });
    expect(((second.last()?.body as FormData).get('file') as File).type).toBe('audio/ogg');
  });
});

// ─── WAV sub-chunk walking ────────────────────────────────────────────────────

describe('deriveWavDuration — RIFF sub-chunk walk', () => {
  it('reads a data chunk that sits right at offset 36', () => {
    // 8000 bytes at 8000 Hz, 1 channel, 8 bits = exactly 1 second.
    expect(deriveWavDuration(wavHeader(8000), 'audio/wav')).toBeCloseTo(1, 6);
  });

  it('walks PAST a leading LIST chunk to find the real data chunk', () => {
    const bytes = wavHeader(4000, listChunk(26));
    expect(deriveWavDuration(bytes, 'audio/wav')).toBeCloseTo(0.5, 6);
  });

  it('walks past several intervening chunks', () => {
    const first = listChunk(12);
    const second = listChunk(4);
    const both = new Uint8Array(first.length + second.length);
    both.set(first, 0);
    both.set(second, first.length);
    expect(deriveWavDuration(wavHeader(8000, both), 'audio/wav')).toBeCloseTo(1, 6);
  });

  it('returns undefined when the walk runs off the end without finding `data`', () => {
    const bytes = wavHeader(0, listChunk(0));
    // Overwrite the 'data' marker so the walk never matches and must terminate.
    bytes[44] = 'x'.charCodeAt(0);
    expect(deriveWavDuration(bytes, 'audio/wav')).toBeUndefined();
  });

  it('returns undefined for a non-WAV mime type without inspecting the bytes', () => {
    expect(deriveWavDuration(wavHeader(8000), 'audio/mpeg')).toBeUndefined();
  });
});
