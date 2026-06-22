import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import type { EngineFetch, HttpResponse } from '../../../../src/network/types';
import { MemoryMediaStore } from '../../../../src/plugins/media/memory-store';
import { MediaOutput } from '../../../../src/plugins/media/output';
import type {
  AudioGenRequest,
  ImageGenRequest,
  MediaCapabilities,
  MediaProviderAdapter,
  RawMediaResult,
} from '../../../../src/plugins/media/types';

/** Stub fetch — never actually called by the mock adapter below; required by
 *  the MediaProviderAdapter contract since adapters are pure builders/parsers
 *  but the adapter we mock here returns canned bytes directly. */
const stubFetch: EngineFetch = async (): Promise<HttpResponse> => ({
  status: 200,
  headers: {},
  body: {},
});

function adapter(
  opts: {
    caps?: Partial<MediaCapabilities>;
    imageBytes?: Uint8Array;
    audioBytes?: Uint8Array;
  } = {},
): MediaProviderAdapter {
  const caps: MediaCapabilities = {
    imageGeneration: true,
    imageEditing: false,
    audioGeneration: true,
    videoGeneration: false,
    audioStreaming: false,
    ...opts.caps,
  };
  return {
    name: 'mock',
    capabilities: () => caps,
    async generateImage(_req: ImageGenRequest): Promise<RawMediaResult[]> {
      return [
        {
          data: opts.imageBytes ?? new Uint8Array([1, 2, 3]),
          mimeType: 'image/png',
        },
      ];
    },
    async generateAudio(_req: AudioGenRequest): Promise<RawMediaResult> {
      return {
        data: opts.audioBytes ?? new Uint8Array([1, 2]),
        mimeType: 'audio/mp3',
      };
    },
  };
}

describe('MediaOutput', () => {
  it('generateImage saves to store and emits onMediaGenerated', async () => {
    const hooks = new HookBus();
    const store = new MemoryMediaStore();
    const events: unknown[] = [];
    hooks.on('onMediaGenerated', (c) => {
      events.push(c);
    });
    const m = new MediaOutput({ hooks, mediaStore: store, fetch: stubFetch });
    m.registerProvider('mock', adapter());

    const results = await m.generateImage({ provider: 'mock', prompt: 'a cat' });
    expect(results.length).toBe(1);
    expect(await store.has(results[0].id)).toBe(true);
    expect(events.length).toBe(1);
  });

  it('generateAudio saves to store', async () => {
    const hooks = new HookBus();
    const store = new MemoryMediaStore();
    const m = new MediaOutput({ hooks, mediaStore: store, fetch: stubFetch });
    m.registerProvider('mock', adapter());

    const result = await m.generateAudio({ provider: 'mock', input: 'hello' });
    expect(result.type).toBe('audio');
    expect(await store.has(result.id)).toBe(true);
  });

  it('throws when adapter does not support requested capability', async () => {
    const hooks = new HookBus();
    const m = new MediaOutput({
      hooks,
      mediaStore: new MemoryMediaStore(),
      fetch: stubFetch,
    });
    m.registerProvider('mock', adapter({ caps: { imageGeneration: false } }));

    await expect(m.generateImage({ provider: 'mock', prompt: 'x' })).rejects.toThrow(
      /image generation/,
    );
  });

  it('throws on unknown provider', async () => {
    const m = new MediaOutput({
      hooks: new HookBus(),
      mediaStore: new MemoryMediaStore(),
      fetch: stubFetch,
    });
    await expect(m.generateImage({ provider: 'nope', prompt: 'x' })).rejects.toThrow(
      /No media adapter/,
    );
  });

  it('threads trace (sessionId + minted requestId) onto onMediaGenerated', async () => {
    const hooks = new HookBus();
    let trace: { sessionId?: string; requestId?: string } | undefined;
    hooks.on('onMediaGenerated', (c) => {
      trace = c.trace;
    });
    const out = new MediaOutput({
      hooks,
      mediaStore: new MemoryMediaStore(),
      fetch: stubFetch,
      sessionId: 'sess_m',
    });
    out.registerProvider('mock', adapter());
    await out.generateImage({ provider: 'mock', prompt: 'x' });
    expect(trace?.sessionId).toBe('sess_m');
    expect(trace?.requestId).toMatch(/^req_/);
  });

  it('stamps req.trace onto the adapter fetch calls', async () => {
    let captured: { sessionId?: string; requestId?: string } | undefined;
    const fetch: EngineFetch = async (req) => {
      captured = req.trace;
      return { status: 200, headers: {}, body: {} } as HttpResponse;
    };
    const base = adapter();
    const fetchAdapter: MediaProviderAdapter = {
      ...base,
      async generateImage(_req, f): Promise<RawMediaResult[]> {
        await f({ url: 'x', headers: {}, body: {}, provider: 'mock', model: 'm' });
        return [{ data: new Uint8Array([1]), mimeType: 'image/png' }];
      },
    };
    const out = new MediaOutput({
      hooks: new HookBus(),
      mediaStore: new MemoryMediaStore(),
      fetch,
      sessionId: 'sess_m',
    });
    out.registerProvider('mock', fetchAdapter);
    await out.generateImage({ provider: 'mock', prompt: 'x' });
    expect(captured?.sessionId).toBe('sess_m');
    expect(captured?.requestId).toMatch(/^req_/);
  });
});
