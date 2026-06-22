/** ToolExecutionContext.trace unit tests.
 *  Verifies that ctx.trace.sessionId, ctx.trace.requestId, and ctx.trace.callId
 *  are populated correctly when a tool is executed through AgentLoop. */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import type { AgentTool, ToolExecutionContext } from '../../../src/agent/types';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { Message, ContentPart } from '../../../src/llm/types/messages';
import type { ExecuteOptions } from '../../../src/llm/types/options';

// ─── Mock helpers ────────────────────────────────────────────────────────────

function makeMockClient(
  responses: Array<Partial<CompletionResponse> & { content?: ContentPart[] }>,
): LLMClient {
  const queue = [...responses];
  return {
    id: 'mock-client',
    provider: 'mock' as const,
    model: 'mock-model',
    system: undefined,
    hooks: new HookBus(),
    api: 'completions' as const,
    mode: 'foreground' as const,
    batchable: false,
    async complete(_input: Message[], _options: ExecuteOptions): Promise<CompletionResponse> {
      const next = queue.shift();
      const content = next?.content ?? [{ type: 'text' as const, text: 'done' }];
      return {
        id: next?.id ?? 'r-1',
        model: 'mock-model',
        content,
        finishReason: next?.finishReason ?? 'stop',
        usage: next?.usage ?? {
          inputTokens: 1, outputTokens: 1, totalTokens: 2,
          cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        },
        text: next?.text ?? content
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join(''),
        toolCalls: next?.toolCalls ?? content.filter((p) => p.type === 'tool_call'),
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      } as CompletionResponse;
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
}

function makeCapturingTool(captured: { ctx?: ToolExecutionContext }): AgentTool {
  return {
    definition: { name: 'capture', description: 'Captures ctx', parameters: {} },
    async execute(_args, ctx) {
      captured.ctx = ctx;
      return 'captured';
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ToolExecutionContext.trace', () => {
  it('ctx.trace.sessionId equals loop.id (the agent/history id)', async () => {
    const captured: { ctx?: ToolExecutionContext } = {};
    const tool = makeCapturingTool(captured);
    const TOOL_CALL_ID = 'tc-001';

    const client = makeMockClient([
      {
        content: [{ type: 'tool_call', id: TOOL_CALL_ID, name: 'capture', arguments: {} }],
        finishReason: 'tool_use',
        toolCalls: [{ type: 'tool_call', id: TOOL_CALL_ID, name: 'capture', arguments: {} }],
      },
      { content: [{ type: 'text', text: 'done' }] },
    ]);

    const loop = new AgentLoop({ client, tools: [tool] });
    await loop.complete('go');

    expect(captured.ctx).toBeDefined();
    expect(captured.ctx!.trace).toBeDefined();
    expect(captured.ctx!.trace!.sessionId).toBe(loop.id);
  });

  it('ctx.trace.requestId is a non-empty string (the runId)', async () => {
    const captured: { ctx?: ToolExecutionContext } = {};
    const tool = makeCapturingTool(captured);
    const TOOL_CALL_ID = 'tc-002';

    const client = makeMockClient([
      {
        content: [{ type: 'tool_call', id: TOOL_CALL_ID, name: 'capture', arguments: {} }],
        finishReason: 'tool_use',
        toolCalls: [{ type: 'tool_call', id: TOOL_CALL_ID, name: 'capture', arguments: {} }],
      },
      { content: [{ type: 'text', text: 'done' }] },
    ]);

    const loop = new AgentLoop({ client, tools: [tool] });
    await loop.complete('go');

    expect(captured.ctx!.trace!.requestId).toBeTypeOf('string');
    expect(captured.ctx!.trace!.requestId!.length).toBeGreaterThan(0);
  });

  it('ctx.trace.callId equals ctx.callId', async () => {
    const captured: { ctx?: ToolExecutionContext } = {};
    const tool = makeCapturingTool(captured);
    const TOOL_CALL_ID = 'tc-003';

    const client = makeMockClient([
      {
        content: [{ type: 'tool_call', id: TOOL_CALL_ID, name: 'capture', arguments: {} }],
        finishReason: 'tool_use',
        toolCalls: [{ type: 'tool_call', id: TOOL_CALL_ID, name: 'capture', arguments: {} }],
      },
      { content: [{ type: 'text', text: 'done' }] },
    ]);

    const loop = new AgentLoop({ client, tools: [tool] });
    await loop.complete('go');

    expect(captured.ctx!.trace!.callId).toBe(captured.ctx!.callId);
    expect(captured.ctx!.trace!.callId).toBe(TOOL_CALL_ID);
  });

  it('different runs of the same loop produce different requestIds but the same sessionId', async () => {
    const requestIds: string[] = [];

    const tool: AgentTool = {
      definition: { name: 'capture', description: 'Captures ctx', parameters: {} },
      async execute(_args, ctx) {
        requestIds.push(ctx.trace!.requestId!);
        return 'captured';
      },
    };

    const TOOL_CALL_ID = 'tc-multi';
    const makeToolCallResponse = () => ({
      content: [{ type: 'tool_call' as const, id: TOOL_CALL_ID, name: 'capture', arguments: {} }],
      finishReason: 'tool_use' as const,
      toolCalls: [{ type: 'tool_call' as const, id: TOOL_CALL_ID, name: 'capture', arguments: {} }],
    });

    const client = makeMockClient([
      makeToolCallResponse(),
      { content: [{ type: 'text', text: 'done' }] },
      makeToolCallResponse(),
      { content: [{ type: 'text', text: 'done' }] },
    ]);

    const loop = new AgentLoop({ client, tools: [tool] });
    await loop.complete('first');
    await loop.complete('second');

    expect(requestIds.length).toBe(2);
    expect(requestIds[0]).not.toBe(requestIds[1]);
  });
});
