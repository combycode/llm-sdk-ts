/** Reflect-and-retry: recovering from a model failure the model itself can fix.
 *
 *  A malformed tool call used to end the run. Now the model is told what went wrong and gets a
 *  bounded number of tries. Note this is NOT a network retry — the request succeeded; it came back
 *  unusable, which resending unchanged would never fix. */

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_REFLECT_RETRY_REASONS,
  ReflectAndRetryPolicy,
  reflectionGuidance,
} from '../../../src/agent/reflect-retry';
import { extractFinishReason } from '../../../src/llm/providers/_shared/response-utils';

// ─── the mapping that makes the trigger exist at all ─────────────────────────

describe('MALFORMED_FUNCTION_CALL mapping', () => {
  it('maps to malformed_tool_call instead of falling through to stop', () => {
    // Previously unmapped: a turn where the model failed to produce a usable tool call looked like
    // a clean finish with no content.
    expect(
      extractFinishReason(false, 'MALFORMED_FUNCTION_CALL', {
        MAX_TOKENS: 'length',
        SAFETY: 'content_filter',
        MALFORMED_FUNCTION_CALL: 'malformed_tool_call',
      }),
    ).toBe('malformed_tool_call');
  });

  it('still falls back to stop for a reason we do not map', () => {
    expect(extractFinishReason(false, 'SOMETHING_NEW', { MAX_TOKENS: 'length' })).toBe('stop');
  });
});

// ─── the policy ──────────────────────────────────────────────────────────────

describe('ReflectAndRetryPolicy', () => {
  it('handles only the configured reasons', () => {
    const p = new ReflectAndRetryPolicy();
    expect(DEFAULT_REFLECT_RETRY_REASONS).toEqual(['malformed_tool_call']);
    expect(p.handles('malformed_tool_call')).toBe(true);
    expect(p.handles('stop')).toBe(false);
    // A refusal is usually a decision, not a mistake — not retried by default.
    expect(p.handles('content_filter')).toBe(false);
  });

  it('retries up to maxRetries, then reports exhausted', () => {
    const p = new ReflectAndRetryPolicy({ maxRetries: 2 });
    expect(p.recordFailure()).toEqual({ retry: true, attempt: 1, exhausted: false });
    expect(p.recordFailure()).toEqual({ retry: true, attempt: 2, exhausted: false });
    expect(p.recordFailure()).toEqual({ retry: false, attempt: 3, exhausted: true });
  });

  it('counts CONSECUTIVE failures — a success clears the streak', () => {
    const p = new ReflectAndRetryPolicy({ maxRetries: 2 });
    p.recordFailure();
    p.recordFailure();
    p.recordSuccess();
    // An agent that recovers and fails again much later gets a fresh budget, not an inherited one.
    expect(p.recordFailure()).toEqual({ retry: true, attempt: 1, exhausted: false });
  });

  it('maxRetries: 0 means never retry, but still reports the failure', () => {
    const p = new ReflectAndRetryPolicy({ maxRetries: 0 });
    expect(p.recordFailure()).toEqual({ retry: false, attempt: 1, exhausted: true });
  });

  it('rejects a negative budget rather than silently treating it as zero', () => {
    expect(() => new ReflectAndRetryPolicy({ maxRetries: -1 })).toThrow(/must be >= 0/);
  });

  it('resets between runs', () => {
    const p = new ReflectAndRetryPolicy({ maxRetries: 1 });
    p.recordFailure();
    p.reset();
    expect(p.consecutiveFailures).toBe(0);
  });

  it('accepts a custom trigger set', () => {
    const p = new ReflectAndRetryPolicy({ onFinishReasons: ['content_filter'] });
    expect(p.handles('content_filter')).toBe(true);
    expect(p.handles('malformed_tool_call')).toBe(false);
  });
});

// ─── the guidance the model actually receives ────────────────────────────────

describe('reflectionGuidance', () => {
  it('names the attempt and forbids repeating the same call', () => {
    const g = reflectionGuidance('malformed_tool_call', 2, 3);
    expect(g).toContain('retry attempt 2 of 3');
    // Without this instruction a model tends to re-emit the identical arguments and burn the
    // whole budget on one mistake.
    expect(g).toMatch(/Do NOT repeat the same call/);
    expect(g).toContain('malformed_tool_call');
  });

  it('includes provider detail when there is any', () => {
    expect(reflectionGuidance('malformed_tool_call', 1, 3, 'unterminated JSON')).toContain(
      'unterminated JSON',
    );
  });

  it('omits the detail line entirely when there is none', () => {
    expect(reflectionGuidance('malformed_tool_call', 1, 3)).not.toContain('Details:');
  });
});

// ─── the integration: does the LOOP actually recover? ────────────────────────

import { AgentLoop } from '../../../src/agent/loop';
import { emptyUsage } from '../../../src/llm/types/response';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { Message } from '../../../src/llm/types/messages';

/** A client whose finish reasons are scripted, recording what history it was sent. */
function scriptedClient(reasons: string[]) {
  const seen: Message[][] = [];
  let i = 0;
  const client = {
    id: 'c1',
    provider: 'google',
    model: 'gemini-3.6-flash',
    api: 'generateContent',
    mode: 'sync',
    batchable: false,
    complete: async (messages: Message[]): Promise<CompletionResponse> => {
      seen.push([...messages]);
      const finishReason = reasons[Math.min(i, reasons.length - 1)] ?? 'stop';
      i++;
      return {
        id: `r${i}`,
        model: 'gemini-3.6-flash',
        content: finishReason === 'stop' ? [{ type: 'text', text: 'recovered' }] : [],
        finishReason,
        usage: emptyUsage(),
        text: finishReason === 'stop' ? 'recovered' : '',
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      } as CompletionResponse;
    },
  };
  return { client, seen, calls: () => i };
}

describe('AgentLoop reflect-and-retry', () => {
  it('retries a malformed tool call and recovers', async () => {
    const { client, seen, calls } = scriptedClient(['malformed_tool_call', 'stop']);
    const loop = new AgentLoop({
      client: client as never,
      reflectAndRetry: { maxRetries: 2 },
    });

    const res = await loop.complete('do the thing');

    expect(calls()).toBe(2);
    expect(res.text).toBe('recovered');
    // The guidance was injected as a user turn before the retry…
    const secondTurn = seen[1] ?? [];
    const guidance = secondTurn.map((m) => String(m.content)).join('\n');
    expect(guidance).toContain('retry attempt 1 of 2');
    // …and the failed assistant turn was NOT appended, so the model does not learn from its own
    // broken output.
    expect(secondTurn.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  it('throws once the budget is spent, naming the escape hatch', async () => {
    const { client } = scriptedClient(['malformed_tool_call']);
    const loop = new AgentLoop({ client: client as never, reflectAndRetry: { maxRetries: 1 } });

    await expect(loop.complete('go')).rejects.toThrow(/throwIfExceeded = false/);
  });

  it('returns the unusable response instead when throwIfExceeded is false', async () => {
    const { client } = scriptedClient(['malformed_tool_call']);
    const loop = new AgentLoop({
      client: client as never,
      reflectAndRetry: { maxRetries: 1, throwIfExceeded: false },
    });

    const res = await loop.complete('go');
    expect(res.finishReason).toBe('malformed_tool_call');
  });

  it('does nothing at all when the option is not configured', async () => {
    const { client, calls } = scriptedClient(['malformed_tool_call']);
    const loop = new AgentLoop({ client: client as never });

    const res = await loop.complete('go');
    // Off by default: one call, no retry, the caller sees the raw outcome.
    expect(calls()).toBe(1);
    expect(res.finishReason).toBe('malformed_tool_call');
  });
});

// ─── the agent boundary must not lose the phase ──────────────────────────────

/** Shipped in 2.0.0 without this: the mapper split commentary internally and then yielded
 *  BOTH deltas through one `{type:'text', text}` event with no phase. A UI streaming those
 *  straight through put the model's thinking-aloud into the transcript as the reply, and
 *  `finalAnswerText()` could not help — it takes finished message content, not deltas.
 *  Reported by a consumer, not by us. */
describe('agent stream preserves phase', () => {
  function streamingClient(events: Array<{ type: 'text'; text: string; phase?: string }>) {
    return {
      id: 'c1',
      provider: 'openai',
      model: 'gpt-5.3-codex',
      api: 'responses',
      mode: 'stream',
      batchable: false,
      complete: async (): Promise<CompletionResponse> => {
        throw new Error('not used');
      },
      stream: async function* () {
        for (const e of events) yield e;
        yield { type: 'done', finishReason: 'stop', usage: emptyUsage() };
      },
    };
  }

  it('forwards commentary and answer distinguishably', async () => {
    const loop = new AgentLoop({
      client: streamingClient([
        { type: 'text', text: 'let me think…', phase: 'commentary' },
        { type: 'text', text: 'the answer', phase: 'final_answer' },
      ]) as never,
    });

    const seen: Array<{ text: string; phase?: string }> = [];
    for await (const ev of loop.stream('go')) {
      if (ev.type === 'text') seen.push({ text: ev.text, phase: (ev as { phase?: string }).phase });
    }

    expect(seen).toEqual([
      { text: 'let me think…', phase: 'commentary' },
      { text: 'the answer', phase: 'final_answer' },
    ]);
    // The consumer can now filter live — the whole point.
    expect(seen.filter((e) => e.phase !== 'commentary').map((e) => e.text).join('')).toBe('the answer');
  });

  it('omits phase entirely when the provider reports none', async () => {
    const loop = new AgentLoop({
      client: streamingClient([{ type: 'text', text: 'plain' }]) as never,
    });
    const seen: Array<Record<string, unknown>> = [];
    for await (const ev of loop.stream('go')) {
      if (ev.type === 'text') seen.push(ev as unknown as Record<string, unknown>);
    }
    // Absent, not `undefined`-valued: unchanged shape for every non-codex provider.
    expect(seen).toEqual([{ type: 'text', text: 'plain' }]);
  });
});
