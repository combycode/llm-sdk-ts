/** An image the model never saw at the size you sent it.
 *
 *  Anthropic scales an over-large image down to fit and says nothing about it.
 *  The model then reasons over dimensions you did not choose, the answer comes
 *  back looking normal, and nothing in the response mentions that the thing you
 *  were asking about was resampled away. For a screenshot of small text, or a
 *  scan someone is asking you to read, that is the difference between an answer
 *  and a guess.
 *
 *  `transformations: { oversized_image: 'error' }` refuses instead, with a 400
 *  naming the image's dimensions and the largest that would fit — so the
 *  caller scales it deliberately, or sends something else.
 *
 *  Per-IMAGE rather than per-request: one oversized screenshot in a long
 *  conversation should not change how every other image in it is handled.
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import type { ImagePart } from '../../../src/llm/types/messages';

const adapter = new AnthropicAdapter({ apiKey: 'k' });

/** The content blocks Anthropic would receive for one user message. */
function blocks(parts: unknown[]) {
  const body = adapter.buildRequest({
    model: 'claude-haiku-4.5',
    messages: [{ role: 'user', content: parts }],
  } as never).body as { messages: Array<{ content: Array<Record<string, unknown>> }> };
  return body.messages[0]?.content ?? [];
}

const PNG: ImagePart = {
  type: 'image',
  source: { type: 'base64', mimeType: 'image/png', data: 'aGk=' },
};

describe('transformations on an image block', () => {
  it('is absent when the caller did not ask', () => {
    // Absent, not `{ oversized_image: 'downsize' }`. Restating the server's
    // default would freeze today's default into every request we send.
    const [block] = blocks([PNG]);
    expect(block?.type).toBe('image');
    expect(block).not.toHaveProperty('transformations');
  });

  it("carries 'error' — the reason the field exists", () => {
    const [block] = blocks([
      { ...PNG, providerOptions: { transformations: { oversized_image: 'error' } } },
    ]);
    expect(block?.transformations).toEqual({ oversized_image: 'error' });
  });

  it("carries an explicit 'downsize' too", () => {
    // Saying the default out loud is a legitimate choice: it pins the
    // behaviour against a future change of default.
    const [block] = blocks([
      { ...PNG, providerOptions: { transformations: { oversized_image: 'downsize' } } },
    ]);
    expect(block?.transformations).toEqual({ oversized_image: 'downsize' });
  });

  it('is absent for an empty object, which means nothing', () => {
    // Anthropic documents an empty object as equivalent to omitting the
    // field, so there is no reason to send one.
    const [block] = blocks([{ ...PNG, providerOptions: { transformations: {} } }]);
    expect(block).not.toHaveProperty('transformations');
  });

  it('applies to one image without touching its neighbours', () => {
    // The point of per-part: the second image keeps the server default.
    const [first, second] = blocks([
      { ...PNG, providerOptions: { transformations: { oversized_image: 'error' } } },
      PNG,
    ]);
    expect(first?.transformations).toEqual({ oversized_image: 'error' });
    expect(second).not.toHaveProperty('transformations');
  });

  it('rides along with every source kind', () => {
    const t = { transformations: { oversized_image: 'error' as const } };
    const sources = [
      { type: 'base64' as const, mimeType: 'image/png', data: 'aGk=' },
      { type: 'url' as const, url: 'https://a.test/x.png' },
      { type: 'file' as const, fileId: 'file_1' },
    ];
    for (const source of sources) {
      const [block] = blocks([{ type: 'image', source, providerOptions: t }]);
      expect(block?.transformations).toEqual({ oversized_image: 'error' });
      // And the source itself still built correctly.
      expect(block?.source).toBeDefined();
      expect(Object.keys(block?.source as object).length).toBeGreaterThan(0);
    }
  });

  it('leaves other part types alone', () => {
    const [text] = blocks([{ type: 'text', text: 'hello' }]);
    expect(text).toEqual({ type: 'text', text: 'hello' });
  });
});
