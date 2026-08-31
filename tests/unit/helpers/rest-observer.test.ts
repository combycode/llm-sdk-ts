/** createObserver() — the AGENT reactor form (the plain-function form lives in
 *  observer.test.ts).
 *
 *  Behaviour pinned here:
 *   - Passing an AgentOptions object instead of a function builds an observer
 *     agent once, at subscription time, and reuses it for every event.
 *   - The observer still filters by agentId: another agent's event must not
 *     wake it, or every observer in the process reacts to every run.
 *   - The default prompt is a JSON dump of the ctx, with Maps flattened to
 *     objects and Errors reduced to {name, message} — a raw JSON.stringify
 *     renders both as `{}`, which is what the replacer exists to prevent.
 *   - A custom `prompt` builder replaces that, and may be async.
 *   - The observer's reply is discarded; only its tool side-effects matter.
 *   - A failure anywhere in the chain (prompt builder or the observer's own
 *     completion) is reported as an `observer_agent_failed` warning naming the
 *     event and both agent ids — it must NOT reject into the hook bus.
 *
 *  No network: the observer agent runs on a stub client. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { createObserver } from '../../../src/helpers/observer';
import { coreRegistry, createEngine } from '../../../src/helpers/engine';
import { HookBus } from '../../../src/bus/hook-bus';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { RunStartContext } from '../../../src/bus/hook-map';

// ─── Stub client that records what it was asked to complete ──────────────────

interface StubClient {
  client: LLMClient;
  prompts: unknown[];
}

function recordingClient(behaviour: 'ok' | 'throw' = 'ok'): StubClient {
  const prompts: unknown[] = [];
  const client = {
    id: 'client-observer-stub',
    provider: 'anthropic' as const,
    model: 'stub-model',
    system: undefined,
    hooks: new HookBus(),
    api: 'messages' as const,
    mode: 'foreground' as const,
    batchable: false,
    async complete(input: unknown): Promise<CompletionResponse> {
      prompts.push(input);
      if (behaviour === 'throw') throw new Error('observer client boom');
      return {
        id: 'r',
        model: 'stub-model',
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        text: 'ok',
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      } as unknown as CompletionResponse;
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
  return { client, prompts };
}

beforeEach(() => {
  createEngine({ registerAsDefault: true });
});

function subjectAgent(): AgentLoop {
  return new AgentLoop({ client: recordingClient().client, hooks: coreRegistry.get().hooks });
}

/** Emit onRunStart for `agentId`, optionally with extra ctx fields. */
function emitRunStart(agentId: string, extra: Record<string, unknown> = {}): void {
  const ctx = {
    runId: `run_${agentId}`,
    agentId,
    userMessage: 'test input',
    model: 'mock-model',
    toolNames: [],
    historyLength: 0,
    ...extra,
  } as unknown as RunStartContext;
  coreRegistry.get().hooks.emitSync('onRunStart', ctx);
}

const settle = () => new Promise((r) => setTimeout(r, 10));

/** AgentLoop.complete(text) reaches the client as [{role:'user', content:text}];
 *  unwrap it back to the prompt string the observer helper produced. */
function promptText(recorded: unknown): string {
  const messages = recorded as Array<{ role: string; content: string }>;
  expect(Array.isArray(messages)).toBe(true);
  expect(messages[0].role).toBe('user');
  return messages[0].content;
}

// ─── Agent reactor ────────────────────────────────────────────────────────────

describe('createObserver — agent reactor', () => {
  it('runs the observer agent when the watched agent fires', async () => {
    const agent = subjectAgent();
    const observer = recordingClient();
    createObserver(agent, 'onRunStart', { client: observer.client });

    emitRunStart(agent.id);
    await settle();
    expect(observer.prompts).toHaveLength(1);
  });

  it('ignores events belonging to another agent', async () => {
    const agent = subjectAgent();
    const observer = recordingClient();
    createObserver(agent, 'onRunStart', { client: observer.client });

    emitRunStart('someone-else');
    await settle();
    expect(observer.prompts).toHaveLength(0);
  });

  it('reuses one observer agent across successive events (built once at subscribe time)', async () => {
    const agent = subjectAgent();
    const observer = recordingClient();
    createObserver(agent, 'onRunStart', { client: observer.client });

    emitRunStart(agent.id);
    await settle();
    emitRunStart(agent.id);
    await settle();
    expect(observer.prompts).toHaveLength(2);
  });

  // Consequence of reusing ONE AgentLoop: AgentLoop refuses a concurrent run,
  // so two events in the same tick lose the second reaction — it surfaces as a
  // warning rather than silently, but it is a real limitation of this design.
  it('drops a second event that arrives while the observer is still running', async () => {
    const agent = subjectAgent();
    const seen: Array<{ code: string; message: string }> = [];
    coreRegistry.get().hooks.on('onWarning', (ctx) => {
      seen.push(ctx as unknown as { code: string; message: string });
    });
    const observer = recordingClient();
    createObserver(agent, 'onRunStart', { client: observer.client });

    emitRunStart(agent.id);
    emitRunStart(agent.id);
    await settle();
    expect(observer.prompts).toHaveLength(1);
    expect(
      seen.some((w) => w.code === 'observer_agent_failed' && /already running/.test(w.message)),
    ).toBe(true);
  });

  it('the returned unsubscribe stops further reactions', async () => {
    const agent = subjectAgent();
    const observer = recordingClient();
    const unsub = createObserver(agent, 'onRunStart', { client: observer.client });

    emitRunStart(agent.id);
    await settle();
    unsub();
    emitRunStart(agent.id);
    await settle();
    expect(observer.prompts).toHaveLength(1);
  });

  it('does not pass the `prompt` builder through to createAgent as an agent option', async () => {
    const agent = subjectAgent();
    const observer = recordingClient();
    // `prompt` is consumed by the observer helper; leaving it on the options
    // bag would hand AgentLoop an unknown field.
    expect(() =>
      createObserver(agent, 'onRunStart', { client: observer.client, prompt: () => 'x' }),
    ).not.toThrow();
    emitRunStart(agent.id);
    await settle();
    expect(promptText(observer.prompts[0])).toBe('x');
  });
});

// ─── Prompt rendering ─────────────────────────────────────────────────────────

describe('createObserver — prompt rendering', () => {
  it('defaults to a pretty JSON dump of the event ctx', async () => {
    const agent = subjectAgent();
    const observer = recordingClient();
    createObserver(agent, 'onRunStart', { client: observer.client });

    emitRunStart(agent.id);
    await settle();
    const prompt = promptText(observer.prompts[0]);
    const parsed = JSON.parse(prompt) as Record<string, unknown>;
    expect(parsed.agentId).toBe(agent.id);
    expect(parsed.userMessage).toBe('test input');
    expect(prompt).toContain('\n  '); // 2-space indented, i.e. readable
  });

  it('flattens a Map in the ctx to an object instead of "{}"', async () => {
    const agent = subjectAgent();
    const observer = recordingClient();
    createObserver(agent, 'onRunStart', { client: observer.client });

    emitRunStart(agent.id, { counters: new Map([['tokens', 42]]) });
    await settle();
    const parsed = JSON.parse(promptText(observer.prompts[0])) as { counters: unknown };
    expect(parsed.counters).toEqual({ tokens: 42 });
  });

  it('reduces an Error in the ctx to name + message instead of "{}"', async () => {
    const agent = subjectAgent();
    const observer = recordingClient();
    createObserver(agent, 'onRunStart', { client: observer.client });

    emitRunStart(agent.id, { failure: new TypeError('bad shape') });
    await settle();
    const parsed = JSON.parse(promptText(observer.prompts[0])) as { failure: unknown };
    expect(parsed.failure).toEqual({ name: 'TypeError', message: 'bad shape' });
  });

  it('leaves ordinary values untouched', async () => {
    const agent = subjectAgent();
    const observer = recordingClient();
    createObserver(agent, 'onRunStart', { client: observer.client });

    emitRunStart(agent.id, { nested: { a: [1, 2], b: null } });
    await settle();
    const parsed = JSON.parse(promptText(observer.prompts[0])) as { nested: unknown };
    expect(parsed.nested).toEqual({ a: [1, 2], b: null });
  });

  it('a custom prompt builder replaces the JSON dump', async () => {
    const agent = subjectAgent();
    const observer = recordingClient();
    createObserver(agent, 'onRunStart', {
      client: observer.client,
      prompt: (ctx) => `run ${ctx.runId} started`,
    });

    emitRunStart(agent.id);
    await settle();
    expect(promptText(observer.prompts[0])).toBe(`run run_${agent.id} started`);
  });

  it('an async prompt builder is awaited before the observer runs', async () => {
    const agent = subjectAgent();
    const observer = recordingClient();
    createObserver(agent, 'onRunStart', {
      client: observer.client,
      prompt: async () => 'resolved later',
    });

    emitRunStart(agent.id);
    await settle();
    expect(promptText(observer.prompts[0])).toBe('resolved later');
  });
});

// ─── Failure reporting ────────────────────────────────────────────────────────

describe('createObserver — agent reactor failures', () => {
  function warnings(): Array<{ code: string; message: string; details?: Record<string, unknown> }> {
    const out: Array<{ code: string; message: string; details?: Record<string, unknown> }> = [];
    coreRegistry.get().hooks.on('onWarning', (ctx) => {
      out.push(ctx as unknown as { code: string; message: string; details?: Record<string, unknown> });
    });
    return out;
  }

  it('reports a failing observer completion as observer_agent_failed', async () => {
    const agent = subjectAgent();
    const seen = warnings();
    const observer = recordingClient('throw');
    createObserver(agent, 'onRunStart', { client: observer.client });

    emitRunStart(agent.id);
    await settle();
    const warn = seen.find((w) => w.code === 'observer_agent_failed');
    expect(warn).toBeDefined();
    expect(warn?.message).toContain('observer client boom');
    expect(warn?.details).toMatchObject({ event: 'onRunStart', agentId: agent.id });
    expect(typeof warn?.details?.observerId).toBe('string');
  });

  it('reports a REJECTING prompt builder as observer_agent_failed', async () => {
    const agent = subjectAgent();
    const seen = warnings();
    const observer = recordingClient();
    createObserver(agent, 'onRunStart', {
      client: observer.client,
      prompt: async () => {
        throw new Error('prompt boom');
      },
    });

    emitRunStart(agent.id);
    await settle();
    expect(seen.some((w) => w.code === 'observer_agent_failed' && w.message.includes('prompt boom')))
      .toBe(true);
    expect(observer.prompts).toHaveLength(0);
  });

  // Documented asymmetry, not an aspiration: the helper wraps the builder in
  // `Promise.resolve(renderPrompt(ctx))`, so a builder that throws SYNCHRONOUSLY
  // throws before there is a promise to catch and the error escapes into the
  // emitter. Only a rejected promise is converted into a warning.
  it('lets a synchronously-throwing prompt builder escape to the emitter', () => {
    const agent = subjectAgent();
    warnings();
    const observer = recordingClient();
    createObserver(agent, 'onRunStart', {
      client: observer.client,
      prompt: () => {
        throw new Error('sync prompt boom');
      },
    });

    expect(() => emitRunStart(agent.id)).toThrow(/sync prompt boom/);
    expect(observer.prompts).toHaveLength(0);
  });

  it('a failing observer does not stop the next event from being observed', async () => {
    const agent = subjectAgent();
    warnings();
    const observer = recordingClient('throw');
    createObserver(agent, 'onRunStart', { client: observer.client });

    emitRunStart(agent.id);
    await settle();
    emitRunStart(agent.id);
    await settle();
    expect(observer.prompts).toHaveLength(2);
  });
});
