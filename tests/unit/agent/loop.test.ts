/** AgentLoop unit tests with a mock LLMClient. Validates:
 *  - input shapes (string, ContentPart[], Message[]) APPEND to history
 *  - tool execution and multi-step loop (response with tool_use -> tool_result -> next call)
 *  - hook emission across the full agent lifecycle
 *  - lastReport getter, totalUsage accumulation
 *  - stop() cancels mid-run
 *  - restore from snapshot warns on tool drift
 *  - maxSteps cap: stops at DEFAULT_MAX_STEPS when unset; honours custom value */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { AgentLoop, DEFAULT_MAX_STEPS } from '../../../src/agent/loop';
import { ConversationHistory } from '../../../src/agent/history';
import type { AgentTool } from '../../../src/agent/types';
import type { LLMClient } from '../../../src/llm/client';
import type { Message, ContentPart } from '../../../src/llm/types/messages';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ExecuteOptions } from '../../../src/llm/types/options';

// ─── Mock LLMClient ─────────────────────────────────────────────────────

interface MockClientOptions {
  responses?: Array<Partial<CompletionResponse> & { content?: ContentPart[] }>;
  hooks?: HookBus;
  model?: string;
}

function makeMockClient(opts: MockClientOptions = {}): LLMClient & {
  calls: Array<{ messages: Message[]; options: ExecuteOptions }>;
} {
  const queue = [...(opts.responses ?? [])];
  const calls: Array<{ messages: Message[]; options: ExecuteOptions }> = [];

  const mock = {
    id: 'client-mock',
    provider: 'mock' as const,
    model: opts.model ?? 'mock-model',
    system: undefined,
    hooks: opts.hooks ?? new HookBus(),
    api: 'completions' as const,
    mode: 'foreground' as const,
    batchable: false,
    calls,
    async complete(input: unknown, options: ExecuteOptions = {}): Promise<CompletionResponse> {
      calls.push({ messages: input as Message[], options });
      const next = queue.shift();
      const content = next?.content ?? [{ type: 'text', text: 'done' }];
      return {
        id: next?.id ?? `r-${calls.length}`,
        model: opts.model ?? 'mock-model',
        content,
        finishReason: next?.finishReason ?? 'stop',
        usage: next?.usage ?? {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        text:
          next?.text ??
          content
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join(''),
        toolCalls: next?.toolCalls ?? content.filter((p) => p.type === 'tool_call'),
        thinking: next?.thinking ?? null,
        media: next?.media ?? [],
        latencyMs: next?.latencyMs ?? 1,
        raw: next?.raw ?? null,
      } as CompletionResponse;
    },
    async *stream(_input: unknown, _options: ExecuteOptions = {}) {
      const next = queue.shift();
      const content = next?.content ?? [{ type: 'text', text: 'streamed' }];
      for (const p of content) {
        if (p.type === 'text') yield { type: 'text' as const, text: p.text };
        else if (p.type === 'tool_call') {
          yield { type: 'tool_call_start' as const, id: p.id, name: p.name };
          yield {
            type: 'tool_call_delta' as const,
            id: p.id,
            arguments: JSON.stringify(p.arguments),
          };
        }
      }
      yield {
        type: 'usage' as const,
        usage: next?.usage ?? {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      };
      yield { type: 'done' as const, finishReason: next?.finishReason ?? 'stop' };
    },
    destroy() {},
  } as unknown as LLMClient & {
    calls: Array<{ messages: Message[]; options: ExecuteOptions }>;
  };

  return mock;
}

function makeTool(name: string, fn: (args: Record<string, unknown>) => Promise<string>): AgentTool {
  return {
    definition: { name, description: `Tool ${name}`, parameters: {} },
    execute: async (args) => fn(args),
  };
}

// ─── Construction ──────────────────────────────────────────────────────

describe('AgentLoop — construction', () => {
  it('reads model from client', () => {
    const client = makeMockClient({ model: 'foo-model' });
    const loop = new AgentLoop({ client });
    expect(loop.model).toBe('foo-model');
  });

  it('creates fresh history when none provided', () => {
    const loop = new AgentLoop({ client: makeMockClient() });
    expect(loop.history).toBeInstanceOf(ConversationHistory);
    expect(loop.history.length).toBe(0);
  });

  it('reuses given history', () => {
    const history = new ConversationHistory('h-1');
    history.append({ role: 'user', content: 'prior' });
    const loop = new AgentLoop({ client: makeMockClient(), history });
    expect(loop.history).toBe(history);
    expect(loop.history.length).toBe(1);
  });

  it('rehydrates from snapshot', () => {
    const history = new ConversationHistory('h-2');
    history.append({ role: 'user', content: 'a' });
    const snapshot = history.export();
    const loop = new AgentLoop({ client: makeMockClient(), history: snapshot });
    expect(loop.history.length).toBe(1);
  });

  it('publishes system + context into history.registry', () => {
    const loop = new AgentLoop({
      client: makeMockClient(),
      system: 'You are a helper.',
      context: 'Background: testing.',
    });
    expect(loop.history.registry.get('agentloop.system')?.content).toBe('You are a helper.');
    expect(loop.history.registry.get('agentloop.context')?.content).toBe('Background: testing.');
  });

  it('emits onAgentCreate', () => {
    const hooks = new HookBus();
    const events: unknown[] = [];
    hooks.on('onAgentCreate', (ctx) => {
      events.push(ctx);
    });
    new AgentLoop({ client: makeMockClient(), hooks });
    expect(events.length).toBe(1);
  });

  it('throws when client missing', () => {
    expect(() => new AgentLoop({ client: undefined as unknown as LLMClient })).toThrow();
  });
});

describe('AgentLoop — system/context setters update registry', () => {
  it('system setter updates layer', () => {
    const loop = new AgentLoop({ client: makeMockClient(), system: 'a' });
    loop.system = 'b';
    expect(loop.history.registry.get('agentloop.system')?.content).toBe('b');
  });

  it('context setter updates layer', () => {
    const loop = new AgentLoop({ client: makeMockClient(), context: 'a' });
    loop.context = 'b';
    expect(loop.history.registry.get('agentloop.context')?.content).toBe('b');
  });
});

// ─── complete() — input shapes append ────────────────────────────────────

describe('AgentLoop — complete input shapes append to history', () => {
  it('string input appends as user', async () => {
    const client = makeMockClient();
    const loop = new AgentLoop({ client });
    await loop.complete('hi');
    expect(loop.history.length).toBe(2); // user + assistant
    expect(loop.history.at(0)?.message).toEqual({ role: 'user', content: 'hi' });
  });

  it('ContentPart[] input wraps as user', async () => {
    const loop = new AgentLoop({ client: makeMockClient() });
    await loop.complete([{ type: 'text', text: 'hello' }]);
    expect(loop.history.at(0)?.message).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  it('Message[] input appends each message', async () => {
    const loop = new AgentLoop({ client: makeMockClient() });
    await loop.complete([
      { role: 'system', content: 'inline-sys' },
      { role: 'user', content: 'q' },
    ]);
    // Should have appended sys + user; then assistant from response.
    expect(loop.history.length).toBe(3);
    expect(loop.history.at(0)?.message.role).toBe('system');
  });
});

// ─── complete() — single step (no tool calls) ──────────────────────────

describe('AgentLoop — complete (single step)', () => {
  it('returns CompletionResponse with text from final step', async () => {
    const client = makeMockClient({
      responses: [{ content: [{ type: 'text', text: 'answer' }] }],
    });
    const loop = new AgentLoop({ client });
    const res = await loop.complete('hi');
    expect(res.text).toBe('answer');
    expect(res.finishReason).toBe('stop');
  });

  it('lastReport captures step details', async () => {
    const client = makeMockClient({
      responses: [{ content: [{ type: 'text', text: 'answer' }] }],
    });
    const loop = new AgentLoop({ client });
    await loop.complete('hi');
    expect(loop.lastReport).toBeDefined();
    expect(loop.lastReport?.stepCount).toBe(1);
    expect(loop.lastReport?.toolCallCount).toBe(0);
    expect(loop.lastReport?.reason).toBe('done');
  });

  it('totalUsage accumulates from response', async () => {
    const client = makeMockClient({
      responses: [
        {
          content: [{ type: 'text', text: 'x' }],
          usage: {
            inputTokens: 5,
            outputTokens: 3,
            totalTokens: 8,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        },
      ],
    });
    const loop = new AgentLoop({ client });
    const res = await loop.complete('hi');
    expect(res.usage.inputTokens).toBe(5);
    expect(res.usage.outputTokens).toBe(3);
  });
});

// ─── complete() — tool loop ────────────────────────────────────────────

describe('AgentLoop — tool execution loop', () => {
  it('executes tool and continues until model stops', async () => {
    const callsRecorded: string[] = [];
    const lookup = makeTool('lookup', async (args) => {
      callsRecorded.push(`lookup(${JSON.stringify(args)})`);
      return 'result-data';
    });

    const client = makeMockClient({
      responses: [
        {
          content: [{ type: 'tool_call', id: 'c1', name: 'lookup', arguments: { q: 'x' } }],
          finishReason: 'tool_use',
          toolCalls: [{ type: 'tool_call', id: 'c1', name: 'lookup', arguments: { q: 'x' } }],
        },
        { content: [{ type: 'text', text: 'final' }] },
      ],
    });

    const loop = new AgentLoop({ client, tools: [lookup] });
    const res = await loop.complete('hi');
    expect(res.text).toBe('final');
    expect(callsRecorded).toEqual(['lookup({"q":"x"})']);
    expect(loop.lastReport?.stepCount).toBe(2);
    expect(loop.lastReport?.toolCallCount).toBe(1);
  });

  it('records ToolCallReport (latency, sizeBytes, no error)', async () => {
    const lookup = makeTool('lookup', async () => 'ok');
    const client = makeMockClient({
      responses: [
        {
          content: [{ type: 'tool_call', id: 'c1', name: 'lookup', arguments: {} }],
          finishReason: 'tool_use',
          toolCalls: [{ type: 'tool_call', id: 'c1', name: 'lookup', arguments: {} }],
        },
        { content: [{ type: 'text', text: 'done' }] },
      ],
    });
    const loop = new AgentLoop({ client, tools: [lookup] });
    await loop.complete('go');
    const report = loop.lastReport;
    const toolReports = report?.steps[0].toolCalls ?? [];
    expect(toolReports.length).toBe(1);
    expect(toolReports[0].error).toBeNull();
    expect(toolReports[0].resultSizeBytes).toBe(2); // 'ok'
  });

  it('handles unknown tool gracefully (writes error result)', async () => {
    const client = makeMockClient({
      responses: [
        {
          content: [{ type: 'tool_call', id: 'c1', name: 'unknown', arguments: {} }],
          finishReason: 'tool_use',
          toolCalls: [{ type: 'tool_call', id: 'c1', name: 'unknown', arguments: {} }],
        },
        { content: [{ type: 'text', text: 'done' }] },
      ],
    });
    const loop = new AgentLoop({ client });
    const res = await loop.complete('go');
    expect(res.text).toBe('done');
    const toolMsg = loop.history.byRole('tool')[0];
    const part = (toolMsg.message.content as ContentPart[])[0];
    expect(part.type).toBe('tool_result');
    expect((part as { content: string }).content).toContain('unknown');
  });

  it('thrown tool sends fallback error string back to model', async () => {
    const flaky = makeTool('flaky', async () => {
      throw new Error('boom');
    });
    const client = makeMockClient({
      responses: [
        {
          content: [{ type: 'tool_call', id: 'c1', name: 'flaky', arguments: {} }],
          finishReason: 'tool_use',
          toolCalls: [{ type: 'tool_call', id: 'c1', name: 'flaky', arguments: {} }],
        },
        { content: [{ type: 'text', text: 'recovered' }] },
      ],
    });
    const loop = new AgentLoop({ client, tools: [flaky] });
    const res = await loop.complete('go');
    expect(res.text).toBe('recovered');
    const toolReport = loop.lastReport?.steps[0].toolCalls[0];
    expect(toolReport?.error).toBe('boom');
  });
});

// ─── Hooks ─────────────────────────────────────────────────────────────

describe('AgentLoop — hook emission', () => {
  it('emits run/step/tool hooks in order', async () => {
    const hooks = new HookBus();
    const fired: string[] = [];
    for (const h of [
      'onAgentCreate',
      'onRunStart',
      'onStepStart',
      'onStepComplete',
      'onToolCallStart',
      'onToolCallComplete',
      'onRunComplete',
    ] as const) {
      hooks.on(h, () => {
        fired.push(h);
      });
    }

    const tool = makeTool('t', async () => 'ok');
    const client = makeMockClient({
      hooks,
      responses: [
        {
          content: [{ type: 'tool_call', id: 'c1', name: 't', arguments: {} }],
          finishReason: 'tool_use',
          toolCalls: [{ type: 'tool_call', id: 'c1', name: 't', arguments: {} }],
        },
        { content: [{ type: 'text', text: 'done' }] },
      ],
    });
    const loop = new AgentLoop({ client, hooks, tools: [tool] });
    await loop.complete('go');

    expect(fired[0]).toBe('onAgentCreate');
    expect(fired).toContain('onRunStart');
    expect(fired).toContain('onStepStart');
    expect(fired).toContain('onStepComplete');
    expect(fired).toContain('onToolCallStart');
    expect(fired).toContain('onToolCallComplete');
    expect(fired[fired.length - 1]).toBe('onRunComplete');
  });

  it('emits onRunError on thrown LLM call', async () => {
    const hooks = new HookBus();
    const errors: unknown[] = [];
    hooks.on('onRunError', (ctx) => {
      errors.push(ctx);
    });

    const client = {
      ...makeMockClient({ hooks }),
      complete: async () => {
        throw new Error('llm-down');
      },
    } as unknown as LLMClient;

    const loop = new AgentLoop({ client, hooks });
    const res = await loop.complete('go');
    expect(res.finishReason).toBe('error');
    expect(errors.length).toBe(1);
  });

  it('hook can override tool result via overrideResult', async () => {
    const hooks = new HookBus();
    hooks.on('onToolCallStart', (ctx) => {
      ctx.overrideResult = 'overridden';
    });

    const tool = makeTool('t', async () => 'real');
    const client = makeMockClient({
      hooks,
      responses: [
        {
          content: [{ type: 'tool_call', id: 'c1', name: 't', arguments: {} }],
          finishReason: 'tool_use',
          toolCalls: [{ type: 'tool_call', id: 'c1', name: 't', arguments: {} }],
        },
        { content: [{ type: 'text', text: 'done' }] },
      ],
    });
    const loop = new AgentLoop({ client, hooks, tools: [tool] });
    await loop.complete('go');
    const part = (loop.history.byRole('tool')[0].message.content as ContentPart[])[0];
    expect((part as { content: string }).content).toBe('overridden');
  });
});

// ─── Stop / re-entry ───────────────────────────────────────────────────

describe('AgentLoop — lifecycle', () => {
  it('throws when complete() is called concurrently', async () => {
    const client = makeMockClient({
      responses: [{ content: [{ type: 'text', text: 'done' }] }],
    });
    const loop = new AgentLoop({ client });
    const p1 = loop.complete('first');
    await expect(loop.complete('second')).rejects.toThrow(/already running/);
    await p1;
  });

  it('stop() requested mid-run halts before next iteration', async () => {
    const tool = makeTool('t', async () => 'ok');
    const client = makeMockClient({
      responses: [
        {
          content: [{ type: 'tool_call', id: 'c1', name: 't', arguments: {} }],
          finishReason: 'tool_use',
          toolCalls: [{ type: 'tool_call', id: 'c1', name: 't', arguments: {} }],
        },
        { content: [{ type: 'text', text: 'should-not-reach' }] },
      ],
    });
    const hooks = new HookBus();
    const loop = new AgentLoop({ client, hooks, tools: [tool] });
    // Stop after the first tool call completes — should prevent the second LLM step.
    hooks.on('onToolCallComplete', () => {
      loop.stop();
    });
    const res = await loop.complete('go');
    expect(loop.lastReport?.reason).toBe('stopped');
    expect(loop.lastReport?.stepCount).toBe(1);
    // text was from first step (a tool_use, no text); response should reflect stopped.
    expect(res.finishReason).toBe('stop');
  });

  it('destroy() emits onAgentDestroy', () => {
    const hooks = new HookBus();
    const events: unknown[] = [];
    hooks.on('onAgentDestroy', (ctx) => {
      events.push(ctx);
    });
    const loop = new AgentLoop({ client: makeMockClient(), hooks });
    loop.destroy();
    expect(events.length).toBe(1);
  });
});

// ─── Snapshot ──────────────────────────────────────────────────────────

describe('AgentLoop — dump/restore', () => {
  it('dump returns snapshot with system/context/history/tools', () => {
    const tool = makeTool('t', async () => 'ok');
    const loop = new AgentLoop({
      client: makeMockClient(),
      system: 'sys',
      context: 'ctx',
      tools: [tool],
    });
    const snap = loop.dump();
    expect(snap.system).toBe('sys');
    expect(snap.context).toBe('ctx');
    expect(snap.toolNames).toEqual(['t']);
  });

  it('restore creates new loop with same history + system', () => {
    const tool = makeTool('t', async () => 'ok');
    const loop = new AgentLoop({
      client: makeMockClient(),
      system: 'sys',
      tools: [tool],
    });
    loop.history.append({ role: 'user', content: 'old' });
    const snap = loop.dump();

    const restored = AgentLoop.restore(snap, {
      client: makeMockClient(),
      tools: [tool],
    });
    expect(restored.system).toBe('sys');
    expect(restored.history.length).toBe(1);
  });

  it('restore warns when tool removed from new config', () => {
    const original = makeTool('t', async () => 'ok');
    const loop = new AgentLoop({
      client: makeMockClient(),
      tools: [original],
    });
    const snap = loop.dump();

    const newHooks = new HookBus();
    const warnings: unknown[] = [];
    newHooks.on('onWarning', (ctx) => {
      warnings.push(ctx);
    });
    AgentLoop.restore(snap, {
      client: makeMockClient(),
      hooks: newHooks,
      tools: [],
    });
    expect(warnings.some((w) => (w as { code: string }).code === 'tool_removed')).toBe(true);
  });
});

// ─── maxSteps cap ──────────────────────────────────────────────────────────

/** Build a mock client that always responds with a tool_use (no final text step). */
function makeInfiniteToolClient(): LLMClient & {
  calls: Array<{ messages: Message[]; options: ExecuteOptions }>;
} {
  const calls: Array<{ messages: Message[]; options: ExecuteOptions }> = [];
  const mock = {
    id: 'client-infinite',
    provider: 'mock' as const,
    model: 'mock-model',
    system: undefined,
    hooks: new HookBus(),
    api: 'completions' as const,
    mode: 'foreground' as const,
    batchable: false,
    calls,
    async complete(input: unknown, options: ExecuteOptions = {}): Promise<CompletionResponse> {
      calls.push({ messages: input as Message[], options });
      const tc: ContentPart = { type: 'tool_call', id: `c${calls.length}`, name: 'loop_tool', arguments: {} };
      return {
        id: `r-${calls.length}`,
        model: 'mock-model',
        content: [tc],
        finishReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        text: '',
        toolCalls: [tc as import('../../../src/llm/types/messages').ToolCallPart],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      } as CompletionResponse;
    },
    async *stream(_input: unknown, _options: ExecuteOptions = {}) {
      calls.push({ messages: _input as Message[], options: _options });
      const id = `c${calls.length}`;
      yield { type: 'tool_call_start' as const, id, name: 'loop_tool' };
      yield { type: 'tool_call_delta' as const, id, arguments: '{}' };
      yield { type: 'usage' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
      yield { type: 'done' as const, finishReason: 'tool_use' };
    },
    destroy() {},
  } as unknown as LLMClient & { calls: Array<{ messages: Message[]; options: ExecuteOptions }> };
  return mock;
}

describe('AgentLoop — maxSteps cap (complete)', () => {
  const loopTool = makeTool('loop_tool', async () => 'keep-going');

  it('stops at DEFAULT_MAX_STEPS when maxSteps is not configured', async () => {
    const client = makeInfiniteToolClient();
    const loop = new AgentLoop({ client, tools: [loopTool] });
    const res = await loop.complete('go');
    expect(loop.lastReport?.reason).toBe('max_steps');
    expect(loop.lastReport?.stepCount).toBe(DEFAULT_MAX_STEPS);
    expect(client.calls.length).toBe(DEFAULT_MAX_STEPS);
    expect(res.finishReason).toBe('length');
    expect(res.text).toContain(`maxSteps (${DEFAULT_MAX_STEPS})`);
  });

  it('respects a custom maxSteps value', async () => {
    const client = makeInfiniteToolClient();
    const loop = new AgentLoop({ client, tools: [loopTool], maxSteps: 3 });
    const res = await loop.complete('go');
    expect(loop.lastReport?.reason).toBe('max_steps');
    expect(loop.lastReport?.stepCount).toBe(3);
    expect(client.calls.length).toBe(3);
    expect(res.finishReason).toBe('length');
    expect(res.text).toContain('maxSteps (3)');
  });

  it('treats maxSteps <= 0 as default', async () => {
    const client = makeInfiniteToolClient();
    const loop = new AgentLoop({ client, tools: [loopTool], maxSteps: 0 });
    await loop.complete('go');
    expect(loop.lastReport?.stepCount).toBe(DEFAULT_MAX_STEPS);
  });

  it('does not cap a run that completes naturally within the limit', async () => {
    const client = makeMockClient({
      responses: [
        {
          content: [{ type: 'tool_call', id: 'c1', name: 'loop_tool', arguments: {} }],
          finishReason: 'tool_use',
          toolCalls: [{ type: 'tool_call', id: 'c1', name: 'loop_tool', arguments: {} }],
        },
        { content: [{ type: 'text', text: 'done naturally' }] },
      ],
    });
    const loop = new AgentLoop({ client, tools: [loopTool], maxSteps: 5 });
    const res = await loop.complete('go');
    expect(loop.lastReport?.reason).toBe('done');
    expect(res.finishReason).toBe('stop');
    expect(res.text).toBe('done naturally');
  });
});

describe('AgentLoop — maxSteps cap (stream)', () => {
  const loopTool = makeTool('loop_tool', async () => 'keep-going');

  it('stops at DEFAULT_MAX_STEPS when maxSteps is not configured', async () => {
    const client = makeInfiniteToolClient();
    const loop = new AgentLoop({ client, tools: [loopTool] });
    const events: string[] = [];
    for await (const ev of loop.stream('go')) {
      events.push(ev.type);
    }
    expect(loop.lastReport?.reason).toBe('max_steps');
    expect(loop.lastReport?.stepCount).toBe(DEFAULT_MAX_STEPS);
    expect(events[events.length - 1]).toBe('done');
    const doneEv = events[events.length - 1];
    expect(doneEv).toBe('done');
  });

  it('respects a custom maxSteps value in stream', async () => {
    const client = makeInfiniteToolClient();
    const loop = new AgentLoop({ client, tools: [loopTool], maxSteps: 2 });
    for await (const _ev of loop.stream('go')) { /* drain */ }
    expect(loop.lastReport?.reason).toBe('max_steps');
    expect(loop.lastReport?.stepCount).toBe(2);
    expect(client.calls.length).toBe(2);
  });

  it('stream done event carries finishReason length and stop text', async () => {
    const client = makeInfiniteToolClient();
    const loop = new AgentLoop({ client, tools: [loopTool], maxSteps: 1 });
    let doneResponse: CompletionResponse | null = null;
    for await (const ev of loop.stream('go')) {
      if (ev.type === 'done') doneResponse = ev.response;
    }
    expect(doneResponse?.finishReason).toBe('length');
    expect(doneResponse?.text).toContain('maxSteps (1)');
  });
});
