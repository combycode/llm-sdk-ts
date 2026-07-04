/** #7 — tool-output custom data: an AgentTool.customDataExtractor attaches
 *  out-of-band metadata to the ToolCallReport (the model never sees it), and a
 *  throwing extractor never breaks the tool result. */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import type { AgentTool } from '../../../src/agent/types';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ContentPart, Message } from '../../../src/llm/types/messages';
import type { ExecuteOptions } from '../../../src/llm/types/options';

function mockClient(responses: Array<Partial<CompletionResponse> & { content?: ContentPart[] }>): LLMClient {
  const queue = [...responses];
  return {
    id: 'mock', provider: 'mock', model: 'm', system: undefined, hooks: new HookBus(),
    api: 'completions', mode: 'foreground', batchable: false,
    async complete(_i: Message[], _o: ExecuteOptions): Promise<CompletionResponse> {
      const next = queue.shift();
      const content = next?.content ?? [{ type: 'text' as const, text: 'done' }];
      return {
        id: 'r', model: 'm', content, finishReason: next?.finishReason ?? 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        text: next?.text ?? '', toolCalls: next?.toolCalls ?? content.filter((p) => p.type === 'tool_call'),
        thinking: null, media: [], latencyMs: 1, raw: null,
      } as CompletionResponse;
    },
    async *stream() {}, destroy() {},
  } as unknown as LLMClient;
}

function toolCallTurn(id: string, name: string) {
  return {
    content: [{ type: 'tool_call' as const, id, name, arguments: {} }],
    finishReason: 'tool_use' as const,
    toolCalls: [{ type: 'tool_call' as const, id, name, arguments: {} }],
  };
}

describe('#7 tool-output custom data', () => {
  it('customDataExtractor result lands on the ToolCallReport (not in the model result)', async () => {
    const tool: AgentTool = {
      definition: { name: 'lookup', description: 'x', parameters: {} },
      async execute() {
        return 'ROW DATA';
      },
      customDataExtractor: (result, args, ctx) => ({
        bytes: (result as string).length,
        callId: ctx.callId,
      }),
    };
    const client = mockClient([toolCallTurn('tc1', 'lookup'), { content: [{ type: 'text', text: 'done' }] }]);
    const loop = new AgentLoop({ client, tools: [tool] });
    await loop.complete("go");
    const report = loop.lastReport!;

    const tr = report.steps.flatMap((s) => s.toolCalls).find((r) => r.callId === 'tc1');
    expect(tr?.customData).toEqual({ bytes: 8, callId: 'tc1' });
  });

  it('a throwing extractor is swallowed — tool result unaffected, customData absent', async () => {
    const tool: AgentTool = {
      definition: { name: 'lookup', description: 'x', parameters: {} },
      async execute() {
        return 'OK';
      },
      customDataExtractor: () => {
        throw new Error('extractor boom');
      },
    };
    const client = mockClient([toolCallTurn('tc2', 'lookup'), { content: [{ type: 'text', text: 'done' }] }]);
    const loop = new AgentLoop({ client, tools: [tool] });
    await loop.complete("go");
    const report = loop.lastReport!;

    const tr = report.steps.flatMap((s) => s.toolCalls).find((r) => r.callId === 'tc2');
    expect(tr).toBeDefined();
    expect(tr?.error).toBeNull(); // the tool itself succeeded
    expect(tr?.customData).toBeUndefined();
  });

  it('no extractor → no customData key', async () => {
    const tool: AgentTool = {
      definition: { name: 'lookup', description: 'x', parameters: {} },
      async execute() {
        return 'OK';
      },
    };
    const client = mockClient([toolCallTurn('tc3', 'lookup'), { content: [{ type: 'text', text: 'done' }] }]);
    const loop = new AgentLoop({ client, tools: [tool] });
    await loop.complete("go");
    const report = loop.lastReport!;
    const tr = report.steps.flatMap((s) => s.toolCalls).find((r) => r.callId === 'tc3');
    expect(tr?.customData).toBeUndefined();
  });
});
