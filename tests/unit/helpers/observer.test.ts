/** createObserver() unit tests.
 *  createObserver wires a reactor to an agent-scoped hook event on the
 *  coreRegistry's hook bus. Tests verify:
 *   - function reactor fires only for the correct agentId
 *   - function reactor does NOT fire for a different agentId
 *   - unsubscribe() returned value stops future events
 *   - errors in the reactor emit onWarning (fire-and-forget)
 *  Uses a mock LLMClient so no network is hit.
 *  The coreRegistry engine is registered in beforeEach (setup.ts clears it). */

import { beforeEach, describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { createObserver } from '../../../src/helpers/observer';
import { coreRegistry, createEngine } from '../../../src/helpers/engine';
import { HookBus } from '../../../src/bus/hook-bus';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { RunStartContext } from '../../../src/bus/hook-map';

// ─── Mock LLMClient ───────────────────────────────────────────────────────────

function mockClient(): LLMClient {
  return {
    id: 'client-mock',
    provider: 'mock' as const,
    model: 'mock-model',
    system: undefined,
    hooks: new HookBus(),
    api: 'completions' as const,
    mode: 'foreground' as const,
    batchable: false,
    async complete(): Promise<CompletionResponse> {
      return {
        id: 'r',
        model: 'mock-model',
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        text: 'ok',
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      };
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
}

// ─── Setup -- register a coreRegistry engine ───────────────────────────────────

beforeEach(() => {
  // setup.ts clears coreRegistry before each test; install a fresh engine
  createEngine({ registerAsDefault: true });
});

// ─── Helper: emit an onRunStart event on the coreRegistry bus ─────────────────

function emitRunStart(agentId: string): void {
  const engine = coreRegistry.get();
  const ctx: RunStartContext = {
    runId: `run_${agentId}`,
    agentId,
    userMessage: 'test input',
    model: 'mock-model',
    toolNames: [],
    historyLength: 0,
  };
  engine.hooks.emitSync('onRunStart', ctx);
}

// ─── Function reactor ─────────────────────────────────────────────────────────

describe('createObserver — function reactor', () => {
  it('fires for the correct agentId', () => {
    const engine = coreRegistry.get();
    const agent = new AgentLoop({ client: mockClient(), hooks: engine.hooks });
    const seen: string[] = [];
    createObserver(agent, 'onRunStart', (ctx) => { seen.push(ctx.agentId); });

    emitRunStart(agent.id);
    expect(seen).toContain(agent.id);
  });

  it('does NOT fire for a different agentId', () => {
    const engine = coreRegistry.get();
    const agent = new AgentLoop({ client: mockClient(), hooks: engine.hooks });
    const seen: string[] = [];
    createObserver(agent, 'onRunStart', (ctx) => { seen.push(ctx.agentId); });

    emitRunStart('other-agent-id');
    expect(seen).toHaveLength(0);
  });

  it('unsubscribe stops future events', () => {
    const engine = coreRegistry.get();
    const agent = new AgentLoop({ client: mockClient(), hooks: engine.hooks });
    const seen: string[] = [];
    const unsub = createObserver(agent, 'onRunStart', (ctx) => { seen.push(ctx.agentId); });

    emitRunStart(agent.id); // fires
    unsub();
    emitRunStart(agent.id); // should NOT fire after unsubscribe
    expect(seen).toHaveLength(1);
  });

  it('returns an unsubscribe function', () => {
    const engine = coreRegistry.get();
    const agent = new AgentLoop({ client: mockClient(), hooks: engine.hooks });
    const unsub = createObserver(agent, 'onRunStart', () => {});
    expect(typeof unsub).toBe('function');
  });

  it('fires multiple times for repeated events', () => {
    const engine = coreRegistry.get();
    const agent = new AgentLoop({ client: mockClient(), hooks: engine.hooks });
    const count: number[] = [];
    createObserver(agent, 'onRunStart', () => { count.push(1); });

    emitRunStart(agent.id);
    emitRunStart(agent.id);
    emitRunStart(agent.id);
    expect(count).toHaveLength(3);
  });

  it('two agents on the same bus only each receive their own events', () => {
    const engine = coreRegistry.get();
    const agentA = new AgentLoop({ client: mockClient(), hooks: engine.hooks });
    const agentB = new AgentLoop({ client: mockClient(), hooks: engine.hooks });
    const seenA: string[] = [];
    const seenB: string[] = [];
    createObserver(agentA, 'onRunStart', () => { seenA.push('A'); });
    createObserver(agentB, 'onRunStart', () => { seenB.push('B'); });

    emitRunStart(agentA.id);
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(0);

    emitRunStart(agentB.id);
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
  });
});

// ─── Error handling -- reactor errors emit onWarning ───────────────────────────

describe('createObserver — reactor errors emit onWarning', () => {
  it('emits onWarning when the reactor throws', async () => {
    const engine = coreRegistry.get();
    const agent = new AgentLoop({ client: mockClient(), hooks: engine.hooks });

    const warnings: Array<{ code: string }> = [];
    engine.hooks.on('onWarning', (ctx) => { warnings.push(ctx); });

    createObserver(agent, 'onRunStart', async () => {
      throw new Error('reactor boom');
    });

    emitRunStart(agent.id);
    // The reactor is fire-and-forget -- wait a tick for the async rejection to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(warnings.some((w) => w.code === 'observer_failed')).toBe(true);
  });
});
