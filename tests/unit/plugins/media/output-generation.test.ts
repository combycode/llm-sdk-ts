import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import type { MediaGeneratedContext } from '../../../../src/bus/hook-map';
import type { Usage } from '../../../../src/llm/types/response';
import type { EngineFetch, HttpResponse } from '../../../../src/network/types';
import { MemoryMediaStore } from '../../../../src/plugins/media/memory-store';
import { MediaOutput } from '../../../../src/plugins/media/output';
import type {
  MediaCapabilities,
  MediaProviderAdapter,
  RawMediaResult,
} from '../../../../src/plugins/media/types';

const stubFetch: EngineFetch = async (): Promise<HttpResponse> => ({
  status: 200,
  headers: {},
  body: {},
});

function usage(over: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...over,
  };
}

interface AdapterOpts {
  caps?: Partial<MediaCapabilities>;
  image?: RawMediaResult[];
  audio?: RawMediaResult;
  edited?: RawMediaResult[];
  /** Omit editImage entirely — an adapter can advertise the cap and still not
   *  implement it, which must be caught. */
  noEditFn?: boolean;
}

function adapter(opts: AdapterOpts = {}): MediaProviderAdapter {
  const caps: MediaCapabilities = {
    imageGeneration: true,
    imageEditing: true,
    audioGeneration: true,
    videoGeneration: false,
    audioStreaming: false,
    ...opts.caps,
  };
  const a: MediaProviderAdapter = {
    name: 'mock',
    capabilities: () => caps,
    async generateImage() {
      return opts.image ?? [{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }];
    },
    async generateAudio() {
      return opts.audio ?? { data: new Uint8Array([1, 2]), mimeType: 'audio/mp3' };
    },
  };
  if (!opts.noEditFn) {
    a.editImage = async () => opts.edited ?? [{ data: new Uint8Array([9]), mimeType: 'image/png' }];
  }
  return a;
}

interface Rig {
  hooks: HookBus;
  store: MemoryMediaStore;
  out: MediaOutput;
  events: MediaGeneratedContext[];
}

function rig(opts: AdapterOpts = {}): Rig {
  const hooks = new HookBus();
  const store = new MemoryMediaStore();
  const events: MediaGeneratedContext[] = [];
  hooks.on('onMediaGenerated', (c) => {
    events.push(c);
  });
  const out = new MediaOutput({ hooks, mediaStore: store, fetch: stubFetch });
  out.registerProvider('mock', adapter(opts));
  return { hooks, store, out, events };
}

describe('MediaOutput — capability gates', () => {
  it('refuses image editing when the adapter does not advertise it', async () => {
    const r = rig({ caps: { imageEditing: false } });
    await expect(
      r.out.editImage({
        provider: 'mock',
        prompt: 'x',
        sourceImage: { type: 'base64', data: 'AA==', mimeType: 'image/png' },
      }),
    ).rejects.toThrow('Provider mock does not support image editing');
  });

  it('refuses image editing when the adapter advertises it but has no editImage', async () => {
    const r = rig({ noEditFn: true });
    await expect(
      r.out.editImage({
        provider: 'mock',
        prompt: 'x',
        sourceImage: { type: 'base64', data: 'AA==', mimeType: 'image/png' },
      }),
    ).rejects.toThrow('does not support image editing');
  });

  it('refuses audio generation when the adapter does not advertise it', async () => {
    const r = rig({ caps: { audioGeneration: false } });
    await expect(r.out.generateAudio({ provider: 'mock', input: 'hi' })).rejects.toThrow(
      'Provider mock does not support audio generation',
    );
  });

  it('reports the unknown provider by name and how to fix it', async () => {
    const r = rig();
    await expect(
      r.out.editImage({
        provider: 'ghost',
        prompt: 'x',
        sourceImage: { type: 'base64', data: 'AA==', mimeType: 'image/png' },
      }),
    ).rejects.toThrow('No media adapter registered for provider: ghost');
  });
});

describe('MediaOutput — stored metadata', () => {
  it('stores every field the provider reported about an image', async () => {
    const r = rig({
      image: [
        {
          data: new Uint8Array([1, 2, 3, 4]),
          mimeType: 'image/webp',
          width: 1024,
          height: 768,
          revisedPrompt: 'a very fluffy cat',
        },
      ],
    });
    const [res] = await r.out.generateImage({
      provider: 'mock',
      model: 'gpt-image-1',
      prompt: 'a cat',
      params: { resolution: '1024x768' },
    });

    expect(res.id).toMatch(/^img_/);
    expect(res.type).toBe('image');
    expect(res.mimeType).toBe('image/webp');

    const stored = await r.store.load(res.id);
    expect(stored?.data).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(stored?.meta).toMatchObject({
      id: res.id,
      type: 'image',
      mimeType: 'image/webp',
      size: 4,
      provider: 'mock',
      model: 'gpt-image-1',
      prompt: 'a cat',
      revisedPrompt: 'a very fluffy cat',
      width: 1024,
      height: 768,
    });
    expect(typeof stored?.meta.createdAt).toBe('number');
  });

  it('records the TTS input text as the prompt for audio', async () => {
    const r = rig({
      audio: {
        data: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/wav',
        durationMs: 2500,
        sampleRate: 24_000,
      },
    });
    const res = await r.out.generateAudio({
      provider: 'mock',
      model: 'tts-1',
      input: 'hello world',
    });

    expect(res.id).toMatch(/^aud_/);
    expect(res.type).toBe('audio');
    const meta = await r.store.getMeta(res.id);
    expect(meta).toMatchObject({
      type: 'audio',
      mimeType: 'audio/wav',
      size: 3,
      prompt: 'hello world',
      durationMs: 2500,
      sampleRate: 24_000,
      model: 'tts-1',
    });
  });

  it('keeps a provider-hosted sourceUrl alongside the bytes', async () => {
    const r = rig({
      image: [{ data: new Uint8Array(), mimeType: 'image/png', sourceUrl: 'https://cdn/x.png' }],
    });
    const [res] = await r.out.generateImage({ provider: 'mock', prompt: 'x' });
    expect((await r.store.getMeta(res.id))?.sourceUrl).toBe('https://cdn/x.png');
    // Size follows the actual bytes held, which may be none when the asset is
    // only reachable by URL.
    expect((await r.store.getMeta(res.id))?.size).toBe(0);
  });

  it('gives every item of a multi-image batch its own id and stored bytes', async () => {
    const r = rig({
      image: [
        { data: new Uint8Array([1]), mimeType: 'image/png' },
        { data: new Uint8Array([2, 2]), mimeType: 'image/png' },
        { data: new Uint8Array([3, 3, 3]), mimeType: 'image/png' },
      ],
    });
    const results = await r.out.generateImage({ provider: 'mock', prompt: 'x', params: { n: 3 } });
    expect(results.length).toBe(3);
    expect(new Set(results.map((x) => x.id)).size).toBe(3);
    expect((await r.store.load(results[1].id))?.data).toEqual(new Uint8Array([2, 2]));
    expect(await r.store.list()).toEqual(results.map((x) => x.id));
  });

  it('editImage stores the edited bytes and returns image results', async () => {
    const r = rig({
      edited: [{ data: new Uint8Array([7, 7]), mimeType: 'image/png', revisedPrompt: 'edited' }],
    });
    const results = await r.out.editImage({
      provider: 'mock',
      model: 'gpt-image-1',
      prompt: 'add a hat',
      sourceImage: { type: 'base64', data: 'AA==', mimeType: 'image/png' },
      params: { resolution: '512x512' },
    });
    expect(results.length).toBe(1);
    expect(results[0].id).toMatch(/^img_/);
    expect((await r.store.load(results[0].id))?.data).toEqual(new Uint8Array([7, 7]));
    expect(r.events[0]).toMatchObject({
      mediaType: 'image',
      count: 1,
      resolution: '512x512',
      model: 'gpt-image-1',
    });
  });
});

// The Python port of this class shipped every image and video at $0.00 because
// these fields never reached the cost collector. They are the whole billing
// input — assert each one explicitly.
describe('MediaOutput — cost-bearing event', () => {
  it('carries provider, model, media type, count and source for an image batch', async () => {
    const r = rig({
      image: [
        { data: new Uint8Array([1]), mimeType: 'image/png' },
        { data: new Uint8Array([2]), mimeType: 'image/png' },
      ],
    });
    await r.out.generateImage({
      provider: 'mock',
      model: 'gpt-image-1',
      prompt: 'x',
      params: { resolution: '1024x1024' },
    });

    expect(r.events.length).toBe(1);
    const e = r.events[0];
    expect(e.provider).toBe('mock');
    expect(e.model).toBe('gpt-image-1');
    expect(e.mediaType).toBe('image');
    expect(e.count).toBe(2);
    expect(e.resolution).toBe('1024x1024');
    expect(e.source).toBe('media_output');
    expect(e.stored).toBe(true);
  });

  it('emits ONE event per call covering the whole batch, not one per item', async () => {
    const r = rig({
      image: [
        { data: new Uint8Array([1]), mimeType: 'image/png' },
        { data: new Uint8Array([2]), mimeType: 'image/png' },
        { data: new Uint8Array([3]), mimeType: 'image/png' },
      ],
    });
    await r.out.generateImage({ provider: 'mock', prompt: 'x' });
    expect(r.events.length).toBe(1);
    expect(r.events[0].count).toBe(3);
  });

  it('sums token usage across the batch so token-priced media bills in full', async () => {
    const r = rig({
      image: [
        {
          data: new Uint8Array([1]),
          mimeType: 'image/png',
          usage: usage({ inputTokens: 10, outputTokens: 100, totalTokens: 110 }),
        },
        {
          data: new Uint8Array([2]),
          mimeType: 'image/png',
          usage: usage({
            inputTokens: 5,
            outputTokens: 50,
            totalTokens: 55,
            cachedTokens: 2,
            cacheWriteTokens: 3,
            reasoningTokens: 4,
          }),
        },
      ],
    });
    await r.out.generateImage({ provider: 'mock', model: 'gpt-image-1', prompt: 'x' });

    expect(r.events[0].usage).toEqual({
      inputTokens: 15,
      outputTokens: 150,
      totalTokens: 165,
      cachedTokens: 2,
      cacheWriteTokens: 3,
      reasoningTokens: 4,
    });
  });

  it('counts an item that reported usage even when others did not', async () => {
    const r = rig({
      image: [
        { data: new Uint8Array([1]), mimeType: 'image/png' },
        {
          data: new Uint8Array([2]),
          mimeType: 'image/png',
          usage: usage({ inputTokens: 7, totalTokens: 7 }),
        },
      ],
    });
    await r.out.generateImage({ provider: 'mock', prompt: 'x' });
    expect(r.events[0].usage).toMatchObject({ inputTokens: 7, totalTokens: 7 });
  });

  it('leaves usage undefined for unit-priced media so per-unit rates apply', async () => {
    const r = rig();
    await r.out.generateImage({ provider: 'mock', prompt: 'x' });
    expect(r.events[0].usage).toBeUndefined();
  });

  it('bills TTS on the input text it was given', async () => {
    const r = rig();
    await r.out.generateAudio({ provider: 'mock', model: 'tts-1', input: 'hello world' });
    const e = r.events[0];
    expect(e.mediaType).toBe('audio');
    expect(e.textInput).toBe('hello world');
    expect(e.count).toBe(1);
    expect(e.model).toBe('tts-1');
  });

  it('does not attach textInput to an image batch', async () => {
    const r = rig();
    await r.out.generateImage({ provider: 'mock', prompt: 'a cat' });
    expect(r.events[0].textInput).toBeUndefined();
  });

  it('reports generated duration in seconds, summed across the batch', async () => {
    const r = rig({
      audio: { data: new Uint8Array([1]), mimeType: 'audio/mp3', durationMs: 4500 },
    });
    await r.out.generateAudio({ provider: 'mock', input: 'hi' });
    expect(r.events[0].durationSeconds).toBe(4.5);
  });

  it('omits durationSeconds when nothing reported a duration', async () => {
    const r = rig();
    await r.out.generateImage({ provider: 'mock', prompt: 'x' });
    expect(r.events[0].durationSeconds).toBeUndefined();
  });

  it('omits resolution when the caller asked for none', async () => {
    const r = rig();
    await r.out.generateImage({ provider: 'mock', prompt: 'x' });
    expect(r.events[0].resolution).toBeUndefined();
  });

  it('forwards provider cost evidence from whichever item carries it', async () => {
    const r = rig({
      image: [
        { data: new Uint8Array([1]), mimeType: 'image/png' },
        {
          data: new Uint8Array([2]),
          mimeType: 'image/png',
          providerMeta: { billed_cost_usd: 0.04 },
        },
      ],
    });
    await r.out.generateImage({ provider: 'mock', prompt: 'x' });
    expect(r.events[0].providerEvidence).toEqual({ billed_cost_usd: 0.04 });
  });

  it('omits provider evidence when no item carried any', async () => {
    const r = rig();
    await r.out.generateImage({ provider: 'mock', prompt: 'x' });
    expect(r.events[0].providerEvidence).toBeUndefined();
  });

  it('describes each saved item as a typed media part carrying its id', async () => {
    const r = rig({
      image: [
        { data: new Uint8Array([1]), mimeType: 'image/png' },
        { data: new Uint8Array([2]), mimeType: 'image/webp' },
      ],
    });
    const results = await r.out.generateImage({ provider: 'mock', prompt: 'x' });
    expect(r.events[0].parts).toEqual([
      { type: 'image_output', mediaId: results[0].id, mimeType: 'image/png' },
      { type: 'image_output', mediaId: results[1].id, mimeType: 'image/webp' },
    ]);
  });

  it('tags an audio part as audio_output', async () => {
    const r = rig();
    const res = await r.out.generateAudio({ provider: 'mock', input: 'hi' });
    expect(r.events[0].parts).toEqual([
      { type: 'audio_output', mediaId: res.id, mimeType: 'audio/mp3' },
    ]);
  });

  it('emits only after the bytes are in the store', async () => {
    const hooks = new HookBus();
    const store = new MemoryMediaStore();
    const storedAtEmit: boolean[] = [];
    const out = new MediaOutput({ hooks, mediaStore: store, fetch: stubFetch });
    hooks.on('onMediaGenerated', async (c) => {
      const id = (c.parts[0] as { mediaId: string }).mediaId;
      storedAtEmit.push(await store.has(id));
    });
    out.registerProvider('mock', adapter());
    await out.generateImage({ provider: 'mock', prompt: 'x' });
    expect(storedAtEmit).toEqual([true]);
  });

  it('threads the op trace onto the event for every media kind', async () => {
    const hooks = new HookBus();
    const traces: Array<{ sessionId?: string; requestId?: string } | undefined> = [];
    hooks.on('onMediaGenerated', (c) => {
      traces.push(c.trace);
    });
    const out = new MediaOutput({
      hooks,
      mediaStore: new MemoryMediaStore(),
      fetch: stubFetch,
      sessionId: 'sess_1',
    });
    out.registerProvider('mock', adapter());
    await out.generateAudio({ provider: 'mock', input: 'hi' });
    await out.editImage({
      provider: 'mock',
      prompt: 'x',
      sourceImage: { type: 'base64', data: 'AA==', mimeType: 'image/png' },
    });

    expect(traces.length).toBe(2);
    for (const t of traces) {
      expect(t?.sessionId).toBe('sess_1');
      expect(t?.requestId).toMatch(/^req_/);
    }
    // Each op mints its own request id.
    expect(traces[0]?.requestId).not.toBe(traces[1]?.requestId);
  });
});
