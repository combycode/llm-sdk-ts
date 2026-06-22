/** OpenRouterMediaAdapter — image generation/editing via /chat/completions with
 *  modalities; output read from message.images[], cost from usage.cost. */

import { describe, expect, it } from 'bun:test';
import { OpenRouterMediaAdapter } from '../../../../src/llm/providers/openrouter/media';
import type { EngineFetch, HttpRequest } from '../../../../src/network/types';

function fakeFetch(body: unknown, capture?: (req: HttpRequest) => void): EngineFetch {
  return async (req) => {
    capture?.(req);
    return { status: 200, headers: {}, body };
  };
}
const DATA_URL = 'data:image/png;base64,aGk='; // 'hi'

const imageResponse = {
  choices: [{ message: { content: '', images: [{ type: 'image_url', image_url: { url: DATA_URL } }] } }],
  usage: { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105, cost: 0.003 },
};

describe('OpenRouterMediaAdapter — image', () => {
  const a = new OpenRouterMediaAdapter({ apiKey: 'k' });

  it('generateImage → /api/v1/chat/completions with modalities + image_config', async () => {
    let captured: HttpRequest | undefined;
    const res = await a.generateImage(
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-image',
        prompt: 'a red panda',
        params: { aspectRatio: '16:9', imageSize: '2K' },
      },
      fakeFetch(imageResponse, (r) => {
        captured = r;
      }),
    );
    expect(captured?.url).toContain('/api/v1/chat/completions');
    const body = captured?.body as Record<string, unknown>;
    expect(body.modalities).toEqual(['image', 'text']);
    expect(body.image_config).toEqual({ aspect_ratio: '16:9', image_size: '2K' });

    expect(res[0].data.length).toBe(2);
    expect(res[0].mimeType).toBe('image/png');
    expect(res[0].usage?.inputTokens).toBe(5);
    expect(res[0].providerMeta).toEqual({ usage: imageResponse.usage });
  });

  it('editImage adds the source image as an image_url part + strength', async () => {
    let captured: HttpRequest | undefined;
    await a.editImage(
      {
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash-image',
        prompt: 'make it green',
        sourceImage: { type: 'base64', mimeType: 'image/png', data: 'aGk=' },
        params: { strength: 0.3 },
      },
      fakeFetch(imageResponse, (r) => {
        captured = r;
      }),
    );
    const body = captured?.body as { messages: Array<{ content: unknown[] }>; image_config: Record<string, unknown> };
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'make it green' },
      { type: 'image_url', image_url: { url: DATA_URL } },
    ]);
    expect(body.image_config.strength).toBe(0.3);
  });

  it('capabilities: image yes, video no', () => {
    const c = a.capabilities();
    expect(c.imageGeneration).toBe(true);
    expect(c.imageEditing).toBe(true);
    expect(c.videoGeneration).toBe(false);
  });
});
