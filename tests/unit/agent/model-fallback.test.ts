/** Backup models for a step of an agent run.
 *
 *  `route()` already fell over between models, but only for a one-shot
 *  `complete()`. A run is where it matters more: a rate limit on step 7 of a
 *  nine-step run threw away six steps of work and every tool call they paid for,
 *  and the caller's only recourse was to start the run again.
 *
 *  Four rules, and the third is the one that cannot be got wrong:
 *
 *   1. each client once per step — retrying one is the network engine's job, and
 *      doing it here too retries a single failure twice over;
 *   2. only a failure another model could survive moves on;
 *   3. **never switch once output has reached the consumer** — a streamed turn can
 *      fail after several chunks, and a backup cannot continue someone else's
 *      half-rendered answer;
 *   4. every step starts from the primary, because a rate limit is transient.
 *
 *  And the stamp: a step a backup served must be recorded as the backup's.
 *  Provenance is model-bound — a stateful continuation is only valid against the
 *  model that issued the state — so naming the primary on a turn it did not
 *  produce would have the next step offer the backup's server state to the
 *  primary.
 */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import { LLMError } from '../../../src/network/errors';
import type { ErrorKind } from '../../../src/network/errors';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { StreamEvent } from '../../../src/llm/types/stream';

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function response(model: string, text: string): CompletionResponse {
  return {
    id: 'r1',
    model,
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    usage: USAGE,
    text,
    toolCalls: [],
    thinking: null,
    media: [],
    latencyMs: 1,
    raw: null,
  } as unknown as CompletionResponse;
}

interface Script {
  /** `null` answers; an ErrorKind throws a classified LLMError; a string throws
   *  an unclassified Error. */
  fail?: ErrorKind | 'plain' | null;
  /** For the streamed path: how many events to emit BEFORE failing. */
  emitBefore?: number;
}

/** A client that answers or fails on command, and counts its calls. */
function fake(model: string, script: Script = {}) {
  const calls = { complete: 0, stream: 0 };
  const boom = () => {
    if (script.fail === 'plain') throw new Error(`${model} broke`);
    throw new LLMError(`${model} is busy`, script.fail as ErrorKind, 'mock');
  };
  const client = {
    id: `c-${model}`,
    provider: 'mock',
    model,
    api: 'completions',
    mode: 'foreground',
    batchable: false,
    hooks: new HookBus(),
    complete: async (): Promise<CompletionResponse> => {
      calls.complete += 1;
      if (script.fail) boom();
      return response(model, `answer from ${model}`);
    },
    stream: async function* (): AsyncIterable<StreamEvent> {
      calls.stream += 1;
      const before = script.emitBefore ?? 0;
      for (let i = 0; i < before; i++) {
        yield { type: 'text', text: `${model}-${i}` } as unknown as StreamEvent;
      }
      if (script.fail) boom();
      yield { type: 'text', text: `answer from ${model}` } as unknown as StreamEvent;
      yield {
        type: 'done',
        response: response(model, `answer from ${model}`),
      } as unknown as StreamEvent;
    },
    destroy() {},
  } as unknown as LLMClient;
  return { client, calls };
}

/** An agent with a primary and backups, plus the warnings it emitted. */
function agentWith(
  primary: ReturnType<typeof fake>,
  backups: Array<ReturnType<typeof fake>>,
  extra: Record<string, unknown> = {},
) {
  const hooks = new HookBus();
  const warnings: Array<Record<string, unknown>> = [];
  hooks.on('onWarning', (w) => {
    warnings.push(w as unknown as Record<string, unknown>);
  });
  const agent = new AgentLoop({
    client: primary.client,
    fallbackClients: backups.map((b) => b.client),
    hooks,
    system: 's',
    ...extra,
  } as never);
  return { agent, warnings };
}

describe('a buffered step falls over', () => {
  it('uses the backup when the primary is rate limited', async () => {
    const primary = fake('primary', { fail: 'rate_limit' });
    const backup = fake('backup');
    const { agent } = agentWith(primary, [backup]);

    const res = await agent.complete('go');
    expect(res.text).toBe('answer from backup');
    expect(primary.calls.complete).toBe(1);
    expect(backup.calls.complete).toBe(1);
  });

  it('warns, naming both models and the reason', async () => {
    // A silent fallback is a performance and cost change nobody can see.
    const { agent, warnings } = agentWith(fake('primary', { fail: 'server_error' }), [
      fake('backup'),
    ]);
    await agent.complete('go');

    const w = warnings.find((x) => x.code === 'model_fallback');
    expect(w).toBeDefined();
    expect(w?.details).toMatchObject({ from: 'primary', to: 'backup', kind: 'server_error' });
    expect(String(w?.message)).toContain('is busy');
  });

  it('does NOT fall over on a failure another model cannot fix', async () => {
    // Auth, a malformed request, a content filter: the same request fails the
    // same way everywhere, so asking every backup in turn only multiplies the
    // latency and the error.
    const primary = fake('primary', { fail: 'auth' });
    const backup = fake('backup');
    const { agent } = agentWith(primary, [backup]);

    await expect(agent.complete('go')).rejects.toThrow('primary is busy');
    expect(backup.calls.complete).toBe(0);
  });

  it('does not fall over on an unclassified error either', async () => {
    // No ErrorKind means nothing is known about whether another model would help.
    const backup = fake('backup');
    const { agent } = agentWith(fake('primary', { fail: 'plain' }), [backup]);
    await expect(agent.complete('go')).rejects.toThrow('primary broke');
    expect(backup.calls.complete).toBe(0);
  });

  it('raises the LAST error when every client fails', async () => {
    // The last provider's own message is the useful half; a wrapper saying "all
    // models failed" buries it.
    const { agent } = agentWith(fake('primary', { fail: 'rate_limit' }), [
      fake('second', { fail: 'rate_limit' }),
      fake('third', { fail: 'server_error' }),
    ]);
    await expect(agent.complete('go')).rejects.toThrow('third is busy');
  });

  it('tries each client exactly once, in order', async () => {
    // Retrying one client is the network engine's concern. Doing it here too
    // would retry a single failure twice over, at two layers.
    const primary = fake('primary', { fail: 'rate_limit' });
    const second = fake('second', { fail: 'rate_limit' });
    const third = fake('third');
    const { agent } = agentWith(primary, [second, third]);

    await agent.complete('go');
    expect([primary.calls.complete, second.calls.complete, third.calls.complete]).toEqual([1, 1, 1]);
  });

  it('honours a caller-supplied set of failure classes', async () => {
    const backup = fake('backup');
    const { agent } = agentWith(fake('primary', { fail: 'rate_limit' }), [backup], {
      fallbackOn: ['server_error'],
    });
    await expect(agent.complete('go')).rejects.toThrow('primary is busy');
    expect(backup.calls.complete).toBe(0);
  });

  it('starts every step from the primary again', async () => {
    // A rate limit is transient. A run that fell over once should not spend the
    // rest of its life on the backup.
    const primary = fake('primary');
    const backup = fake('backup');
    const { agent } = agentWith(primary, [backup]);

    await agent.complete('one');
    await agent.complete('two');
    expect(primary.calls.complete).toBe(2);
    expect(backup.calls.complete).toBe(0);
  });
});

describe('what the step is recorded as', () => {
  it('stamps the model that actually served, not the primary', async () => {
    // Provenance is model-bound: a stateful continuation is only valid against
    // the model that issued the state, so recording the primary on a turn the
    // backup produced would offer the backup's server state to the primary.
    const { agent } = agentWith(fake('primary', { fail: 'rate_limit' }), [fake('backup')]);
    await agent.complete('go');

    const last = agent.history.all().at(-1);
    expect(last?.message.origin?.model).toBe('backup');
    expect(last?.model).toBe('backup');
  });

  it('still reports the PRIMARY as the agent’s model', async () => {
    // `client.model` is read before any request is made — it cannot know who will
    // serve — and a caller asking what model this agent is configured with means
    // the primary.
    const { agent } = agentWith(fake('primary', { fail: 'rate_limit' }), [fake('backup')]);
    await agent.complete('go');
    expect(agent.model).toBe('primary');
  });
});

describe('a streamed step', () => {
  async function drain(agent: AgentLoop, input: string): Promise<string[]> {
    const texts: string[] = [];
    for await (const ev of agent.stream(input)) {
      if (ev.type === 'text') texts.push(ev.text);
    }
    return texts;
  }

  it('falls over when the primary fails before its first event', async () => {
    const primary = fake('primary', { fail: 'rate_limit', emitBefore: 0 });
    const backup = fake('backup');
    const { agent } = agentWith(primary, [backup]);

    expect((await drain(agent, 'go')).join('')).toContain('answer from backup');
    expect(backup.calls.stream).toBe(1);
  });

  it('does NOT fall over once an event has reached the consumer', async () => {
    // The rule that cannot be got wrong. The consumer has already rendered part
    // of the primary's answer; the backup would start a different one mid-
    // sentence, and the two would be spliced into a single turn.
    const primary = fake('primary', { fail: 'rate_limit', emitBefore: 2 });
    const backup = fake('backup');
    const { agent } = agentWith(primary, [backup]);

    let thrown: unknown;
    const seen: string[] = [];
    try {
      for await (const ev of agent.stream('go')) {
        if (ev.type === 'text') seen.push(ev.text);
      }
    } catch (e) {
      thrown = e;
    }
    expect(String(thrown)).toContain('primary is busy');
    // The partial output was delivered, and the backup was never asked.
    expect(seen.length).toBeGreaterThan(0);
    expect(backup.calls.stream).toBe(0);
  });

  it('stamps a streamed step with the model that served it', async () => {
    const { agent } = agentWith(fake('primary', { fail: 'rate_limit' }), [fake('backup')]);
    await drain(agent, 'go');
    expect(agent.history.all().at(-1)?.model).toBe('backup');
  });
});

describe('the chain itself', () => {
  it('needs no backups to work at all', async () => {
    // Every step takes the same path whether or not fallback is configured;
    // one-entry chains are how that stays true.
    const primary = fake('primary');
    const hooks = new HookBus();
    const agent = new AgentLoop({ client: primary.client, hooks, system: 's' } as never);
    expect((await agent.complete('go')).text).toBe('answer from primary');
  });

  it('ignores a backup that IS the primary', async () => {
    // Listing the primary again is the retry this layer is deliberately not
    // doing, so it would add a second attempt that looks like a fallback.
    const primary = fake('primary', { fail: 'rate_limit' });
    const { agent } = agentWith(primary, [primary]);
    await expect(agent.complete('go')).rejects.toThrow('primary is busy');
    expect(primary.calls.complete).toBe(1);
  });

  it('carries the backups through a restore', async () => {
    // A snapshot holds neither the client nor its backups — both are live
    // objects. A restore that silently lost them would resume a run LESS
    // resilient than the one it continues.
    const primary = fake('primary');
    const backup = fake('backup');
    const { agent } = agentWith(primary, [backup]);
    await agent.complete('first');

    const failing = fake('primary', { fail: 'rate_limit' });
    const restored = AgentLoop.restore(agent.dump(), {
      client: failing.client,
      tools: [],
      fallbackClients: [backup.client],
    });
    expect((await restored.complete('again')).text).toBe('answer from backup');
  });
});
