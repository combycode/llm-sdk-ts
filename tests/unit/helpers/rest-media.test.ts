/** createMediaOutput() — the defaulting wrapper around MediaOutput.
 *
 *  Behaviour pinned here:
 *   - `model` may be namespaced ("openai/gpt-image-1") or bare + `provider`;
 *     a namespaced id supplies BOTH halves and the bare id keeps `provider`.
 *   - Caller-supplied `providers` adapters are registered and win over the
 *     auto-built one, so no API key is required for a provider you brought
 *     yourself (the key check must not fire in that case).
 *   - Every wrapper call fills provider + model from the configured defaults,
 *     and a per-call `provider` / `model` overrides them.
 *   - The model id is translated through the catalog on the way out — the same
 *     slug→callable translation createLLM does — so a slug never reaches the
 *     provider unchanged when the catalog knows a different callable name.
 *   - With no default provider and none on the call, the wrappers throw rather
 *     than sending a request with `provider: undefined`.
 *   - generateImage/generateVideo default `prompt` to '' and generateAudio
 *     defaults `input` to '', so a bare call is still a well-formed request.
 *
 *  No network: a fake MediaProviderAdapter records the requests it is handed
 *  and the store is an in-memory one. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { createMediaOutput } from '../../../src/helpers/media';
import { MemoryMediaStore } from '../../../src/plugins/media/memory-store';
import { MediaOutput } from '../../../src/plugins/media/output';
import { HookBus } from '../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../src/catalog/catalog';
import type { EngineHandle } from '../../../src/helpers/engine';
import type {
  AudioGenRequest,
  ImageEditRequest,
  ImageGenRequest,
  MediaProviderAdapter,
  VideoGenRequest,
} from '../../../src/plugins/media/types';

// ─── Recording adapter ────────────────────────────────────────────────────────

interface Recorder {
  adapter: MediaProviderAdapter;
  image: ImageGenRequest[];
  edit: ImageEditRequest[];
  audio: AudioGenRequest[];
  video: VideoGenRequest[];
}

function recordingAdapter(name = 'openai'): Recorder {
  const rec: Recorder = {
    image: [],
    edit: [],
    audio: [],
    video: [],
    adapter: undefined as unknown as MediaProviderAdapter,
  };
  const bytes = new Uint8Array([1, 2, 3]);
  rec.adapter = {
    name,
    capabilities: () => ({
      imageGeneration: true,
      imageEditing: true,
      audioGeneration: true,
      videoGeneration: true,
      audioStreaming: false,
      videoExtension: true,
    }),
    async generateImage(req) {
      rec.image.push(req);
      return [{ data: bytes, mimeType: 'image/png' }];
    },
    async editImage(req) {
      rec.edit.push(req);
      return [{ data: bytes, mimeType: 'image/png' }];
    },
    async generateAudio(req) {
      rec.audio.push(req);
      return { data: bytes, mimeType: 'audio/mpeg' };
    },
    async submitVideo(req) {
      rec.video.push(req);
      return 'op-1';
    },
    async getVideoStatus() {
      return { status: 'completed' as const };
    },
    async downloadVideo() {
      return { data: bytes, mimeType: 'video/mp4' };
    },
  };
  return rec;
}

// ─── Stub engine ──────────────────────────────────────────────────────────────

function stubEngine(catalog = new ModelCatalog()): EngineHandle {
  return {
    hooks: new HookBus(),
    catalog,
    fetch: async () => ({ status: 200, headers: {}, body: {} }),
    apiKeys: {},
    sessionId: 'sess_media_test',
  } as unknown as EngineHandle;
}

let engine: EngineHandle;
beforeEach(() => {
  engine = stubEngine();
});

function handleWith(rec: Recorder, opts: Record<string, unknown> = {}) {
  return createMediaOutput({
    engine,
    store: new MemoryMediaStore(),
    providers: { openai: rec.adapter },
    ...opts,
  });
}

// ─── Defaults resolution ──────────────────────────────────────────────────────

describe('createMediaOutput — default provider/model resolution', () => {
  it('splits a namespaced model into provider + model', async () => {
    const rec = recordingAdapter();
    const h = handleWith(rec, { model: 'openai/gpt-image-1' });
    await h.generateImage({ prompt: 'a cat' });
    expect(rec.image[0]).toMatchObject({ provider: 'openai', model: 'gpt-image-1', prompt: 'a cat' });
  });

  it('keeps a bare model and takes the provider from `provider`', async () => {
    const rec = recordingAdapter();
    const h = handleWith(rec, { model: 'gpt-image-1', provider: 'openai' });
    await h.generateImage({ prompt: 'x' });
    expect(rec.image[0]).toMatchObject({ provider: 'openai', model: 'gpt-image-1' });
  });

  it('leaves the model undefined when only a provider is configured', async () => {
    const rec = recordingAdapter();
    const h = handleWith(rec, { provider: 'openai' });
    await h.generateImage({ prompt: 'x' });
    expect(rec.image[0].provider).toBe('openai');
    expect(rec.image[0].model).toBeUndefined();
  });

  it('a caller-supplied adapter removes the need for an API key', () => {
    const rec = recordingAdapter();
    expect(() => handleWith(rec, { model: 'openai/gpt-image-1' })).not.toThrow();
  });

  it('exposes the underlying MediaOutput as `raw`', () => {
    const h = handleWith(recordingAdapter(), { model: 'openai/gpt-image-1' });
    expect(h.raw).toBeInstanceOf(MediaOutput);
  });

  it('translates the configured slug to the provider-callable id via the catalog', async () => {
    const catalog = new ModelCatalog();
    catalog.set('openai', 'gpt-image-1', {
      pricing: {},
      providerModelName: 'gpt-image-1-2025-preview',
    });
    engine = stubEngine(catalog);
    const rec = recordingAdapter();
    const h = handleWith(rec, { model: 'openai/gpt-image-1' });
    await h.generateImage({ prompt: 'x' });
    expect(rec.image[0].model).toBe('gpt-image-1-2025-preview');
  });
});

// ─── Per-call overrides + defaults ────────────────────────────────────────────

describe('createMediaOutput — wrapper calls', () => {
  it('generateImage defaults an omitted prompt to the empty string', async () => {
    const rec = recordingAdapter();
    const h = handleWith(rec, { model: 'openai/gpt-image-1' });
    await h.generateImage();
    expect(rec.image[0].prompt).toBe('');
    expect(rec.image[0].model).toBe('gpt-image-1');
  });

  it('generateImage forwards params and a per-call model override', async () => {
    const rec = recordingAdapter();
    const h = handleWith(rec, { model: 'openai/gpt-image-1' });
    await h.generateImage({ prompt: 'p', model: 'other-image-model', params: { n: 2 } });
    expect(rec.image[0]).toMatchObject({ model: 'other-image-model', params: { n: 2 } });
  });

  it('generateAudio defaults an omitted input to the empty string and returns one result', async () => {
    const rec = recordingAdapter();
    const h = handleWith(rec, { model: 'openai/gpt-4o-mini-tts' });
    const out = await h.generateAudio();
    expect(rec.audio[0]).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini-tts', input: '' });
    expect(out.type).toBe('audio');
    expect(out.mimeType).toBe('audio/mpeg');
  });

  it('generateAudio passes the caller input through', async () => {
    const rec = recordingAdapter();
    const h = handleWith(rec, { model: 'openai/gpt-4o-mini-tts' });
    await h.generateAudio({ input: 'read this aloud', params: { voice: 'alloy' } });
    expect(rec.audio[0]).toMatchObject({ input: 'read this aloud', params: { voice: 'alloy' } });
  });

  it('editImage fills provider + model and keeps the source image', async () => {
    const rec = recordingAdapter();
    const h = handleWith(rec, { model: 'openai/gpt-image-1' });
    const source = { type: 'url' as const, url: 'https://example.invalid/a.png' };
    const out = await h.editImage({ prompt: 'make it blue', sourceImage: source });
    expect(rec.edit[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-image-1',
      prompt: 'make it blue',
      sourceImage: source,
    });
    expect(out).toHaveLength(1);
  });

  it('generateVideo defaults the prompt and returns the downloaded result', async () => {
    const rec = recordingAdapter();
    const h = handleWith(rec, { model: 'openai/sora-2' });
    const out = await h.generateVideo();
    expect(rec.video[0]).toMatchObject({ provider: 'openai', model: 'sora-2', prompt: '' });
    expect(out.type).toBe('video');
    expect(out.mimeType).toBe('video/mp4');
  });

  it('a per-call provider overrides the configured default', async () => {
    const openai = recordingAdapter('openai');
    const xai = recordingAdapter('xai');
    const h = createMediaOutput({
      engine,
      store: new MemoryMediaStore(),
      providers: { openai: openai.adapter, xai: xai.adapter },
      model: 'openai/gpt-image-1',
    });
    await h.generateImage({ prompt: 'p', provider: 'xai' });
    expect(openai.image).toHaveLength(0);
    expect(xai.image[0].provider).toBe('xai');
  });
});

// ─── Missing provider ─────────────────────────────────────────────────────────

describe('createMediaOutput — provider is required at call time', () => {
  function noDefault() {
    return createMediaOutput({
      engine,
      store: new MemoryMediaStore(),
      providers: { openai: recordingAdapter().adapter },
    });
  }

  // The throw is SYNCHRONOUS -- requireProvider runs before the wrapper hands
  // back a promise, so a caller who forgot the provider gets the error at the
  // call site rather than as an unhandled rejection later.
  it('generateImage throws synchronously when no provider is configured or passed', () => {
    expect(() => noDefault().generateImage({ prompt: 'x' })).toThrow(
      /provider not set on call and no default `model` was configured/,
    );
  });

  it('generateAudio throws synchronously when no provider is configured or passed', () => {
    expect(() => noDefault().generateAudio({ input: 'x' })).toThrow(/provider not set/);
  });

  it('editImage throws synchronously when no provider is configured or passed', () => {
    expect(() =>
      noDefault().editImage({ prompt: 'x', sourceImage: { type: 'url', url: 'https://a.invalid/b' } }),
    ).toThrow(/provider not set/);
  });

  it('generateVideo throws synchronously when no provider is configured or passed', () => {
    expect(() => noDefault().generateVideo({ prompt: 'x' })).toThrow(/provider not set/);
  });

  it('a call-level provider is enough without any configured default', async () => {
    const rec = recordingAdapter();
    const h = createMediaOutput({
      engine,
      store: new MemoryMediaStore(),
      providers: { openai: rec.adapter },
    });
    await h.generateImage({ prompt: 'x', provider: 'openai' });
    expect(rec.image[0].provider).toBe('openai');
  });
});
