/** #8 — pre-approval tool-input guardrails: a tool-input guardrail validates a
 *  call's arguments BEFORE the permission/approval check. A trip denies just that
 *  call (error result to the model) and the approver is never consulted; a pass
 *  lets the normal permission/approval/execution path run. */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import { PermissionPolicy } from '../../../src/plugins/permissions/policy';
import type { AgentTool } from '../../../src/agent/types';
import type { ToolInputGuardrail } from '../../../src/agent/guardrail-types';
import type { ApprovalDecision, ApprovalRequest } from '../../../src/agent/approval-types';
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
        text: '', toolCalls: next?.toolCalls ?? content.filter((p) => p.type === 'tool_call'),
        thinking: null, media: [], latencyMs: 1, raw: null,
      } as CompletionResponse;
    },
    async *stream() {}, destroy() {},
  } as unknown as LLMClient;
}

function callThen(id: string, name: string, args: Record<string, unknown>) {
  return [
    {
      content: [{ type: 'tool_call' as const, id, name, arguments: args }],
      finishReason: 'tool_use' as const,
      toolCalls: [{ type: 'tool_call' as const, id, name, arguments: args }],
    },
    { content: [{ type: 'text' as const, text: 'done' }] },
  ];
}

const askPolicy = () =>
  new PermissionPolicy([{ source: 'agent', action: 'execute', effect: 'ask', reason: 'need approval' }]);

/** Denies any call whose arguments carry `evil: true`. */
const noEvil: ToolInputGuardrail = {
  name: 'no-evil',
  check: (ctx) => (ctx.arguments.evil ? { pass: false, reason: 'blocked by no-evil' } : { pass: true }),
};

describe('#8 tool-input guardrails', () => {
  it('a trip denies the call, does not execute, and never asks the approver', async () => {
    let executed = false;
    let approverCalled = false;
    const tool: AgentTool = {
      definition: { name: 'danger', description: 'x', parameters: {} },
      async execute() {
        executed = true;
        return 'ran';
      },
    };
    const approve = async (_r: ApprovalRequest): Promise<ApprovalDecision> => {
      approverCalled = true;
      return { decision: 'approve' };
    };

    const loop = new AgentLoop({
      client: mockClient(callThen('tc1', 'danger', { evil: true })),
      tools: [tool],
      policy: askPolicy(),
      approve,
      toolInputGuardrails: [noEvil],
    });
    await loop.complete('go');

    expect(executed).toBe(false); // never ran
    expect(approverCalled).toBe(false); // guardrail ran BEFORE approval
    const tr = loop.lastReport!.steps.flatMap((s) => s.toolCalls).find((r) => r.callId === 'tc1');
    expect(tr?.error).toBe('blocked by no-evil');
  });

  it('a pass lets the normal approval + execution path run', async () => {
    let executed = false;
    let approverCalled = false;
    const tool: AgentTool = {
      definition: { name: 'safe', description: 'x', parameters: {} },
      async execute() {
        executed = true;
        return 'ran';
      },
    };
    const approve = async (_r: ApprovalRequest): Promise<ApprovalDecision> => {
      approverCalled = true;
      return { decision: 'approve' };
    };

    const loop = new AgentLoop({
      client: mockClient(callThen('tc2', 'safe', { evil: false })),
      tools: [tool],
      policy: askPolicy(),
      approve,
      toolInputGuardrails: [noEvil],
    });
    await loop.complete('go');

    expect(approverCalled).toBe(true);
    expect(executed).toBe(true);
    const tr = loop.lastReport!.steps.flatMap((s) => s.toolCalls).find((r) => r.callId === 'tc2');
    expect(tr?.error).toBeNull();
  });
});
