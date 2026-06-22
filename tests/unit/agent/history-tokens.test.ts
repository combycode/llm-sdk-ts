/** ConversationHistory token-tracking tests using a stub TokenCounter. */

import { describe, expect, it } from 'bun:test';
import { ConversationHistory } from '../../../src/agent/history';
import type { TokenCounter, TokenCountContext } from '../../../src/agent/types';
import type { Message } from '../../../src/llm/types/messages';

/** Stub counter that returns chars / charsPerToken. */
function stubCounter(charsPerToken: number): TokenCounter {
  return {
    estimate: (text: string) => Math.ceil(text.length / charsPerToken),
    estimateMessage: (msg: Message) => {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      return Math.ceil(text.length / charsPerToken);
    },
    measure: async (text: string) => Math.ceil(text.length / charsPerToken),
    measureMessage: async (msg: Message) => {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      return Math.ceil(text.length / charsPerToken);
    },
    learn: () => {},
  };
}

describe('ConversationHistory token tracking', () => {
  it('falls back to length/4 without counter', () => {
    const h = new ConversationHistory();
    h.append({ role: 'user', content: 'hello world hello world' }); // 23 chars
    expect(h.estimatedTokens()).toBe(Math.ceil(23 / 4)); // 6
  });

  it('uses counter when provided', () => {
    const h = new ConversationHistory({
      counter: stubCounter(3.5),
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });
    h.append({ role: 'user', content: 'x'.repeat(350) });
    // 350/3.5 = 100
    expect(h.estimatedTokens()).toBe(100);
  });

  it('counter is only used when provider+model both set', () => {
    const h = new ConversationHistory({ counter: stubCounter(3.5) });
    // No provider/model → falls back to chars/4
    h.append({ role: 'user', content: 'x'.repeat(40) });
    expect(h.estimatedTokens()).toBe(10); // ceil(40/4)
  });

  it('assistant append with usage auto-anchors prior entries as exact', () => {
    const h = new ConversationHistory({
      counter: stubCounter(3.5),
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });

    h.append({ role: 'user', content: 'hello' });
    h.append(
      { role: 'assistant', content: 'hi there' },
      {
        usage: {
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: 7,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      },
    );

    expect(h.lastActualTotal).toBe(5);

    h.append({ role: 'user', content: 'x'.repeat(350) });

    // 5 (exact user0) + 2 (exact assistant1) + 100 (est for user2) = 107
    expect(h.estimatedTokens()).toBe(107);
  });

  it('assistant message uses outputTokens when available', () => {
    const h = new ConversationHistory();
    h.append(
      { role: 'assistant', content: 'long response text here' },
      {
        usage: {
          inputTokens: 0,
          outputTokens: 42,
          totalTokens: 42,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      },
    );
    expect(h.estimatedTokens()).toBe(42);
  });

  it('manual recordActualUsage works (before appending response)', () => {
    const h = new ConversationHistory();
    h.append({ role: 'user', content: 'hello' });
    h.recordActualUsage(5);
    h.append({ role: 'assistant', content: 'hi' });

    expect(h.lastActualTotal).toBe(5);
    expect(h.estimatedTokens()).toBeGreaterThanOrEqual(5);
  });

  it('counter ctx includes provider+model', () => {
    let lastCtx: TokenCountContext | undefined;
    const counter: TokenCounter = {
      estimate: () => 0,
      estimateMessage: (_msg, ctx) => {
        lastCtx = ctx;
        return 5;
      },
      measure: async () => 0,
      measureMessage: async () => 0,
      learn: () => {},
    };
    const h = new ConversationHistory({ counter, provider: 'p', model: 'm' });
    h.append({ role: 'user', content: 'hi' });
    h.estimatedTokens();
    expect(lastCtx).toEqual({ provider: 'p', model: 'm' });
  });

  it('spliceRange invalidates _lastActualEntryIndex when range overlaps it', () => {
    const h = new ConversationHistory();
    h.append({ role: 'user', content: 'a' });
    h.append({ role: 'assistant', content: 'b' });
    h.recordActualUsage(10);

    h.spliceRange(0, 2, { role: 'system', content: 'summary' });
    expect(h.lastActualTotal).toBe(0);
  });
});
