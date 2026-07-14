/** XAIMediaAdapter — captures the provider-reported cost (usage.cost_in_usd_ticks)
 *  on image/video results so the cost engine can price by xAI's own number. */

import { describe, expect, it } from 'bun:test';
import { XAIMediaAdapter } from '../../../../src/llm/providers/xai/media';
import type { EngineFetch, HttpRequest } from '../../../../src/network/types';

function fakeFetch(body: unknown, capture?: (req: HttpRequest) => void, status = 200): EngineFetch {
  return async (req: HttpRequest) => {
    capture?.(req);
    return { status, headers: {}, body };
  };
}
const B64 = 'aGk=';

describe('XAIMediaAdapter — provider cost capture', () => {
  const a = new XAIMediaAdapter({ apiKey: 'k' });

  it('image: attaches usage (cost_in_usd_ticks) as providerMeta on first item', async () => {
    const res = await a.generateImage(
      { provider: 'xai', model: 'grok-imagine-image', prompt: 'x' },
      fakeFetch({ data: [{ b64_json: B64 }], usage: { cost_in_usd_ticks: 200_000_000 } }),
    );
    expect(res[0].providerMeta).toEqual({ usage: { cost_in_usd_ticks: 200_000_000 } });
  });

  it('image: no usage → no providerMeta', async () => {
    const res = await a.generateImage(
      { provider: 'xai', model: 'grok-imagine-image', prompt: 'x' },
      fakeFetch({ data: [{ b64_json: B64 }] }),
    );
    expect(res[0].providerMeta).toBeUndefined();
  });

  it('editImage → /v1/images/edits with image:{url} (data URL)', async () => {
    let captured: HttpRequest | undefined;
    await a.editImage(
      {
        provider: 'xai',
        model: 'grok-imagine-image',
        prompt: 'pencil sketch',
        sourceImage: { type: 'base64', mimeType: 'image/png', data: B64 },
      },
      fakeFetch({ data: [{ b64_json: B64 }] }, (r) => {
        captured = r;
      }),
    );
    expect(captured?.url).toContain('/v1/images/edits');
    expect((captured?.body as { image: unknown }).image).toEqual({
      url: `data:image/png;base64,${B64}`,
    });
  });

  it('submitVideo sets image (first frame) when a source image is given', async () => {
    let captured: HttpRequest | undefined;
    await a.submitVideo(
      {
        provider: 'xai',
        model: 'grok-imagine-video',
        prompt: 'come alive',
        sourceImage: { type: 'file', fileId: 'file_x' },
      },
      fakeFetch({ request_id: 'r1' }, (r) => {
        captured = r;
      }),
    );
    expect((captured?.body as { image: unknown }).image).toEqual({ file_id: 'file_x' });
  });

  it('submitVideo: no sourceVideo → /v1/videos/generations', async () => {
    let captured: HttpRequest | undefined;
    await a.submitVideo(
      { provider: 'xai', model: 'grok-imagine-video', prompt: 'go' },
      fakeFetch({ request_id: 'r1' }, (r) => {
        captured = r;
      }),
    );
    expect(captured?.url).toBe('https://api.x.ai/v1/videos/generations');
  });

  it('submitVideo: sourceVideo (default mode) → /v1/videos/extensions, video + duration, no aspect/resolution', async () => {
    let captured: HttpRequest | undefined;
    await a.submitVideo(
      {
        provider: 'xai',
        model: 'grok-imagine-video',
        prompt: 'keep going',
        sourceVideo: { type: 'url', url: 'https://x/v.mp4' },
        params: { duration: 6, aspectRatio: '16:9', resolution: '720p' },
      },
      fakeFetch({ request_id: 'r1' }, (r) => {
        captured = r;
      }),
    );
    expect(captured?.url).toBe('https://api.x.ai/v1/videos/extensions');
    expect(captured?.body).toEqual({
      model: 'grok-imagine-video',
      prompt: 'keep going',
      video: { url: 'https://x/v.mp4' },
      duration: 6,
    });
  });

  it('submitVideo: sourceVideo + videoMode "edit" → /v1/videos/edits, video only', async () => {
    let captured: HttpRequest | undefined;
    await a.submitVideo(
      {
        provider: 'xai',
        model: 'grok-imagine-video',
        prompt: 'add a rainbow',
        sourceVideo: { type: 'file', fileId: 'file_v' },
        params: { duration: 6, aspectRatio: '16:9', videoMode: 'edit' },
      },
      fakeFetch({ request_id: 'r1' }, (r) => {
        captured = r;
      }),
    );
    expect(captured?.url).toBe('https://api.x.ai/v1/videos/edits');
    expect(captured?.body).toEqual({
      model: 'grok-imagine-video',
      prompt: 'add a rainbow',
      video: { file_id: 'file_v' },
    });
  });

  it('submitVideo: base64 sourceVideo → data URL in video.url', async () => {
    let captured: HttpRequest | undefined;
    await a.submitVideo(
      {
        provider: 'xai',
        model: 'grok-imagine-video',
        prompt: 'extend',
        sourceVideo: { type: 'base64', mimeType: 'video/mp4', data: B64 },
      },
      fakeFetch({ request_id: 'r1' }, (r) => {
        captured = r;
      }),
    );
    expect((captured?.body as { video: { url: string } }).video.url).toBe(`data:video/mp4;base64,${B64}`);
  });

  it('capabilities advertise videoExtension', () => {
    expect(a.capabilities().videoExtension).toBe(true);
  });
});

describe('XAIMediaAdapter — async video polling (real payload shapes)', () => {
  const a = new XAIMediaAdapter({ apiKey: 'k' });

  // Exact server payload from a completed grok-imagine-video-1.5 job.
  const DONE = {
    status: 'done',
    video: {
      url: 'https://vidgen.x.ai/xai-vidgen-bucket/xai-video-e8b7c480.mp4',
      duration: 10,
      respect_moderation: true,
    },
    model: 'grok-imagine-video-1.5',
    usage: { cost_in_usd_ticks: 8_100_000_000 },
    progress: 100,
  };

  it('getVideoStatus: status "done" + video.url → completed (not infinite poll)', async () => {
    const s = await a.getVideoStatus('r1', fakeFetch(DONE));
    expect(s.status).toBe('completed');
    expect(s.progress).toBe(100);
  });

  it('getVideoStatus: in-progress → processing with progress', async () => {
    const s = await a.getVideoStatus('r1', fakeFetch({ status: 'pending', progress: 42 }));
    expect(s.status).toBe('processing');
    expect(s.progress).toBe(42);
  });

  it('getVideoStatus: expired → failed', async () => {
    const s = await a.getVideoStatus('r1', fakeFetch({ status: 'expired' }));
    expect(s.status).toBe('failed');
  });

  it('downloadVideo: pulls bytes from video.url + duration from video.duration', async () => {
    let hitUrl: string | undefined;
    const fetch: EngineFetch = async (req: HttpRequest) => {
      if (req.responseType === 'arraybuffer') {
        hitUrl = req.url;
        return { status: 200, headers: {}, body: new Uint8Array([1, 2, 3]) };
      }
      return { status: 200, headers: {}, body: DONE };
    };
    const raw = await a.downloadVideo('r1', fetch);
    expect(hitUrl).toBe(DONE.video.url);
    expect(raw.sourceUrl).toBe(DONE.video.url);
    expect(raw.durationMs).toBe(10_000);
    expect((raw.data as Uint8Array).length).toBe(3);
    expect(raw.providerMeta).toEqual({ usage: { cost_in_usd_ticks: 8_100_000_000 } });
  });
});
