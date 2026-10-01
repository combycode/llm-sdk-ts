/** Approval that depends on what the call actually asks for.
 *
 *  The policy saw a tool NAME and nothing else, so a rule about `transfer` had
 *  two settings: ask about every transfer, or ask about none. Neither is the
 *  rule anyone wants — "a transfer over 1000 needs a human" — and a gate that
 *  fires on every call is one people learn to click through, which is worse than
 *  no gate because it looks like one.
 *
 *  The arguments go to the POLICY rather than onto a `requiresApproval` callback
 *  on each tool, which is where the upstream SDK puts it. "Over 1000 needs a
 *  human" is a policy statement: it belongs beside "deploy needs approval", so
 *  that the answer to *what requires approval here* is readable in one place.
 *  Scattered over tool definitions it is only available by reading every tool.
 *
 *  This is safe to do because an approval is already bound to the invocation it
 *  was granted for — tool name plus a digest of the canonical arguments — so a
 *  resumed run whose model came back with different arguments is refused rather
 *  than executed under the old answer. Without that binding, argument-conditional
 *  approval would be the bug: consent for `{amount: 5}` authorising `{amount:
 *  5000}`.
 */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import { PermissionPolicy } from '../../../src/plugins/permissions/policy';
import { withArgs } from '../../../src/plugins/permissions/types';
import type { PermissionTarget } from '../../../src/plugins/permissions/types';
import type { ApprovalDecision, ApprovalRequest } from '../../../src/agent/approval-types';
import type { AgentTool } from '../../../src/agent/types';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ContentPart } from '../../../src/llm/types/messages';

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

/** Calls `transfer` once with the given arguments, then answers. */
function clientCalling(args: Record<string, unknown>): LLMClient {
  let turn = 0;
  const call: ContentPart = { type: 'tool_call', id: 'c1', name: 'transfer', arguments: args };
  return {
    id: 'mock',
    provider: 'mock',
    model: 'mock-model',
    api: 'completions',
    mode: 'foreground',
    batchable: false,
    hooks: new HookBus(),
    complete: async (): Promise<CompletionResponse> => {
      turn += 1;
      const asked = turn === 1;
      return {
        id: 'r1',
        model: 'mock-model',
        content: asked ? [call] : [{ type: 'text', text: 'done' }],
        finishReason: asked ? 'tool_use' : 'stop',
        usage: USAGE,
        text: asked ? '' : 'done',
        toolCalls: asked ? [call] : [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      } as unknown as CompletionResponse;
    },
    stream: async function* () {},
    destroy() {},
  } as unknown as LLMClient;
}

const transfer: AgentTool = {
  definition: { name: 'transfer', description: 'Move money', parameters: {} },
  execute: async () => 'transferred',
};

/** "Over 1000 needs a human; anything else goes." */
function amountPolicy(): PermissionPolicy {
  return new PermissionPolicy([
    {
      source: 'agent',
      action: 'execute',
      target: withArgs('amount', (v) => Number(v) > 1000),
      effect: 'ask',
      reason: 'a transfer over 1000 needs a human',
    },
    { effect: 'allow' },
  ]);
}

/** Runs one call and reports whether the approver was consulted. */
async function run(args: Record<string, unknown>, policy = amountPolicy()) {
  const asked: ApprovalRequest[] = [];
  const agent = new AgentLoop({
    client: clientCalling(args),
    tools: [transfer],
    policy,
    approve: async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      asked.push(req);
      return { decision: 'approve' };
    },
    system: 's',
  } as never);
  const res = await agent.complete('move it');
  return { asked, text: res.text };
}

describe('a rule that depends on the arguments', () => {
  it('asks when the amount is over the line', async () => {
    const { asked } = await run({ amount: 5000, to: 'acct-9' });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.arguments).toEqual({ amount: 5000, to: 'acct-9' });
  });

  it('does NOT ask when it is under', async () => {
    // The whole point: a gate that fires on every call is one people click
    // through without reading.
    const { asked, text } = await run({ amount: 5, to: 'acct-9' });
    expect(asked).toHaveLength(0);
    expect(text).toBe('done');
  });

  it('decides on the boundary the rule actually states', async () => {
    expect((await run({ amount: 1000 })).asked).toHaveLength(0);
    expect((await run({ amount: 1001 })).asked).toHaveLength(1);
  });

  it('reaches the policy as the arguments the model sent, not a copy of some', async () => {
    // A rule may read any argument, so the whole object has to arrive.
    const seen: PermissionTarget[] = [];
    const policy = new PermissionPolicy([
      {
        source: 'agent',
        action: 'execute',
        target: (t) => {
          seen.push(t);
          return false;
        },
        effect: 'ask',
      },
      { effect: 'allow' },
    ]);
    await run({ amount: 7, to: 'acct-1', memo: 'rent' }, policy);
    expect(seen[0]?.arguments).toEqual({ amount: 7, to: 'acct-1', memo: 'rent' });
    // And the name is still there: this adds to the target rather than replacing it.
    expect(seen[0]?.toolName).toBe('transfer');
  });
});

describe('withArgs, and the absence it exists for', () => {
  // The predicate says YES to everything, deliberately. With `Number(v) > 1000`
  // these two pass whether or not the presence check exists — `Number(undefined)`
  // is NaN — so they would assert the right behaviour and be satisfied by the
  // wrong implementation. An always-true predicate leaves only the guard.
  const alwaysYes = withArgs('amount', () => true);

  it('does not match a target that carries no arguments', () => {
    // A decision made before any call exists — a pre-flight capability check, a
    // catalog lookup — has none. A rule ABOUT an argument has nothing to say
    // about such a decision, and the alternative is a matcher that throws on
    // those paths and takes the run down with it.
    expect(alwaysYes({ kind: 'tool', toolName: 'transfer' })).toBe(false);
  });

  it('does not match when the argument is simply absent', () => {
    expect(alwaysYes({ kind: 'tool', arguments: { to: 'acct-1' } })).toBe(false);
    // And it DOES match when the argument is there, so the guard is the only
    // thing the two assertions above are about.
    expect(alwaysYes({ kind: 'tool', arguments: { amount: 1 } })).toBe(true);
  });

  it('passes the value through untouched, whatever it is', () => {
    // The predicate is the caller's; a helper that coerced first would decide
    // for them what `"5000"` means.
    const seen: unknown[] = [];
    const matcher = withArgs('amount', (v) => {
      seen.push(v);
      return true;
    });
    matcher({ kind: 'tool', arguments: { amount: '5000' } });
    matcher({ kind: 'tool', arguments: { amount: null } });
    expect(seen).toEqual(['5000', null]);
  });

  it('matches a present-but-falsy argument rather than skipping it', () => {
    // `amount: 0` IS an argument. A `key in args` test rather than a truthiness
    // one is what makes "0 is under the line" a decision instead of a silence.
    expect(withArgs('amount', (v) => v === 0)({ kind: 'tool', arguments: { amount: 0 } })).toBe(
      true,
    );
  });
});

describe('the approval it produces is still bound to the invocation', () => {
  it('carries the arguments the decision was made about', async () => {
    // This is what makes argument-conditional approval safe rather than the bug:
    // a resumed run whose model came back with other arguments is refused, so
    // consent for `{amount: 5}` cannot authorise `{amount: 5000}`.
    const { asked } = await run({ amount: 5000 });
    expect(asked[0]?.toolName).toBe('transfer');
    expect(asked[0]?.arguments).toEqual({ amount: 5000 });
  });
});
