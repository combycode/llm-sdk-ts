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
});
