/** OAI adapter pure-function tests. */

import { describe, expect, it } from 'bun:test';
import {
  buildChatResponse,
  buildErrorBody,
  buildModelsList,
  buildStreamChunk,
  estimateTokens,
  extractLastUserText,
  extractSystemText,
  formatSseFrame,
  oaiContentToText,
  SSE_TERMINATOR,
  validateChatRequest,
} from '../../../src/server/oai-adapter';

describe('oaiContentToText', () => {
  it('returns string content as-is', () => {
    expect(oaiContentToText('hi')).toBe('hi');
  });

  it('returns empty for null', () => {
    expect(oaiContentToText(null)).toBe('');
  });

  it('concatenates text parts', () => {
    expect(
      oaiContentToText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });

  it('renders image_url parts as marker text', () => {
    const c = oaiContentToText([{ type: 'image_url', image_url: { url: 'https://x/y.png' } }]);
    expect(c).toContain('[image:');
  });

  it('truncates long data URLs', () => {
    const huge = `data:image/png;base64,${'A'.repeat(5000)}`;
    const c = oaiContentToText([{ type: 'image_url', image_url: { url: huge } }]);
    expect(c.length).toBeLessThan(150);
  });
});

describe('extractLastUserText / extractSystemText', () => {
  it('returns last user text', () => {
    expect(
      extractLastUserText([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'last' },
      ]),
    ).toBe('last');
  });

  it('throws when no user message', () => {
    expect(() => extractLastUserText([{ role: 'system', content: 'x' }])).toThrow(/no "user"/);
  });

  it('joins all system messages with double newline', () => {
    expect(
      extractSystemText([
        { role: 'system', content: 'one' },
        { role: 'user', content: 'q' },
        { role: 'system', content: 'two' },
      ]),
    ).toBe('one\n\ntwo');
  });
});

describe('estimateTokens', () => {
  it('rounds up at 4 chars per token', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('buildChatResponse / buildStreamChunk', () => {
  it('fills required OAI fields', () => {
    const r = buildChatResponse({ model: 'm', text: 'hello' });
    expect(r.object).toBe('chat.completion');
    expect(r.model).toBe('m');
    expect(r.choices[0].message.content).toBe('hello');
    expect(r.choices[0].finish_reason).toBe('stop');
  });

  it('uses provided id', () => {
    expect(buildChatResponse({ model: 'm', text: 'x', id: 'cmpl-id' }).id).toBe('cmpl-id');
  });

  it('builds stream chunk', () => {
    const c = buildStreamChunk({ id: 'cmpl', model: 'm', delta: { content: 'hi' } });
    expect(c.object).toBe('chat.completion.chunk');
    expect(c.choices[0].delta.content).toBe('hi');
  });
});

describe('formatSseFrame / SSE_TERMINATOR', () => {
  it('formats SSE frame', () => {
    expect(formatSseFrame({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  it('SSE terminator is constant', () => {
    expect(SSE_TERMINATOR).toBe('data: [DONE]\n\n');
  });
});

describe('buildModelsList / buildErrorBody', () => {
  it('builds model list', () => {
    const list = buildModelsList(['a', 'b']);
    expect(list.length).toBe(2);
    expect(list[0]).toMatchObject({ id: 'a', object: 'model', owned_by: 'orxa' });
  });

  it('builds error body shape', () => {
    expect(buildErrorBody('boom', 'invalid_request_error', 'X1')).toEqual({
      error: { message: 'boom', type: 'invalid_request_error', code: 'X1' },
    });
  });
});

describe('validateChatRequest', () => {
  it('accepts a minimal valid request', () => {
    const req = validateChatRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(req.model).toBe('m');
  });

  it('rejects missing model', () => {
    expect(() => validateChatRequest({ messages: [{ role: 'user', content: 'hi' }] })).toThrow(
      /model/,
    );
  });

  it('rejects empty messages', () => {
    expect(() => validateChatRequest({ model: 'm', messages: [] })).toThrow(/messages/);
  });
});
