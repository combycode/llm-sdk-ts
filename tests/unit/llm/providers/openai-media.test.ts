/** OpenAIMediaAdapter — image param mapping, TTS, and Sora video (create →
 *  poll → download), via a fake EngineFetch that captures requests. */

import { describe, expect, it } from 'bun:test';
import { OpenAIMediaAdapter } from '../../../../src/llm/providers/openai/media';
import type { EngineFetch, HttpRequest } from '../../../../src/network/types';

function fakeFetch(
  body: unknown,
  capture?: (req: HttpRequest) => void,
  status = 200,
): EngineFetch {
  return async (req) => {
    capture?.(req);
    return { status, headers: {}, body };
  };
}
const B64 = 'aGk='; // 'hi'

describe('OpenAIMediaAdapter — image', () => {
  const a = new OpenAIMediaAdapter({ apiKey: 'k' });

  it('maps size/quality/background/output_format to the request body', async () => {
    let captured: HttpRequest | undefined;
    await a.generateImage(
      {
        provider: 'openai',
        model: 'gpt-image-1',
        prompt: 'x',
        params: { size: '1536x1024', quality: 'high', background: 'transparent', outputFormat: 'webp' },
      },
      fakeFetch({ data: [{ b64_json: B64 }] }, (r) => {
        captured = r;
      }),
    );
    const body = captured?.body as Record<string, unknown>;
    expect(body.size).toBe('1536x1024');
    expect(body.quality).toBe('high');
    expect(body.background).toBe('transparent');
    expect(body.output_format).toBe('webp');
    // gpt-image-* must NOT send response_format (it's rejected).
    expect(body.response_format).toBeUndefined();
  });

  it('captures token usage (gpt-image is token-priced) on the first item only', async () => {
    const res = await a.generateImage(
      { provider: 'openai', model: 'gpt-image-1', prompt: 'x', params: { n: 2 } },
      fakeFetch({
        data: [{ b64_json: B64 }, { b64_json: B64 }],
        usage: { input_tokens: 120, output_tokens: 800, total_tokens: 920 },
      }),
    );
    expect(res[0].usage).toEqual(
      expect.objectContaining({ inputTokens: 120, outputTokens: 800, totalTokens: 920 }),
    );
    expect(res[1].usage).toBeUndefined();
  });

  it('omits usage when the response has none', async () => {
    const res = await a.generateImage(
      { provider: 'openai', model: 'gpt-image-1', prompt: 'x' },
      fakeFetch({ data: [{ b64_json: B64 }] }),
    );
    expect(res[0].usage).toBeUndefined();
  });

  it('editImage → /v1/images/edits with images[].image_url (base64 data URL)', async () => {
    let captured: HttpRequest | undefined;
    await a.editImage(
      {
        provider: 'openai',
        model: 'gpt-image-1',
        prompt: 'make it blue',
        sourceImage: { type: 'base64', mimeType: 'image/png', data: B64 },
      },
      fakeFetch({ data: [{ b64_json: B64 }] }, (r) => {
        captured = r;
      }),
    );
    expect(captured?.url).toContain('/v1/images/edits');
    expect((captured?.body as { images: unknown[] }).images).toEqual([
      { image_url: `data:image/png;base64,${B64}` },
    ]);
  });

  it('editImage with a file DataSource sends file_id', async () => {
    let captured: HttpRequest | undefined;
    await a.editImage(
      { provider: 'openai', model: 'gpt-image-1', prompt: 'x', sourceImage: { type: 'file', fileId: 'file-9' } },
      fakeFetch({ data: [{ b64_json: B64 }] }, (r) => {
        captured = r;
      }),
    );
    expect((captured?.body as { images: unknown[] }).images).toEqual([{ file_id: 'file-9' }]);
  });

  it('submitVideo includes input_reference when a source image is given', async () => {
    let captured: HttpRequest | undefined;
    await a.submitVideo(
      {
        provider: 'openai',
        model: 'sora-2',
        prompt: 'animate it',
        sourceImage: { type: 'base64', mimeType: 'image/png', data: B64 },
      },
      fakeFetch({ id: 'v1', status: 'queued' }, (r) => {
        captured = r;
      }),
    );
    expect((captured?.body as { input_reference: unknown }).input_reference).toEqual({
      image_url: `data:image/png;base64,${B64}`,
    });
  });
});

describe('OpenAIMediaAdapter — Sora video', () => {
  const a = new OpenAIMediaAdapter({ apiKey: 'k' });

  it('submitVideo posts to /v1/videos with seconds + size, returns id', async () => {
    let captured: HttpRequest | undefined;
    const id = await a.submitVideo(
      { provider: 'openai', model: 'sora-2', prompt: 'a cat', params: { duration: 8, size: '1280x720' } },
      fakeFetch({ id: 'video_123', status: 'queued' }, (r) => {
        captured = r;
      }),
    );
    expect(id).toBe('video_123');
    expect(captured?.url).toContain('/v1/videos');
    const body = captured?.body as Record<string, unknown>;
    expect(body.seconds).toBe('8'); // numeric duration → string
    expect(body.size).toBe('1280x720');
  });

  it('getVideoStatus maps completed/failed/processing', async () => {
    expect((await a.getVideoStatus('v', fakeFetch({ status: 'completed', progress: 100 }))).status).toBe(
      'completed',
    );
    expect((await a.getVideoStatus('v', fakeFetch({ status: 'in_progress', progress: 40 }))).status).toBe(
      'processing',
    );
    const failed = await a.getVideoStatus('v', fakeFetch({ status: 'failed', error: { message: 'boom' } }));
    expect(failed).toEqual({ status: 'failed', error: 'boom' });
  });

  it('downloadVideo fetches /content and returns mp4 bytes', async () => {
    let captured: HttpRequest | undefined;
    const raw = await a.downloadVideo(
      'video_123',
      fakeFetch(new Uint8Array([1, 2, 3]), (r) => {
        captured = r;
      }),
    );
    expect(captured?.url).toContain('/v1/videos/video_123/content');
    expect(raw.mimeType).toBe('video/mp4');
    expect(raw.data.length).toBe(3);
  });

  it('capabilities reports videoGeneration true', () => {
    expect(a.capabilities().videoGeneration).toBe(true);
  });
});
