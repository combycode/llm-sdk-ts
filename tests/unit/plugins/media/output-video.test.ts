import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import type { MediaGeneratedContext, MediaProgressContext } from '../../../../src/bus/hook-map';
import type { EngineFetch, HttpResponse } from '../../../../src/network/types';
import { MemoryMediaStore } from '../../../../src/plugins/media/memory-store';
import { MediaOutput } from '../../../../src/plugins/media/output';
import type {
  MediaCapabilities,
  MediaProviderAdapter,
  RawMediaResult,
  VideoStatus,
} from '../../../../src/plugins/media/types';

const stubFetch: EngineFetch = async (): Promise<HttpResponse> => ({
  status: 200,
  headers: {},
  body: {},
});

interface VideoAdapter extends MediaProviderAdapter {
  submitted: number;
  statusCalls: number;
  downloads: number;
  cancels: number;
  fetchesSeen: EngineFetch[];
  /** Status returned per poll, in order; the last entry repeats. */
  statuses: VideoStatus[];
  download: RawMediaResult;
}

interface VideoAdapterOpts {
  caps?: Partial<MediaCapabilities>;
  statuses?: VideoStatus[];
  download?: RawMediaResult;
  /** Drop the async-video helpers while still advertising videoGeneration. */
  partial?: boolean;
}

function videoAdapter(opts: VideoAdapterOpts = {}): VideoAdapter {
  const caps: MediaCapabilities = {
    imageGeneration: false,
    imageEditing: false,
    audioGeneration: false,
    videoGeneration: true,
    audioStreaming: false,
    ...opts.caps,
  };
  const a: VideoAdapter = {
    name: 'mock',
    capabilities: () => caps,
    submitted: 0,
    statusCalls: 0,
    downloads: 0,
    cancels: 0,
    fetchesSeen: [],
    statuses: opts.statuses ?? [{ status: 'completed' }],
    download: opts.download ?? { data: new Uint8Array([1, 2, 3]), mimeType: 'video/mp4' },
    async generateImage() {
      throw new Error('unused');
    },
    async generateAudio() {
      throw new Error('unused');
    },
    async submitVideo(_req, fetch) {
      a.submitted++;
      a.fetchesSeen.push(fetch);
      return 'op_1';
    },
  };
  if (!opts.partial) {
    a.getVideoStatus = async (_id, fetch) => {
      a.fetchesSeen.push(fetch);
      const s = a.statuses[Math.min(a.statusCalls, a.statuses.length - 1)];
      a.statusCalls++;
      return s;
    };
    a.downloadVideo = async (_id, fetch) => {
      a.downloads++;
      a.fetchesSeen.push(fetch);
      return a.download;
    };
    a.cancelVideo = async (_id, fetch) => {
      a.cancels++;
      a.fetchesSeen.push(fetch);
    };
  }
  return a;
}

interface Rig {
  hooks: HookBus;
  store: MemoryMediaStore;
  out: MediaOutput;
  adapter: VideoAdapter;
  generated: MediaGeneratedContext[];
  progress: MediaProgressContext[];
  errors: Array<{ id: string; error: string; operationId?: string; provider: string }>;
}

function rig(
  opts: VideoAdapterOpts & { pollIntervalMs?: number; maxPollWaitMs?: number } = {},
): Rig {
  const hooks = new HookBus();
  const store = new MemoryMediaStore();
  const generated: MediaGeneratedContext[] = [];
  const progress: MediaProgressContext[] = [];
  const errors: Rig['errors'] = [];
  hooks.on('onMediaGenerated', (c) => {
    generated.push(c);
  });
  hooks.on('onMediaProgress', (c) => {
    progress.push(c);
  });
  hooks.on('onMediaError', (c) => {
    errors.push({ id: c.id, error: c.error, operationId: c.operationId, provider: c.provider });
  });
  const adapter = videoAdapter(opts);
  const out = new MediaOutput({
    hooks,
    mediaStore: store,
    fetch: stubFetch,
    sessionId: 'sess_v',
    // Zero poll interval: the loop yields to the macrotask queue instead of
    // waiting, so the test is driven by the status script alone.
    config: { pollIntervalMs: opts.pollIntervalMs ?? 0, maxPollWaitMs: opts.maxPollWaitMs },
  });
  out.registerProvider('mock', adapter);
  return { hooks, store, out, adapter, generated, progress, errors };
}

describe('MediaOutput.generateVideo — gates', () => {
  it('refuses a provider that does not advertise video generation', async () => {
    const r = rig({ caps: { videoGeneration: false } });
    await expect(r.out.generateVideo({ provider: 'mock', prompt: 'x' })).rejects.toThrow(
      'Provider mock does not support video generation',
    );
    expect(r.adapter.submitted).toBe(0);
  });

  it('refuses a provider that advertises video generation but cannot submit', async () => {
    const hooks = new HookBus();
    const out = new MediaOutput({ hooks, mediaStore: new MemoryMediaStore(), fetch: stubFetch });
    const a = videoAdapter();
    delete (a as { submitVideo?: unknown }).submitVideo;
    out.registerProvider('mock', a);
    await expect(out.generateVideo({ provider: 'mock', prompt: 'x' })).rejects.toThrow(
      'does not support video generation',
    );
  });

  it('refuses a sourceVideo on a provider without videoExtension, rather than silently generating', async () => {
    const r = rig();
    await expect(
      r.out.generateVideo({
        provider: 'mock',
        prompt: 'keep going',
        sourceVideo: { type: 'url', url: 'https://cdn/clip.mp4' },
      }),
    ).rejects.toThrow('Provider mock does not support video extension/editing');
    // Nothing was submitted — the refusal happens before any provider call.
    expect(r.adapter.submitted).toBe(0);
  });

  it('accepts a sourceVideo when the provider advertises videoExtension', async () => {
    const r = rig({ caps: { videoExtension: true } });
    const res = await r.out.generateVideo({
      provider: 'mock',
      prompt: 'keep going',
      sourceVideo: { type: 'url', url: 'https://cdn/clip.mp4' },
      params: { videoMode: 'extend' },
    });
    expect(r.adapter.submitted).toBe(1);
    expect(res.type).toBe('video');
  });

  it('rejects when the adapter can submit but cannot report status or download', async () => {
    const r = rig({ partial: true });
    await expect(r.out.generateVideo({ provider: 'mock', prompt: 'x' })).rejects.toThrow(
      'Adapter missing getVideoStatus/downloadVideo for async video',
    );
    // The job was already submitted — the caller must know it may be running.
    expect(r.adapter.submitted).toBe(1);
  });
});

describe('MediaOutput.generateVideo — polling', () => {
  it('polls until completed, downloads once, and stores the bytes', async () => {
    const r = rig({
      statuses: [
        { status: 'pending' },
        { status: 'processing', progress: 40 },
        { status: 'completed' },
      ],
      download: {
        data: new Uint8Array([9, 9, 9, 9]),
        mimeType: 'video/mp4',
        durationMs: 8000,
        width: 1280,
        height: 720,
      },
    });

    const res = await r.out.generateVideo({
      provider: 'mock',
      model: 'sora-2',
      prompt: 'a cat surfing',
      params: { resolution: '1280x720' },
    });

    expect(r.adapter.statusCalls).toBe(3);
    expect(r.adapter.downloads).toBe(1);
    expect(res.id).toMatch(/^vid_/);
    expect(res.type).toBe('video');
    expect(res.mimeType).toBe('video/mp4');
    expect((await r.store.load(res.id))?.data).toEqual(new Uint8Array([9, 9, 9, 9]));
    expect(await r.store.getMeta(res.id)).toMatchObject({
      type: 'video',
      size: 4,
      provider: 'mock',
      model: 'sora-2',
      prompt: 'a cat surfing',
      durationMs: 8000,
      width: 1280,
      height: 720,
    });
  });

  it('does not download before the job reports completed', async () => {
    const r = rig({ statuses: [{ status: 'processing' }, { status: 'completed' }] });
    const p = r.out.generateVideo({ provider: 'mock', prompt: 'x' });
    await p;
    // Two status polls, one download — never a download on the processing poll.
    expect(r.adapter.statusCalls).toBe(2);
    expect(r.adapter.downloads).toBe(1);
  });

  it('reports progress on each pending/processing poll and not on the completed one', async () => {
    const r = rig({
      statuses: [
        { status: 'pending', progress: 0 },
        { status: 'processing', progress: 55 },
        { status: 'completed', progress: 100 },
      ],
    });
    await r.out.generateVideo({ provider: 'mock', model: 'grok-video', prompt: 'x' });

    expect(r.progress.length).toBe(2);
    expect(r.progress[0]).toEqual({
      type: 'video',
      provider: 'mock',
      operationId: 'op_1',
      progress: 0,
      model: 'grok-video',
    });
    expect(r.progress[1].progress).toBe(55);
  });

  it('still reports progress when the provider omits a percentage', async () => {
    const r = rig({ statuses: [{ status: 'processing' }, { status: 'completed' }] });
    await r.out.generateVideo({ provider: 'mock', prompt: 'x' });
    expect(r.progress.length).toBe(1);
    expect(r.progress[0].progress).toBeUndefined();
  });

  it('bills the generated video by its duration and requested resolution', async () => {
    const r = rig({
      download: { data: new Uint8Array([1]), mimeType: 'video/mp4', durationMs: 12_000 },
    });
    await r.out.generateVideo({
      provider: 'mock',
      model: 'sora-2',
      prompt: 'x',
      params: { resolution: '1080p' },
    });

    expect(r.generated.length).toBe(1);
    expect(r.generated[0]).toMatchObject({
      mediaType: 'video',
      provider: 'mock',
      model: 'sora-2',
      count: 1,
      durationSeconds: 12,
      resolution: '1080p',
      source: 'media_output',
      stored: true,
    });
    expect(r.generated[0].parts[0]).toMatchObject({ type: 'video_output', mimeType: 'video/mp4' });
    expect(r.generated[0].trace?.sessionId).toBe('sess_v');
  });

  it('keeps a provider-hosted URL for a video whose bytes stayed remote', async () => {
    const r = rig({
      download: {
        data: new Uint8Array(),
        mimeType: 'video/mp4',
        sourceUrl: 'https://vidgen/out.mp4',
        durationMs: 6000,
      },
    });
    const res = await r.out.generateVideo({ provider: 'mock', prompt: 'x' });
    expect((await r.store.getMeta(res.id))?.sourceUrl).toBe('https://vidgen/out.mp4');
    expect(r.generated[0].durationSeconds).toBe(6);
  });

  it('threads one trace through submit, every poll and the download', async () => {
    const seen: Array<string | undefined> = [];
    const fetch: EngineFetch = async (req) => {
      seen.push(req.trace?.requestId);
      return { status: 200, headers: {}, body: {} } as HttpResponse;
    };
    const hooks = new HookBus();
    const out = new MediaOutput({
      hooks,
      mediaStore: new MemoryMediaStore(),
      fetch,
      sessionId: 'sess_v',
      config: { pollIntervalMs: 0 },
    });
    const a = videoAdapter({ statuses: [{ status: 'processing' }, { status: 'completed' }] });
    out.registerProvider('mock', a);
    await out.generateVideo({ provider: 'mock', prompt: 'x' });

    // Every adapter call got the SAME wrapped fetch, and it stamped one id.
    for (const f of a.fetchesSeen)
      await f({ url: 'u', headers: {}, body: {}, provider: 'mock', model: 'm' });
    expect(seen.length).toBe(4); // submit + 2 polls + download
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toMatch(/^req_/);
  });
});

describe('MediaOutput.generateVideo — failure', () => {
  it('announces the provider error before throwing it', async () => {
    const r = rig({ statuses: [{ status: 'failed', error: 'moderation_blocked' }] });
    await expect(r.out.generateVideo({ provider: 'mock', prompt: 'x' })).rejects.toThrow(
      'Video generation failed: moderation_blocked',
    );
    expect(r.errors).toEqual([
      {
        id: 'op_1',
        provider: 'mock',
        error: 'moderation_blocked',
        operationId: 'op_1',
      },
    ]);
    expect(r.adapter.downloads).toBe(0);
    expect(r.generated.length).toBe(0);
  });

  it('uses a default error message when the provider gives none', async () => {
    const r = rig({ statuses: [{ status: 'failed' }] });
    await expect(r.out.generateVideo({ provider: 'mock', prompt: 'x' })).rejects.toThrow(
      'Video generation failed',
    );
    expect(r.errors[0].error).toBe('Video generation failed');
  });

  it('fails on a failed status even after progressing', async () => {
    const r = rig({
      statuses: [
        { status: 'processing', progress: 90 },
        { status: 'failed', error: 'oom' },
      ],
    });
    await expect(r.out.generateVideo({ provider: 'mock', prompt: 'x' })).rejects.toThrow('oom');
    expect(r.progress.length).toBe(1);
    expect(r.errors.length).toBe(1);
  });

  it('gives up with a timeout naming the budget it exhausted', async () => {
    const r = rig({ maxPollWaitMs: 0, statuses: [{ status: 'processing' }] });
    await expect(r.out.generateVideo({ provider: 'mock', prompt: 'x' })).rejects.toThrow(
      'Video generation timed out after 0ms',
    );
    expect(r.adapter.submitted).toBe(1);
  });

  it('times out after exhausting the wait budget across repeated polls', async () => {
    // Fake clock: each status poll consumes exactly 1s of a 3s budget, so the
    // loop runs three times and the fourth check finds the budget spent. The
    // budget is a strict bound — a poll starting exactly at the deadline does
    // not get to run, so 3 polls and not 4.
    const realNow = Date.now;
    let clock = 1_000_000;
    try {
      const r = rig({ maxPollWaitMs: 3000, statuses: [{ status: 'processing', progress: 10 }] });
      const original = r.adapter.getVideoStatus!;
      r.adapter.getVideoStatus = async (id, f) => {
        clock += 1000;
        return original(id, f);
      };
      Date.now = () => clock;
      await expect(r.out.generateVideo({ provider: 'mock', prompt: 'x' })).rejects.toThrow(
        'Video generation timed out after 3000ms',
      );
      expect(r.adapter.statusCalls).toBe(3);
      expect(r.progress.length).toBe(3);
      expect(r.adapter.downloads).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });
});
