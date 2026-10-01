---
title: Approval and Checkpoints (Human-in-the-Loop)
description: Pause an agent before sensitive tool calls, collect a human decision, and resume -- even after a process restart.
---

# Approval and Checkpoints (Human-in-the-Loop)

## What you'll achieve

By the end of this guide you will be able to:

- Mark specific tools as requiring human sign-off using `PermissionPolicy`
  with `effect: 'ask'`.
- Receive `ApprovalRequest` events, return `ApprovalDecision` objects, and
  let the loop resume or deny automatically.
- Serialize the full agent state at every suspension point so the process can
  exit and a fresh process can restore and resume exactly where it stopped.

## When and why you need this

Human-in-the-loop (HITL) control is needed when an agent can take
irreversible actions -- sending emails, deploying code, writing to databases,
calling external APIs with side effects. You want the model to plan and
reason fully, but require a human to confirm the final action before it fires.

The SDK provides two complementary controls:

- **Synchronous gate** -- same process, suspend the loop with a `Promise`,
  resume in milliseconds or minutes. Suitable for interactive UIs and CLIs.
- **Durable pause** -- the loop serializes its state to a `Persistence` store
  before suspending. The process can exit. A new process restores the
  snapshot and replays with the pre-fed decision.

## How it fits together

Three pieces compose the HITL system:

1. `PermissionPolicy` with `effect: 'ask'` -- routes matching tool calls
   through the approval gate instead of executing or blocking outright.
2. `approve` callback on `AgentLoopConfig` -- called with an `ApprovalRequest`
   each time policy says `'ask'`. The loop suspends until the returned
   `Promise` resolves.
3. `checkpoint` on `AgentLoopConfig` (optional) -- a `Persistence` instance.
   When set, the loop writes a snapshot before every suspension so the state
   survives process exit.

## Step by step

### 1. Write a `PermissionPolicy` with `'ask'`

```ts
import { PermissionPolicy } from '@combycode/llm-sdk';

const policy = new PermissionPolicy([
  // Ask before any 'deploy' tool call.
  {
    action: 'execute',
    target: (t) => t.kind === 'tool' && t.toolName === 'deploy',
    effect: 'ask',
    reason: 'Deployment requires human sign-off.',
  },
  // Allow everything else.
  { effect: 'allow' },
]);
```

Rules are evaluated in declaration order; the first match wins. A policy with
no matching rule defaults to `deny`. Always end with a catch-all `allow` (or
`deny`) rule so uncovered tools are not silently blocked.

#### Asking about the call, not just the tool — `withArgs`

A target also carries the **arguments** of the call being decided, so a rule can
depend on them:

```ts
import { PermissionPolicy, withArgs } from '@combycode/llm-sdk';

const policy = new PermissionPolicy([
  {
    action: 'execute',
    target: withArgs('amount', (v) => Number(v) > 1000),
    effect: 'ask',
    reason: 'A transfer over 1000 needs a human.',
  },
  { effect: 'allow' },
]);
```

Without this a rule about `transfer` had two settings — ask about every transfer,
or ask about none — and neither is the rule anyone wants. A gate that fires on
every call is one people learn to click through, which is worse than no gate
because it looks like one.

The arguments live on the **policy** rather than in a `requiresApproval` callback
on each tool: *"over 1000 needs a human"* is a policy statement, and it belongs
beside *"deploy needs approval"* so that the answer to **what requires approval
here** is readable in one place. Spread across tool definitions it is only
available by reading every tool.

This is safe because an approval is already bound to the invocation it was granted
for — the tool name plus a digest of the canonical arguments — so a resumed run
whose model came back with different arguments is refused rather than executed
under the old answer. Without that binding, argument-conditional approval would be
the bug: consent for `{amount: 5}` authorising `{amount: 5000}`.

**`arguments` is absent on a decision made before any call exists** — a pre-flight
capability check, a catalog lookup. A matcher that reads it must tolerate that, or
it throws on those paths and takes the run down with it. `withArgs` is the version
that handles it: an absent argument means *this rule has nothing to say*, so it
does not match. Hand-written matchers want `t.arguments?.amount`, never
`t.arguments.amount`.

`withArgs` tests for the key's PRESENCE, not its truthiness — `amount: 0` is an
argument, and "0 is under the line" should be a decision rather than a silence. The
value reaches the predicate untouched, so what `"5000"` means is the caller's call.

### 2. Wire the policy and `approve` callback into `AgentLoop`

```ts
import { createAgent, defineTool, PermissionPolicy } from '@combycode/llm-sdk';

const deployTool = defineTool({
  name: 'deploy',
  description: 'Deploy the application to production.',
  params: { environment: { type: 'string' } },
  execute: async ({ environment }) => `Deployed to ${environment}.`,
});

const agent = createAgent({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  tools: [deployTool],
  policy,
  approve: async (req) => {
    // req is an ApprovalRequest -- see shape below.
    console.log(`Tool "${req.toolName}" wants to run with:`, req.arguments);
    // req.trace.sessionId = agentId, req.trace.requestId = runId for this run
    const answer = await promptUser('Allow? [y/N] ');
    if (answer.toLowerCase() === 'y') {
      return { decision: 'approve' };
    }
    return { decision: 'deny', note: 'Rejected by operator.' };
  },
});

const response = await agent.complete('Deploy the app to staging.');
console.log(response.text);
```

The loop suspends inside `approve` for as long as the `Promise` takes to
resolve. Other concurrent runs on separate `AgentLoop` instances are
unaffected.

### 3. Understand `ApprovalRequest` and `ApprovalDecision`

```ts
interface ApprovalRequest {
  callId: string;                    // unique tool call ID from the LLM response
  toolName: string;
  arguments: Record<string, unknown>;
  reason?: string;                   // from the matched policy rule
  step: number;                      // step index within the current run
  trace: TraceContext;               // run identity: sessionId = agentId, requestId = runId, callId = tool call id
}

// Access run identity via trace:
//   req.trace.sessionId  -- the AgentLoop id (= ConversationHistory id)
//   req.trace.requestId  -- the run id for this .complete()/.stream() invocation
//   req.trace.callId     -- same as req.callId

interface ApprovalDecision {
  decision: 'approve' | 'deny' | 'skip';
  overrideResult?: string; // inject this as the tool result without executing
  note?: string;           // logged in the tool report and onApprovalResolved hook
}
```

- `'approve'` -- execute the tool (or use `overrideResult` instead of
  executing, without calling the `execute` function at all).
- `'deny'` -- block the tool; the model receives the `note` or a default
  denial message as the tool result.
- `'skip'` -- skip silently; the model receives a skip notice.

The `approve` callback MUST always resolve and never reject. If the approval
channel itself fails, return `{ decision: 'deny' }` to keep the loop moving.

### 4. Add durable checkpointing for process-restart survival

When `checkpoint` is set on `AgentLoopConfig`, the loop serializes a full
`AgentLoopSnapshot` to the persistence store under the key
`'agent-loop:<agentId>'` immediately before suspending for approval.

```ts
import { AgentLoop, FilePersistence, PermissionPolicy, createLLM, defineTool } from '@combycode/llm-sdk';

const persistence = new FilePersistence({ dir: './agent-state' });

const client = createLLM({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const policy = new PermissionPolicy([
  {
    action: 'execute',
    target: (t) => t.kind === 'tool' && t.toolName === 'deploy',
    effect: 'ask',
    reason: 'Deploy requires approval.',
  },
  { effect: 'allow' },
]);

const deployTool = defineTool({
  name: 'deploy',
  description: 'Deploy the app.',
  params: { env: { type: 'string' } },
  execute: async ({ env }) => `Deployed to ${env}.`,
});

const agent = new AgentLoop({
  client,
  tools: [deployTool],
  policy,
  checkpoint: persistence,   // <-- enables durable pause
  approve: async (req) => {
    // In Run 1: this suspends, persists state, then the process exits.
    // In Run 2: this is never reached -- the pre-fed decision is returned first.
    console.log('Waiting for external approval...');
    return waitForWebhook(req.callId); // never resolves if process exits here
  },
});

// Run 1: sends the message, model calls deploy(), loop suspends, writes snapshot.
// If the process exits here, state is on disk at ./agent-state/agent-loop:<agentId>.json
await agent.complete('Deploy the app to production.');
```

### 5. Restore after a process restart and resume

```ts
import { AgentLoop, FilePersistence, PermissionPolicy, createLLM, defineTool } from '@combycode/llm-sdk';
import type { AgentLoopSnapshot } from '@combycode/llm-sdk';

const persistence = new FilePersistence({ dir: './agent-state' });

// --- New process starts here. ---

// 1. Find the snapshot. The key format is 'agent-loop:<agentId>'.
//    You may need to list keys or store the agentId separately.
const snapshot = await persistence.get<AgentLoopSnapshot>('agent-loop:<the-agent-id>');
if (!snapshot) throw new Error('No snapshot found');

// 2. Inspect pending approvals from the snapshot.
const pending = snapshot.pendingToolCalls ?? [];
console.log('Pending approvals:', pending.map((p) => p.toolName));
// e.g. ['deploy']

const client = createLLM({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const deployTool = defineTool({
  name: 'deploy',
  description: 'Deploy the app.',
  params: { env: { type: 'string' } },
  execute: async ({ env }) => `Deployed to ${env}.`,
});

const policy = new PermissionPolicy([
  {
    action: 'execute',
    target: (t) => t.kind === 'tool' && t.toolName === 'deploy',
    effect: 'ask',
    reason: 'Deploy requires approval.',
  },
  { effect: 'allow' },
]);

// 3. Restore the agent from the snapshot (history, reports, pending calls all restored).
const restored = AgentLoop.restore(snapshot, {
  client,
  tools: [deployTool],
  policy,
  checkpoint: persistence,
  approve: async (req) => {
    // This approver returns the pre-fed decision immediately.
    // The pre-fed decision was stored by resumeWithApproval() below.
    // For any other callId (unexpected), deny safely.
    return { decision: 'deny', note: 'No pre-fed decision found.' };
  },
});

// 4. Pre-feed the decision for the known pending callId.
const callId = pending[0].callId;
restored.resumeWithApproval(callId, { decision: 'approve' });

// 5. Re-run. The loop re-executes the LLM step, hits the approval gate,
//    finds the pre-fed decision, and executes the tool without suspending.
const userMessage = snapshot.history.entries.at(-1)?.message.content ?? '';
const response = await restored.complete(String(userMessage));
console.log(response.text); // 'Deployed to production.'
```

**Why re-run the LLM step?** The pending state tracks the tool call *request*
(callId, toolName, arguments) but not the tool *execution*. The canonical
resume model is to replay the run: `AgentLoop.restore` rehydrates history up
to the suspension point, then `complete()` re-sends to the model, and this time
the gate returns the pre-fed decision instead of suspending.

**The model usually produces the same call — but nothing makes it.** An identical
history makes it likely, not certain, and the same `callId` can come back with
different arguments, or (providers reuse ids per turn) name a different tool. A
decision keyed on the id alone was applied to whatever came back: approve
`delete_file({path: '/tmp/x'})`, and a re-run asking for `{path: '/'}` executed
under that answer.

So a pre-fed decision is bound to the invocation it was given for — the tool
name plus a digest of the canonical arguments — and a mismatch raises
`ApprovalMismatchError` with `reason: 'tool_name_mismatch' | 'arguments_mismatch'`
and both sides attached. It does **not** fall through to your approver: the
person answered a different question, and asking again in the same breath would
let their old answer stand in for consent they never gave. Catch it, show the
two invocations, and ask afresh.

Key ORDER is not a change (`{a,b}` and `{b,a}` are one call, and a model gives no
guarantee of order); array order is.

```ts
import { ApprovalMismatchError } from '@combycode/llm-sdk';

try {
  await restored.complete(String(userMessage));
} catch (err) {
  if (err instanceof ApprovalMismatchError) {
    console.log(`approved ${err.approved.toolName}, resumed run asked for ${err.attempted.toolName}`);
    // Re-ask: this is a new decision, not the old one.
  }
}
```

## Your options

### `PermissionPolicy` and `Rule`

| `Rule` field | Type | Default | Notes |
|---|---|---|---|
| `source` | `string \| string[]` | any | Caller identity. Currently always `'agent'` inside `AgentLoop`. |
| `target` | `(t: PermissionTarget) => boolean` | any | Matcher function. `t.kind === 'tool'` and `t.toolName` are always set for tool calls. |
| `action` | `string \| string[]` | any | Currently always `'execute'` inside `AgentLoop`. |
| `effect` | `'allow' \| 'deny' \| 'ask'` | required | `'ask'` triggers the approval gate. |
| `reason` | `string` | none | Human-readable reason surfaced in `ApprovalRequest.reason`. |

Rules evaluate in order. First match wins. No match -> default deny.

### `AgentLoopConfig` HITL fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `policy` | `PermissionPolicy` | none | When absent, all tools execute without a policy check. |
| `approve` | `(req: ApprovalRequest) => Promise<ApprovalDecision>` | none | Called when policy returns `ask`. When absent and policy says `ask`, the tool is denied automatically. |
| `checkpoint` | `Persistence` | none | When set, snapshot is written before every approval suspension. |

### `checkpoint` persistence options

| Class | Environment | When to use |
|---|---|---|
| `MemoryPersistence` | All (in-process) | Tests, browser, ephemeral runs. State lost on process exit. |
| `FilePersistence({ dir })` | Node / Bun | Production: state survives process restart. One JSON file per key. |

`FilePersistence` constructor accepts either a `string` (the directory path)
or a `FilePersistenceConfig` object `{ dir: string }`. The directory is
created on first write.

### `dump()` and `AgentLoop.restore()`

```ts
// Snapshot the current state at any time (not just at suspension).
const snap: AgentLoopSnapshot = agent.dump();

// Recreate the agent from a snapshot in a new process.
const restored: AgentLoop = AgentLoop.restore(snap, {
  client,
  tools: [...],
  policy,
  approve: ...,
  checkpoint: ...,
});
```

`AgentLoopSnapshot` includes:

| Field | Notes |
|---|---|
| `version` | Schema version (currently `1`). |
| `system` | The system prompt string at snapshot time. |
| `context` | The context string at snapshot time. |
| `history` | Full `HistorySnapshot` (all messages). |
| `toolNames` | Names of tools that were registered. `restore()` warns about added/removed tools. |
| `reports` | All `AgentRunReport` entries accumulated so far. |
| `metadata` | Arbitrary key/value bag stored on the agent. |
| `createdAt` | Timestamp when the `ConversationHistory` was created. |
| `savedAt` | Timestamp of this snapshot. |
| `pendingToolCalls?` | Present when the loop was suspended. Each entry has `callId`, `toolName`, `arguments`, `step`, `requestedAt`, `runId`. |
| `pendingInput?` | Messages staged with `addInput()` and not yet admitted. Present only when something is staged. |

### `pendingApprovals` and `resumeWithApproval()`

```ts
// Read which tool calls are suspended awaiting approval.
const pending: readonly PendingToolCall[] = agent.pendingApprovals;

// Pre-feed a decision for a specific callId before re-running.
agent.resumeWithApproval(callId: string, decision: ApprovalDecision): void
```

`resumeWithApproval` removes the pending record from the in-memory list and
stores the decision in a private map. On the next `complete()` or `stream()`
call the loop re-executes, hits the approval gate for that `callId`, finds
the pre-fed decision in the map (consuming it), and returns it immediately
without invoking the `approve` callback.

If the `callId` is not in `pendingApprovals`, a warning is emitted on
`onWarning` with code `'approval_callid_not_found'` and the call is a no-op.

### `addInput()` — saying something more to a suspended run

A run stops at an approval gate. While the person is deciding, the user adds a
correction — *"use staging, not prod"*. `addInput()` is where it goes:

```ts
agent.addInput(input: string | ContentPart[] | Message[]): void
agent.pendingInput: readonly Message[]   // staged, in the order added
agent.clearPendingInput(): void          // they thought better of it
```

Staged input is admitted into history **immediately before the next run's first
model call, after that run's own input**, and the staging is cleared as it goes
in. It is carried in the snapshot (`pendingInput`), so a restart between the
gate and the resume does not lose it.

Both of those are the point rather than details:

- **Last, not first.** Appending the correction to history yourself lands it
  before `repairUnansweredToolCalls()`, the gate every run passes through — so
  the model reads the new instruction and *then* a tool result. An instruction
  that arrives ahead of the thing it corrects is not read as a correction.
- **In the snapshot.** The staged message exists nowhere else. A dropped
  approval can be asked for again; a sentence the user typed once is gone.

`addInput()` throws if a run is in flight: that run's input was admitted when it
started, so staging now would reach the *next* run — not the one the caller is
watching. Stage before the run, or after it ends.

```ts
// A gate suspended the run; the user adds something while you wait.
agent.addInput('use staging, not prod');
await persistence.save(agent.dump());   // the correction travels with it

// ...new process...
const resumed = AgentLoop.restore(snapshot, { client, tools, policy, approve });
resumed.resumeWithApproval(callId, { decision: 'approve' });
await resumed.complete(originalMessage);  // model sees: original, then the correction
```

## Observability hooks

The hook bus fires two events around every approval gate:

| Hook | When | Context fields |
|---|---|---|
| `onApprovalRequested` | Loop suspends, just before calling `approve()` | `callId`, `toolName`, `arguments`, `reason`, `step`, `trace` (sessionId/requestId/callId), `runId`, `agentId` |
| `onApprovalResolved` | Approver returned, just before the loop resumes | `callId`, `toolName`, `runId`, `agentId`, `step`, `decision`, `note?`, `trace?` |

```ts
import { createEngine } from '@combycode/llm-sdk';

const engine = createEngine({ /* ... */ });

engine.hooks.on('onApprovalRequested', (ctx) => {
  console.log(`Waiting for approval: ${ctx.toolName} in run ${ctx.runId}`);
  // ctx.trace.sessionId = agentId, ctx.trace.requestId = runId, ctx.trace.callId = tool call id
  myAuditLog.record('approval_requested', ctx);
});

engine.hooks.on('onApprovalResolved', (ctx) => {
  console.log(`Decision: ${ctx.decision} for ${ctx.toolName} (note: ${ctx.note})`);
  myAuditLog.record('approval_resolved', ctx);
});
```

## Gotchas and next steps

**`approve` must never reject.** An unhandled rejection from the `approve`
callback propagates out of `agent.complete()` as an error, terminating the
run with `finishReason: 'error'`. Wrap your approval logic in a try/catch and
return `{ decision: 'deny' }` on failure.

**No approver + `ask` policy = auto-deny.** If `policy` says `'ask'` but no
`approve` callback is configured, the loop denies the tool call automatically
using the constant `APPROVAL_DEFAULT_WHEN_NO_APPROVER = 'deny'`. This is
intentional -- a misconfigured HITL setup should fail closed, not open.

**Re-running after restore replays the full LLM step.** This costs tokens.
The model sees the same history and almost always produces the same tool call,
but it is not guaranteed. If the model produces a different tool call on the
second run, the pre-fed decision for the original `callId` stays in the map
unused (it is consumed only when the matching `callId` is requested).

**Checkpoint key format.** The key written to the `Persistence` store is
`'agent-loop:<agentId>'`. The `agentId` is `agent.id` (which equals
`agent.history.id`, a UUID assigned when the `ConversationHistory` is
created). Store this id externally if you need to look up snapshots later.

**`ToolExecutionContext` in tool `execute()`.** Tools receive a context object
`{ step, callId, signal, metrics, trace? }`. There is no `ctx.agentId` field.
To identify the agent, read `ctx.trace?.sessionId` (the `agentId`) or
`ctx.trace?.requestId` (the `runId` for this `.complete()` call).

**Next steps:**
- [Agent Patterns](/docs/guides/agent-patterns/) -- composing `PermissionPolicy` with
  matchers (`anyOfKind`, `fsGlob`, `shellGlob`), multi-tool approval flows, and
  the `onToolCallStart` hook for lower-level interception.
- [Context Guard and Persistence](/docs/guides/context-guard/) -- `FilePersistence`,
  `MemoryPersistence`, and how the persistence layer is shared across plugins.
