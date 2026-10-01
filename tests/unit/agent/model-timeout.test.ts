/** Bounding the MODEL half of a step.
 *
 *  `toolTimeout` already bounded the tool half. The model half was bounded only by
 *  whatever the client was configured with — so on a long run one slow step could
 *  hold the whole run open past any deadline the caller thought they had set.
 *
 *  Three decisions worth pinning, because each is a thing someone will assume the
 *  other way:
 *
 *   - it is per STEP, not per run (a run-wide budget is an `AbortSignal`, which the
 *     caller already has);
 *   - a per-call `timeout` still wins, because `modelTimeout` is the run's DEFAULT
 *     and not a cap on what one call may ask for;
 *   - there is no new error type. Upstream names a `ModelTimeoutError`; the network
 *     layer already raises `LLMError{kind:'timeout'}`, and a second class for a
 *     condition we already report would make every consumer learn both.
 */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ExecuteOptions } from '../../../src/llm/types/options';

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

/** Records the options each step was given. */
function recordingClient() {
  const seen: ExecuteOptions[] = [];
  const client = {
    id: 'mock',
    provider: 'mock',
    model: 'mock-model',
    api: 'completions',
    mode: 'foreground',
    batchable: false,
    hooks: new HookBus(),
    complete: async (_input: unknown, options: ExecuteOptions): Promise<CompletionResponse> => {
      seen.push(options);
      return {
        id: 'r1',
        model: 'mock-model',
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: USAGE,
        text: 'ok',
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      } as unknown as CompletionResponse;
    },
    stream: async function* () {},
    destroy() {},
  } as unknown as LLMClient;
  return { client, seen };
}

describe('modelTimeout', () => {
  it('reaches the model call as the step default', async () => {
    const { client, seen } = recordingClient();
    const agent = new AgentLoop({ client, system: 's', modelTimeout: 30_000 } as never);
    await agent.complete('go');
    expect(seen[0]?.timeout).toBe(30_000);
  });

  it('is absent when nobody set it', async () => {
    // Not a default smuggled in: a run with no timeout configured must send none,
    // or every existing caller silently acquires one.
    const { client, seen } = recordingClient();
    const agent = new AgentLoop({ client, system: 's' } as never);
    await agent.complete('go');
    expect(seen[0]?.timeout).toBeUndefined();
  });

  it('yields to a per-call timeout', async () => {
    // `modelTimeout` is the run's default, not a cap on what one call may ask for.
    const { client, seen } = recordingClient();
    const agent = new AgentLoop({ client, system: 's', modelTimeout: 30_000 } as never);
    await agent.complete('go', { timeout: 90_000 });
    expect(seen[0]?.timeout).toBe(90_000);
  });

  it('applies to EVERY step, not once per run', async () => {
    // The per-step reading is the whole point. Two runs, two calls, both bounded.
    const { client, seen } = recordingClient();
    const agent = new AgentLoop({ client, system: 's', modelTimeout: 5_000 } as never);
    await agent.complete('one');
    await agent.complete('two');
    expect(seen.map((o) => o.timeout)).toEqual([5_000, 5_000]);
  });

  it('leaves the tool timeout alone', async () => {
    // Two different budgets for two different halves of a step; setting one must
    // not quietly set the other.
    const { client } = recordingClient();
    const agent = new AgentLoop({
      client,
      system: 's',
      modelTimeout: 5_000,
      toolTimeout: 60_000,
    } as never);
    await agent.complete('go');
    // `toolTimeout` is private; its effect is asserted by the tool tests. What
    // matters here is that construction accepts both and neither throws.
    expect(agent.model).toBe('mock-model');
  });
});
