/** An approval is a decision about ONE invocation, and is applied to that one
 *  or to none.
 *
 *  Resuming from an approval re-runs the model step — the pending record holds
 *  the call's metadata, not its execution, and the loop's own doc comment says
 *  so. The call that comes back therefore carries the same `callId` and may
 *  carry DIFFERENT arguments, or (with a reused id) name a different tool.
 *  Keyed on `callId` alone, the stored decision was applied to whatever came
 *  back: a human approved `delete_file({path:'/tmp/x'})` and the resumed run
 *  could execute `delete_file({path:'/'})` under their answer.
 *
 *  So the decision is bound to the tool name plus a digest of the canonical
 *  arguments, and a mismatch raises rather than falling through to the approver
 *  — asking again in the same breath would let the old answer stand in for
 *  consent that was never given.
 */

import { describe, expect, it } from 'bun:test';
import { approvalDigest } from '../../../src/agent/approval-types';
import { ApprovalMismatchError } from '../../../src/llm/output-errors';

describe('approvalDigest: the same invocation digests the same', () => {
  it('ignores key order, which is not part of a call', () => {
    // Otherwise a resumed run would be refused over a difference that is not
    // one: nothing guarantees a model re-emits its JSON keys in one order.
    expect(approvalDigest('get_weather', { city: 'Paris', unit: 'c' })).toBe(
      approvalDigest('get_weather', { unit: 'c', city: 'Paris' }),
    );
  });

  it('ignores key order in nested objects too', () => {
    expect(approvalDigest('t', { a: { x: 1, y: 2 }, b: 3 })).toBe(
      approvalDigest('t', { b: 3, a: { y: 2, x: 1 } }),
    );
  });

  it('KEEPS array order, which is', () => {
    expect(approvalDigest('t', { xs: [1, 2] })).not.toBe(approvalDigest('t', { xs: [2, 1] }));
  });

  it('separates a different value', () => {
    expect(approvalDigest('delete_file', { path: '/tmp/x' })).not.toBe(
      approvalDigest('delete_file', { path: '/' }),
    );
  });

  it('separates a different tool with identical arguments', () => {
    expect(approvalDigest('read_file', { path: '/etc/passwd' })).not.toBe(
      approvalDigest('delete_file', { path: '/etc/passwd' }),
    );
  });

  it('treats an absent key and an undefined one alike', () => {
    // `JSON.stringify` drops undefined values, so a digest that did not would
    // disagree with the arguments as they actually travel.
    expect(approvalDigest('t', { a: 1, b: undefined })).toBe(approvalDigest('t', { a: 1 }));
  });

  it('separates a null from an absent key', () => {
    // null is a value the model chose to send; absence is not.
    expect(approvalDigest('t', { a: 1, b: null })).not.toBe(approvalDigest('t', { a: 1 }));
  });
});

describe('ApprovalMismatchError says what changed', () => {
  it('distinguishes a different tool from different arguments', () => {
    // They mean different things: a different tool under the same id is a
    // provider or transport fault, different arguments are the model having
    // reconsidered.
    const nameErr = new ApprovalMismatchError(
      'tool_name_mismatch',
      'call_1',
      { toolName: 'read_file', digest: 'aaa' },
      { toolName: 'delete_file', digest: 'bbb' },
    );
    expect(nameErr.reason).toBe('tool_name_mismatch');
    expect(nameErr.message).toContain('read_file');
    expect(nameErr.message).toContain('delete_file');

    const argsErr = new ApprovalMismatchError(
      'arguments_mismatch',
      'call_1',
      { toolName: 'delete_file', digest: 'aaa' },
      { toolName: 'delete_file', digest: 'bbb' },
    );
    expect(argsErr.reason).toBe('arguments_mismatch');
    expect(argsErr.message).toContain('different arguments');
  });

  it('carries both sides, so a log can show what was swapped', () => {
    const err = new ApprovalMismatchError(
      'arguments_mismatch',
      'call_9',
      { toolName: 'delete_file', digest: 'approved' },
      { toolName: 'delete_file', digest: 'attempted' },
    );
    expect(err.callId).toBe('call_9');
    expect(err.approved.digest).toBe('approved');
    expect(err.attempted.digest).toBe('attempted');
  });

  it('is an AgentRunError, so existing handlers still catch it', () => {
    const err = new ApprovalMismatchError(
      'tool_name_mismatch',
      'c',
      { toolName: 'a', digest: '1' },
      { toolName: 'b', digest: '2' },
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApprovalMismatchError');
  });
});

// ─── through the loop, which is the path that matters ────────────────────────

import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import { PermissionPolicy } from '../../../src/plugins/permissions/policy';
import type { AgentTool } from '../../../src/agent/types';
import type { ApprovalDecision } from '../../../src/agent/approval-types';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ContentPart, ToolCallPart } from '../../../src/llm/types/messages';

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  const tc: ContentPart = { type: 'tool_call', id, name, arguments: args };
  return { content: [tc], finishReason: 'tool_use', toolCalls: [tc as ToolCallPart], usage: USAGE };
}

const text = (t: string) => ({
  content: [{ type: 'text' as const, text: t }],
  finishReason: 'stop',
  toolCalls: [],
  usage: USAGE,
});

function mockClient(responses: Array<Partial<CompletionResponse> & { content: ContentPart[] }>) {
  const queue = [...responses];
  return {
    id: 'mock',
    provider: 'mock',
    model: 'mock-model',
    hooks: new HookBus(),
    api: 'completions',
    mode: 'foreground',
    batchable: false,
    complete: async () => {
      const next = queue.shift();
      if (!next) throw new Error('mock client exhausted');
      return { id: 'r', model: 'mock-model', media: [], text: '', thinking: null, latencyMs: 1, raw: null, ...next } as CompletionResponse;
    },
  } as unknown as LLMClient;
}

const deleteTool: AgentTool = {
  definition: { name: 'delete_file', description: 'Delete a file', parameters: {} },
  execute: async () => 'deleted',
};
const readTool: AgentTool = {
  definition: { name: 'read_file', description: 'Read a file', parameters: {} },
  execute: async () => 'read',
};

const askPolicy = () =>
  new PermissionPolicy([
    { source: 'agent', action: 'execute', effect: 'ask', reason: 'human approval required' },
  ]);

/** A loop with one pending approval for `delete_file({path:'/tmp/x'})`. */
async function loopAwaitingApproval(next: Array<Partial<CompletionResponse> & { content: ContentPart[] }>) {
  const loop = new AgentLoop({
    client: mockClient(next),
    tools: [deleteTool, readTool],
    policy: askPolicy(),
    approve: async (): Promise<ApprovalDecision> => ({ decision: 'deny' }),
  });
  return loop;
}

describe('a decision is applied to the invocation it was made about', () => {
  it('applies when the resumed run asks for exactly the same thing', async () => {
    const loop = await loopAwaitingApproval([
      toolCall('c1', 'delete_file', { path: '/tmp/x' }),
      text('gone'),
    ]);
    // Stand in for the suspended run: the pending record is what the approver saw.
    (loop as unknown as { _pendingToolCalls: unknown[] })._pendingToolCalls = [
      {
        callId: 'c1',
        toolName: 'delete_file',
        arguments: { path: '/tmp/x' },
        step: 0,
        requestedAt: Date.now(),
        runId: 'r0',
        digest: approvalDigest('delete_file', { path: '/tmp/x' }),
      },
    ];
    loop.resumeWithApproval('c1', { decision: 'approve' });

    const res = await loop.complete('go');
    expect(res.text).toBe('gone');
  });

  it('refuses when the resumed run changed the arguments', async () => {
    // THE case. A human approved deleting /tmp/x; the re-run asks to delete /.
    // Keyed on callId alone, the approval was simply applied.
    const loop = await loopAwaitingApproval([toolCall('c1', 'delete_file', { path: '/' }), text('gone')]);
    (loop as unknown as { _pendingToolCalls: unknown[] })._pendingToolCalls = [
      {
        callId: 'c1',
        toolName: 'delete_file',
        arguments: { path: '/tmp/x' },
        step: 0,
        requestedAt: Date.now(),
        runId: 'r0',
        digest: approvalDigest('delete_file', { path: '/tmp/x' }),
      },
    ];
    loop.resumeWithApproval('c1', { decision: 'approve' });

    await expect(loop.complete('go')).rejects.toThrow(ApprovalMismatchError);
  });

  it('refuses when the same call id names a different tool', async () => {
    const loop = await loopAwaitingApproval([toolCall('c1', 'delete_file', { path: '/tmp/x' }), text('gone')]);
    (loop as unknown as { _pendingToolCalls: unknown[] })._pendingToolCalls = [
      {
        callId: 'c1',
        toolName: 'read_file',
        arguments: { path: '/tmp/x' },
        step: 0,
        requestedAt: Date.now(),
        runId: 'r0',
        digest: approvalDigest('read_file', { path: '/tmp/x' }),
      },
    ];
    loop.resumeWithApproval('c1', { decision: 'approve' });

    const err = await loop.complete('go').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalMismatchError);
    expect((err as ApprovalMismatchError).reason).toBe('tool_name_mismatch');
  });

  it('applies through a key reordering, which is not a change', async () => {
    const loop = await loopAwaitingApproval([
      toolCall('c1', 'delete_file', { force: true, path: '/tmp/x' }),
      text('gone'),
    ]);
    (loop as unknown as { _pendingToolCalls: unknown[] })._pendingToolCalls = [
      {
        callId: 'c1',
        toolName: 'delete_file',
        arguments: { path: '/tmp/x', force: true },
        step: 0,
        requestedAt: Date.now(),
        runId: 'r0',
        digest: approvalDigest('delete_file', { path: '/tmp/x', force: true }),
      },
    ];
    loop.resumeWithApproval('c1', { decision: 'approve' });
    const res = await loop.complete('go');
    expect(res.text).toBe('gone');
  });
});
