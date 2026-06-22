/** HITL approval gate unit tests — no network, no real keys.
 *
 *  Covers:
 *   - policy 'ask' suspends and calls the approver
 *   - approve -> tool runs normally
 *   - deny -> denied result emitted to model, run continues
 *   - skip -> skipped result, run continues
 *   - overrideResult -> injected result, run continues
 *   - policy 'deny' blocks without throwing the run
 *   - allow / no-policy -> unchanged behavior (regression)
 *   - approver receives correct ApprovalRequest fields
 *   - onApprovalRequested / onApprovalResolved hooks fire
 *   - durable round-trip (memory store): dump-with-pending -> restore -> resume
 *   - durable round-trip (FilePersistence): same flow with disk checkpoint
 *   - existing permission tests still pass (allow/deny unchanged) */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentLoop } from '../../../src/agent/loop';
import type { ApprovalDecision, ApprovalRequest } from '../../../src/agent/approval-types';
import { PermissionPolicy } from '../../../src/plugins/permissions/policy';
import { MemoryPersistence } from '../../../src/plugins/persistence/memory';
import { FilePersistence } from '../../../src/plugins/persistence/file';
import { HookBus } from '../../../src/bus/hook-bus';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ContentPart } from '../../../src/llm/types/messages';
import type { AgentTool } from '../../../src/agent/types';
import type { ApprovalRequestedContext, ApprovalResolvedContext } from '../../../src/bus/hook-map';

// ─── Shared mock factories ───────────────────────────────────────────────────

const MOCK_USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function toolCallResponse(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): Partial<CompletionResponse> & { content: ContentPart[] } {
  const tc: ContentPart = { type: 'tool_call', id, name, arguments: args };
  return {
    content: [tc],
    finishReason: 'tool_use',
    toolCalls: [tc as import('../../../src/llm/types/messages').ToolCallPart],
    usage: MOCK_USAGE,
  };
}

function textResponse(text: string): Partial<CompletionResponse> & { content: ContentPart[] } {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    usage: MOCK_USAGE,
  };
}

function makeMockClient(
  responses: Array<Partial<CompletionResponse> & { content: ContentPart[] }>,
): LLMClient {
  const queue = [...responses];
  return {
    id: 'mock',
    provider: 'mock' as const,
    model: 'mock-model',
    system: undefined,
    hooks: new HookBus(),
    api: 'completions' as const,
    mode: 'foreground' as const,
    batchable: false,
    async complete(): Promise<CompletionResponse> {
      const next = queue.shift() ?? textResponse('fallback');
      const textParts = (next.content ?? []).filter(
        (p): p is { type: 'text'; text: string } => p.type === 'text',
      );
      return {
        id: `r-${Math.random()}`,
        model: 'mock-model',
        content: next.content ?? [],
        finishReason: next.finishReason ?? 'stop',
        usage: next.usage ?? MOCK_USAGE,
        text: textParts.map((p) => p.text).join(''),
        toolCalls: (next.toolCalls ?? []) as import('../../../src/llm/types/messages').ToolCallPart[],
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

function makeTool(name: string, result = 'tool-result'): AgentTool {
  return {
    definition: { name, description: `Tool ${name}`, parameters: {} },
    execute: async () => result,
  };
}

/** Policy with a single rule that says 'ask' for any tool call from 'agent'. */
function askPolicy(): PermissionPolicy {
  return new PermissionPolicy([{ source: 'agent', action: 'execute', effect: 'ask', reason: 'human approval required' }]);
}

/** Policy with a single rule that denies any tool call. */
function denyPolicy(): PermissionPolicy {
  return new PermissionPolicy([{ source: 'agent', action: 'execute', effect: 'deny', reason: 'tool use blocked' }]);
}

/** Policy that allows everything. */
function allowPolicy(): PermissionPolicy {
  return new PermissionPolicy([{ source: 'agent', action: 'execute', effect: 'allow' }]);
}

// ─── 1. Policy 'ask' — approver behavior ─────────────────────────────────────

describe('approval gate — approve decision', () => {
  it('approve causes tool to execute and run to complete', async () => {
    const tool = makeTool('search', 'search-result');
    const client = makeMockClient([
      toolCallResponse('c1', 'search', { q: 'hello' }),
      textResponse('final answer'),
    ]);
    const approve = async (_req: ApprovalRequest): Promise<ApprovalDecision> => ({
      decision: 'approve',
    });
    const loop = new AgentLoop({ client, tools: [tool], policy: askPolicy(), approve });
    const res = await loop.complete('go');
    expect(res.text).toBe('final answer');
    expect(loop.lastReport?.toolCallCount).toBe(1);
    expect(loop.lastReport?.reason).toBe('done');
  });
});

describe('approval gate — deny decision', () => {
  it('deny blocks tool, emits error result to model, run continues', async () => {
    const tool = makeTool('search');
    const client = makeMockClient([
      toolCallResponse('c1', 'search'),
      textResponse('acknowledged denial'),
    ]);
    const approve = async (): Promise<ApprovalDecision> => ({
      decision: 'deny',
      note: 'not allowed by operator',
    });
    const loop = new AgentLoop({ client, tools: [tool], policy: askPolicy(), approve });
    const res = await loop.complete('go');
    expect(res.text).toBe('acknowledged denial');
    const report = loop.lastReport?.steps[0].toolCalls[0];
    expect(report?.error).toBe('not allowed by operator');
  });
});

describe('approval gate — skip decision', () => {
  it('skip returns skipped result to model, run continues', async () => {
    const tool = makeTool('search');
    const client = makeMockClient([
      toolCallResponse('c1', 'search'),
      textResponse('continued after skip'),
    ]);
    const approve = async (): Promise<ApprovalDecision> => ({ decision: 'skip' });
    const loop = new AgentLoop({ client, tools: [tool], policy: askPolicy(), approve });
    const res = await loop.complete('go');
    expect(res.text).toBe('continued after skip');
    const report = loop.lastReport?.steps[0].toolCalls[0];
    expect(report?.skipped).toBe(true);
  });
});

describe('approval gate — overrideResult on approve', () => {
  it('overrideResult injects custom string as tool result', async () => {
    const tool = makeTool('search', 'real-result');
    const client = makeMockClient([
      toolCallResponse('c1', 'search'),
      textResponse('used injected'),
    ]);
    const approve = async (): Promise<ApprovalDecision> => ({
      decision: 'approve',
      overrideResult: 'injected-result',
    });
    const loop = new AgentLoop({ client, tools: [tool], policy: askPolicy(), approve });
    await loop.complete('go');
    const toolMsg = loop.history.byRole('tool')[0];
    const part = (toolMsg.message.content as ContentPart[])[0];
    expect((part as { content: string }).content).toBe('injected-result');
  });
});

// ─── 2. Policy 'deny' — blocks without throwing ──────────────────────────────

describe('approval gate — policy deny (no approver needed)', () => {
  it('deny policy blocks tool; error result sent to model; run finishes', async () => {
    const tool = makeTool('dangerous');
    const client = makeMockClient([
      toolCallResponse('c1', 'dangerous'),
      textResponse('ok after deny'),
    ]);
    const loop = new AgentLoop({ client, tools: [tool], policy: denyPolicy() });
    const res = await loop.complete('go');
    expect(res.text).toBe('ok after deny');
    expect(loop.lastReport?.reason).toBe('done');
    const report = loop.lastReport?.steps[0].toolCalls[0];
    expect(report?.error).toBe('tool use blocked');
  });
});

// ─── 3. Allow / no-policy — unchanged behavior ───────────────────────────────

describe('approval gate — allow policy (regression)', () => {
  it('allow policy does not block tool', async () => {
    const tool = makeTool('safe', 'safe-result');
    const client = makeMockClient([
      toolCallResponse('c1', 'safe'),
      textResponse('done'),
    ]);
    const loop = new AgentLoop({ client, tools: [tool], policy: allowPolicy() });
    const res = await loop.complete('go');
    expect(res.text).toBe('done');
    const report = loop.lastReport?.steps[0].toolCalls[0];
    expect(report?.error).toBeNull();
    expect(report?.skipped).toBe(false);
  });

  it('no policy — tool executes normally', async () => {
    const tool = makeTool('safe', 'value');
    const client = makeMockClient([
      toolCallResponse('c1', 'safe'),
      textResponse('done'),
    ]);
    const loop = new AgentLoop({ client, tools: [tool] });
    const res = await loop.complete('go');
    expect(res.text).toBe('done');
    expect(loop.lastReport?.toolCallCount).toBe(1);
  });
});

// ─── 4. ApprovalRequest fields ────────────────────────────────────────────────

describe('approval gate — ApprovalRequest fields', () => {
  it('approver receives correct callId, toolName, arguments, reason, step, and trace', async () => {
    const capturedReqs: ApprovalRequest[] = [];
    const tool = makeTool('search');
    const client = makeMockClient([
      toolCallResponse('c42', 'search', { q: 'test' }),
      textResponse('done'),
    ]);
    const approve = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      capturedReqs.push({ ...req });
      return { decision: 'approve' };
    };
    const loop = new AgentLoop({ client, tools: [tool], policy: askPolicy(), approve });
    await loop.complete('go');
    expect(capturedReqs.length).toBe(1);
    const req = capturedReqs[0];
    expect(req.callId).toBe('c42');
    expect(req.toolName).toBe('search');
    expect(req.arguments).toEqual({ q: 'test' });
    expect(req.reason).toBe('human approval required');
    expect(req.step).toBe(0);
    // trace carries run identity: sessionId = agentId, requestId = runId, callId = tool call id
    expect(req.trace.sessionId).toBe(loop.id);
    expect(typeof req.trace.requestId).toBe('string');
    expect(req.trace.requestId!.length).toBeGreaterThan(0);
    expect(req.trace.callId).toBe('c42');
  });
});

// ─── 5. Hooks ─────────────────────────────────────────────────────────────────

describe('approval gate — hooks', () => {
  it('onApprovalRequested fires before approver, onApprovalResolved fires after', async () => {
    const fired: string[] = [];
    const hooks = new HookBus();
    hooks.on('onApprovalRequested', (_ctx: ApprovalRequestedContext) => {
      fired.push('requested');
    });
    hooks.on('onApprovalResolved', (_ctx: ApprovalResolvedContext) => {
      fired.push('resolved');
    });

    const tool = makeTool('t');
    const client = makeMockClient([
      toolCallResponse('c1', 't'),
      textResponse('done'),
    ]);
    const approve = async (): Promise<ApprovalDecision> => {
      fired.push('approver');
      return { decision: 'approve' };
    };
    const loop = new AgentLoop({ client, tools: [tool], policy: askPolicy(), approve, hooks });
    await loop.complete('go');

    expect(fired.indexOf('requested')).toBeLessThan(fired.indexOf('approver'));
    expect(fired.indexOf('approver')).toBeLessThan(fired.indexOf('resolved'));
  });

  it('onApprovalResolved carries the decision value', async () => {
    const resolved: ApprovalResolvedContext[] = [];
    const hooks = new HookBus();
    hooks.on('onApprovalResolved', (ctx) => {
      resolved.push({ ...ctx });
    });

    const tool = makeTool('t');
    const client = makeMockClient([
      toolCallResponse('c1', 't'),
      textResponse('done'),
    ]);
    const approve = async (): Promise<ApprovalDecision> => ({ decision: 'deny', note: 'nope' });
    const loop = new AgentLoop({ client, tools: [tool], policy: askPolicy(), approve, hooks });
    await loop.complete('go');

    expect(resolved[0].decision).toBe('deny');
    expect(resolved[0].note).toBe('nope');
  });
});

// ─── 6. Durable round-trip — MemoryPersistence ───────────────────────────────

describe('durable round-trip — memory store', () => {
  it('dump captures pendingToolCalls; restore rehydrates them; resumeWithApproval clears + run completes', async () => {
    const store = new MemoryPersistence();
    let suspendedApproval: ApprovalRequest | null = null;

    const tool = makeTool('calc', '42');
    const client1 = makeMockClient([
      toolCallResponse('c1', 'calc', { expr: '6*7' }),
      textResponse('result is 42'),
    ]);

    // First approver: capture the request, return a deferred promise (simulates process suspension).
    // In the test we use a MemoryPersistence checkpoint to capture the dump-with-pending.
    let resolveApproval!: (d: ApprovalDecision) => void;
    const approvalPromise = new Promise<ApprovalDecision>((res) => {
      resolveApproval = res;
    });

    const approve1 = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      suspendedApproval = req;
      return approvalPromise;
    };

    const loop1 = new AgentLoop({
      client: client1,
      tools: [tool],
      policy: askPolicy(),
      approve: approve1,
      checkpoint: store,
    });

    // Start the run (it will suspend waiting for approval).
    const runPromise = loop1.complete('go');

    // Wait until the approval gate has been hit (checkpoint persisted).
    // Poll briefly until checkpointed.
    await new Promise<void>((res) => {
      const tick = setInterval(async () => {
        const hasKey = await store.has(`agent-loop:${loop1.id}`);
        if (hasKey) {
          clearInterval(tick);
          res();
        }
      }, 5);
    });

    expect(suspendedApproval).toBeDefined();
    expect(suspendedApproval!.callId).toBe('c1');

    // Verify dump-with-pending via checkpoint store.
    const snap = await store.get<import('../../../src/agent/types').AgentLoopSnapshot>(`agent-loop:${loop1.id}`);
    expect(snap).toBeDefined();
    expect(snap!.pendingToolCalls).toBeDefined();
    expect(snap!.pendingToolCalls!.length).toBe(1);
    expect(snap!.pendingToolCalls![0].callId).toBe('c1');

    // Simulate process restart: restore from persisted snapshot with a pass-through approver.
    const client2 = makeMockClient([
      // The restored loop re-runs from history — same call again.
      toolCallResponse('c1', 'calc', { expr: '6*7' }),
      textResponse('result is 42'),
    ]);
    const restored = AgentLoop.restore(snap!, {
      client: client2,
      tools: [tool],
      policy: askPolicy(),
      approve: async (_req: ApprovalRequest) => ({ decision: 'approve' } satisfies ApprovalDecision),
      checkpoint: store,
    });

    // pendingToolCalls rehydrated.
    expect(restored.pendingApprovals.length).toBe(1);

    // Feed the pre-approved decision.
    restored.resumeWithApproval('c1', { decision: 'approve' });
    expect(restored.pendingApprovals.length).toBe(0);

    // Let the original run complete (it has been waiting).
    resolveApproval({ decision: 'approve' });
    await runPromise;

    // Run the restored loop from scratch (after resume, the history is replayed).
    const res2 = await restored.complete('go');
    expect(res2.text).toBe('result is 42');
  });
});

// ─── 7. Durable round-trip — FilePersistence ─────────────────────────────────

describe('durable round-trip — file store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orxa-approval-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists snapshot to disk during suspension; restore from file resumes correctly', async () => {
    const store = new FilePersistence({ dir });
    let resolveApproval!: (d: ApprovalDecision) => void;
    const approvalPromise = new Promise<ApprovalDecision>((res) => {
      resolveApproval = res;
    });

    const tool = makeTool('ping', 'pong');
    const client1 = makeMockClient([
      toolCallResponse('d1', 'ping'),
      textResponse('pong received'),
    ]);

    const loop1 = new AgentLoop({
      client: client1,
      tools: [tool],
      policy: askPolicy(),
      approve: async () => approvalPromise,
      checkpoint: store,
    });

    const runPromise = loop1.complete('test');

    // Wait until checkpoint is written.
    await new Promise<void>((res) => {
      const tick = setInterval(async () => {
        const hasKey = await store.has(`agent-loop:${loop1.id}`);
        if (hasKey) {
          clearInterval(tick);
          res();
        }
      }, 5);
    });

    // Read persisted snapshot from file.
    const snap = await store.get<import('../../../src/agent/types').AgentLoopSnapshot>(`agent-loop:${loop1.id}`);
    expect(snap!.pendingToolCalls!.length).toBe(1);

    // Restore from file snapshot.
    const client2 = makeMockClient([
      toolCallResponse('d1', 'ping'),
      textResponse('pong received'),
    ]);
    const restored = AgentLoop.restore(snap!, {
      client: client2,
      tools: [tool],
      policy: askPolicy(),
      approve: async () => ({ decision: 'approve' } satisfies ApprovalDecision),
      checkpoint: store,
    });

    restored.resumeWithApproval('d1', { decision: 'approve' });

    // Let original run finish.
    resolveApproval({ decision: 'approve' });
    await runPromise;

    // Run restored loop.
    const res = await restored.complete('test');
    expect(res.text).toBe('pong received');
  });
});

// ─── 8. pendingApprovals getter + resumeWithApproval ─────────────────────────

describe('pendingApprovals / resumeWithApproval', () => {
  it('pendingApprovals starts empty', () => {
    const loop = new AgentLoop({ client: makeMockClient([textResponse('x')]) });
    expect(loop.pendingApprovals.length).toBe(0);
  });

  it('resumeWithApproval warns when callId not found', () => {
    const hooks = new HookBus();
    const warnings: unknown[] = [];
    hooks.on('onWarning', (ctx) => { warnings.push(ctx); });
    const loop = new AgentLoop({ client: makeMockClient([textResponse('x')]), hooks });
    loop.resumeWithApproval('nonexistent', { decision: 'approve' });
    expect(warnings.length).toBe(1);
    expect((warnings[0] as { code: string }).code).toBe('approval_callid_not_found');
  });
});

// ─── 9. No approver configured → default deny ────────────────────────────────

describe('approval gate — no approver configured', () => {
  it('policy ask without approver defaults to deny (tool blocked, run continues)', async () => {
    const tool = makeTool('t');
    const client = makeMockClient([
      toolCallResponse('c1', 't'),
      textResponse('model continued after deny'),
    ]);
    // No approve callback provided.
    const loop = new AgentLoop({ client, tools: [tool], policy: askPolicy() });
    const res = await loop.complete('go');
    expect(res.text).toBe('model continued after deny');
    expect(loop.lastReport?.reason).toBe('done');
  });
});
