---
title: Agent Loop
---

# Agent Loop

Layer 3. Multi-step orchestration. Source: `src/agent/`.

## Purpose and responsibilities

- Drive a conversation through successive `LLMClient.complete()` / `LLMClient.stream()`
  calls until the model returns no tool calls (or `stop()` is called).
- Maintain `ConversationHistory` (messages + `ContextRegistry` + token estimates).
- Dispatch tool calls and feed results back as tool-result messages.
- Enforce `maxSteps` cap, guardrail tripwires, permission policy, and
  human-in-the-loop approval gates.
- Emit structured run/step/tool hooks for observability and control.
- Provide `dump()` / `AgentLoop.restore()` for checkpoint/resume across process restarts.

Does NOT: own a network queue, call `fetch` directly, or hold LLM credentials.
All HTTP still flows through `LLMClient`'s `EngineFetch`.

## Key types

### `src/agent/types.ts`

```ts
interface AgentTool {
  definition: Tool;                              // schema sent to the LLM
  execute: (args, ctx: ToolExecutionContext) => Promise<string | ContentPart[]>;
}

interface ToolExecutionContext {
  step: number;
  callId: string;
  signal: AbortSignal;   // pre-wired to toolTimeout AbortController
  metrics: Map<string, { value: number | string | boolean; type: string }>;
  trace?: TraceContext;
}

interface AgentRunReport {
  id: string;            // runId (UUID)
  model: string;
  startedAt: number; completedAt: number; totalMs: number;
  reason: 'done' | 'stopped' | 'error' | 'guardrail' | 'max_steps';
  userMessage: string | ContentPart[] | Message[];
  finalText: string;
  error?: string;
  steps: StepReport[];
  stepCount: number; toolCallCount: number;
  totalUsage: Usage;
  totalLlmTimeMs: number; totalToolTimeMs: number;
}

interface StepReport {
  index: number;
  type: 'initial' | 'tool_followup';
  llmLatencyMs: number;
  usage: Usage;
  finishReason: string;
  toolCalls: ToolCallReport[];
  toolTotalMs: number;
}

interface ToolCallReport {
  callId: string; toolName: string;
  arguments: Record<string, unknown>;
  resultSizeBytes: number; latencyMs: number;
  skipped: boolean; error: string | null;
  metrics: Record<string, { value: number | string | boolean; type: string }>;
}

type AgentStreamEvent =
  | { type: 'step_start'; step: number }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call_start'; step: number; callId: string; toolName: string; arguments: ... }
  | { type: 'tool_call_end'; step: number; callId: string; latencyMs: number }
  | { type: 'step_end'; step: number; usage: Usage; latencyMs: number }
  | { type: 'done'; response: CompletionResponse };
```

### `src/agent/loop-step-state.ts`

```ts
interface StepState {
  stepText: string;
  stepThinking: string;
  stepToolCalls: ToolCallPart[];
  toolCallAccum: Map<string, ToolCallAccumEntry>;  // id → { id, name, args, _meta? }
  stepUsage: Usage;
  stepFinishReason: string;
}
```

`StepState` is a fresh mutable accumulator per streaming step, passed through
pure helpers in `src/agent/loop-internals.ts`. The main loop body does not
hold closure state across streaming events.

### `src/agent/loop-config.ts`

`AgentLoopConfig` accepts: `client`, `system` (string or thunk),
`context`, `tools`, `history`, `hooks`, `maxTokens`, `temperature`, `thinking`,
`cache`, `parallelToolCalls`, `toolTimeout`, `maxSteps`, `guardrails`,
`policy`, `approve`, `checkpoint`.

## `ConversationHistory` (`src/agent/history.ts`)

```ts
class ConversationHistory {
  readonly registry: ContextRegistry;      // layered system-prompt composition
  id: string;
  length: number;
  system: string | undefined;              // composed read / legacy-layer write

  append(message: Message, meta?: { model?, usage?, latencyMs? }): HistoryEntry
  messages(): Message[]
  estimatedTokens(): number
  recordActualUsage(inputTokens: number): void
  spliceRange(from: number, to: number, replacement: Message): HistoryEntry[]
  fork(newId?: string): ConversationHistory
  export(): HistorySnapshot
  static import(snapshot: HistorySnapshot): ConversationHistory
}
```

**Token estimation hybrid** (`estimatedTokens()`):
- Keeps `_lastActualTotal` and `_lastActualEntryIndex` anchored to the last
  provider-reported `inputTokens`.
- For entries at indices `> _lastActualEntryIndex`: estimates each message via
  `estimateTokens(content)` (4 chars per token, with 250-token penalty for
  images/audio/video).
- If no anchor yet: estimates everything from scratch including `system` text.
- **Anchor update**: when `append()` receives an assistant message with
  `meta.usage.inputTokens > 0`, it calls `_lastActualTotal = inputTokens` and
  `_lastActualEntryIndex = entries.length - 1` (the pre-append index).
- `spliceRange` resets the anchor (`_lastActualTotal = 0`, `_lastActualEntryIndex = -1`)
  when the replaced range includes or precedes the anchor index — ContextGuard
  compaction invalidates the prior measurement.

**`spliceRange(from, to, replacement)`**: ContextGuard's entry point for
compacting history. Replaces entries `[from, to)` with a single synthetic
message; re-indexes all entries; resets the token anchor.

**`fork()`**: deep-clones entries and registry layers without copying event
subscribers. Used by `delegate.ts` to hand an independent history copy to a
sub-agent.

**`export()` / `static import()`**: round-trip via `HistorySnapshot` (includes
entries, registry snapshot, metadata). `import` handles legacy snapshots that
have a flat `system` field instead of a registry.

## `ContextRegistry` (`src/agent/context-registry/registry.ts`)

A layered key-value store for `ContextLayer` objects:
```ts
interface ContextLayer {
  name: string;
  content: string | ContentPart[];
  priority: number;       // lower = earlier in composed output
  tags: string[];
  owner: string;
  mergeParent?: boolean;  // additive vs. override when parent has same name
  metadata?: Record<string, unknown>;
}
```

`flat({ tag?, includeParent? })` sorts layers by `priority` and concatenates
their text content with `separator` (default `'\n\n'`). The result is the
composed system prompt string.

Parent chain: `setParent(parent)` wires event bubbling — changes in the parent
are reflected in child renders. Cycle detection throws.

Named layers written by the SDK (`src/agent/context-registry/layers.ts`):
- `agentloop.system` — priority 10 (stable agent role, prompt-cache-friendly prefix)
- `_legacy_system` — priority 50 (backward-compat `history.system` setter)
- `agentloop.context` — priority 100 (dynamic per-task context)

The priority ordering ensures stable content precedes dynamic content, which
is critical for Anthropic prompt caching (the breakpoint is placed after the
stable prefix).

## `AgentLoop` class (`src/agent/loop.ts`)

### Construction

1. Validate `client`, resolve `_system` (string) or `_systemThunk` (function).
2. Initialize `_tools: Map<string, AgentTool>` keyed by `toolKey(t)` —
   the tool definition's `name` for function tools (MCP tools use `"namespace__name"`),
   or the builtin `type` string for builtin tools.
3. Create or rehydrate `_history: ConversationHistory`.
4. `writeAgentLoopSystem(registry, system, 'agent-loop')` and
   `writeAgentLoopContext(registry, context, 'agent-loop')` to publish the
   initial layers.
5. `this.id = this._history.id` — agent identity is the conversation ID.
6. Emit `onAgentCreate`.

### `complete(input, options?)` flow

```text
beginRun(input)
  guard _running flag; set _stopRequested=false; new AbortController
  if _systemThunk: await to get current system, update registry if changed
  mint runId + timestamps
  emit onRunStart
  append user input to _history

while (stepCount < _maxSteps):
  if _stopRequested: reason='stopped'; break

  emit onStepStart

  composedSystem = history.registry.flat({ tag: 'system' })
  run input guardrails (all kind='input', in order)

  lastResponse = await client.complete(history.messages(), {
    system: composedSystem,
    tools: toolDefinitions(options),   // own tools merged with options.tools
    ctx: { ...options.ctx, conversationId: history.id },
    signal: options.signal ?? _abortController.signal,
    ...maxTokens, temperature, thinking, cache
  })

  history.append({ role: 'assistant', content: lastResponse.content },
                 { model, usage, latencyMs })

  emit onStepComplete
  run output guardrails (all kind='output', in order)

  if hasToolCalls:
    executeToolCalls(runId, stepCount, toolCalls, reports, trace)
      → returns ContentPart[] (tool results)
    history.append({ role: 'tool', content: toolResults })
    stepCount++
    continue
  else:
    break

finalizeRun(...)
  push AgentRunReport to _reports
  emit onRunComplete
return CompletionResponse (last step's content + totalUsage)
```

`stepCount` starts at 0. `maxSteps` cap check happens AFTER executing tools, so
the check is: `if (stepCount >= _maxSteps) { reason='max_steps'; break }`.
Constant: `DEFAULT_MAX_STEPS = 16` (`src/agent/loop.ts:1272`).

### `stream(input, options?)` flow

Identical structure to `complete()`, except:
- `yield { type: 'step_start', step }` at each step start.
- `client.stream(...)` is iterated; each `StreamEvent` is passed to
  `accumulateStreamEvent(event, state)` (`loop-internals.ts`) which updates
  `StepState` and returns an `AgentStreamEvent | null` to yield upstream.
- After the stream loop: `finalizeUnendedToolCalls(state)` and
  `buildStepResponse(state, model, stepStart)`.
- Tool call events are yielded as `tool_call_start` and `tool_call_end`.
- `yield { type: 'step_end', step, usage, latencyMs }`.
- `yield { type: 'done', response: finalResponse }` at the end.

### Stream event accumulation (`src/agent/loop-internals.ts`)

`accumulateStreamEvent(event, state)`:
- `'text'` → `state.stepText += text`; return `{ type: 'text', text }`.
- `'thinking'` → `state.stepThinking += text`.
- `'tool_call_start'` → push `{ id, name, args: '' }` to `toolCallAccum`.
- `'tool_call_delta'` → look up accumulator by `event.id`; `acc.args += arguments`.
- `'tool_call_end'` → find accumulator by `event.id` (fallback: first unfinished);
  parse `acc.args` as JSON (silent empty-object on parse failure); push to
  `state.stepToolCalls`.
- `'usage'` → `state.stepUsage = event.usage`.
- `'done'` → `state.stepFinishReason = event.finishReason`.

`finalizeUnendedToolCalls(state)`: after the stream loop, iterates `toolCallAccum`
and pushes any accumulator entries not already in `stepToolCalls`. This handles
Anthropic/OpenAI streaming where `tool_call_end` may not always fire.

`buildStepResponse(state, model, stepStart)`: builds a `CompletionResponse`
from accumulated `stepText`, `stepThinking`, `stepToolCalls`, `stepUsage`.
`finishReason` is `'tool_use'` if there are any tool calls, else `state.stepFinishReason`.

### Tool execution (`src/agent/loop.ts:695`)

```text
executeToolCalls(runId, step, toolCalls, reports, trace):
  if parallelToolCalls && toolCalls.length > 1:
    return Promise.all(toolCalls.map(executeSingleTool))
  else:
    sequential for-loop
```

`executeSingleTool(tc, ...)`:
1. Emit `onToolCallStart` (async). Hook can set `skip=true` or `overrideResult`.
2. If `skip`: return `buildSkippedResult(tc, overrideResult, reports)`.
3. If `overrideResult` set: return `buildOverriddenResult(tc, result, reports)`.
4. `lookupToolOrError(tc.name, _tools, ...)`:
   - Found: return `{ found: true, tool }`.
   - Not found: emit `onToolCallError` + `onWarning`, push error report, return
     `{ found: false, errorResult }` (error result fed back to model, not a throw).
5. Permission policy check (`_policy.check('agent', { kind: 'tool', toolName }, 'execute')`):
   - `decision.allow=true` → proceed.
   - `decision.ask=true` → `runApprovalGate(...)`.
   - `decision.allow=false` → `buildDeniedResult(tc, reason, reports)`.
6. `executeWithTimeout(tool, tc, baseCtx, _toolTimeout)`:
   - Creates `AbortController`; sets `setTimeout(abort, timeoutMs)`.
   - Calls `tool.execute(tc.arguments, ctx)`.
   - `clearTimeout` in `finally`.
7. On success: `buildSuccessResult(...)` → emit `onToolCallComplete`, push report.
8. On error: `handleToolError(...)`:
   - Emit `onToolCallError`. Hook may set `continueOnError=false` (throws) or
     `fallbackResult`.
   - Return `{ type: 'tool_result', id, content: errMsg, isError: true }`.

Tool results are always fed back to the model as `ContentPart` items under
`{ role: 'tool' }` — even errors (the model can recover). Thrown errors from
`continueOnError=false` propagate out of the step loop and set `reason='error'`.

## Guardrails (`src/agent/guardrail-types.ts`)

```ts
interface Guardrail {
  name: string;
  kind: 'input' | 'output';
  check(ctx: GuardrailCheckContext): Promise<GuardrailDecision>;
}

interface GuardrailDecision {
  pass: boolean;
  tripwire?: boolean;    // if true AND !pass: halt the run
  reason?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
}
```

Input guardrails fire before each LLM call (`runInputGuardrails`); output
guardrails fire after each step response (`runOutputGuardrails`). First tripwire
stops the loop with `reason='guardrail'`; the trip reason becomes `finalText`.
`onGuardrailTriggered` is emitted for monitoring.

## Human-in-the-loop approval (`src/agent/loop.ts:843`)

`runApprovalGate(tc, ...)`:
1. Build `ApprovalRequest` and `PendingToolCall`; push to `_pendingToolCalls`.
2. Emit `onApprovalRequested`.
3. If `_checkpoint != null`: `_checkpoint.set('agent-loop:' + id, dump())` —
   persists state at the suspension point.
4. Await `resolveApproval(req)`:
   - Check `_prefedApprovals.get(req.callId)` (consumed once — resume path).
   - Fall back to `_approve(req)`.
   - If no approver configured: default to `'deny'`.
5. Remove from `_pendingToolCalls`. Emit `onApprovalResolved`.
6. `decision.decision`:
   - `'approve'` → execute the tool normally (or use `overrideResult`).
   - `'skip'` → `buildSkippedResult`.
   - `'deny'` → `buildDeniedResult`.

**Resume after restart**:
1. `AgentLoop.restore(snapshot, config)` — rehydrates from `AgentLoopSnapshot`.
2. `agent.resumeWithApproval(callId, decision)` — removes from `_pendingToolCalls`,
   stores in `_prefedApprovals`.
3. Re-run `agent.complete(...)` with an approver that returns the pre-fed decision.

## Dump / restore (`src/agent/loop.ts:1145`)

`dump()` produces `AgentLoopSnapshot` (version 1):
```ts
interface AgentLoopSnapshot {
  version: 1;
  system: string; context: string;
  history: HistorySnapshot;
  toolNames: string[];
  reports: AgentRunReport[];
  metadata: Record<string, unknown>;
  createdAt: number; savedAt: number;
  pendingToolCalls?: PendingToolCall[];
}
```

`AgentLoop.restore(snapshot, config)`:
- Constructs a new `AgentLoop` from snapshot's `system`, `context`, `history`.
- Restores `_reports`, `_metadata`, `_pendingToolCalls`.
- Emits `onWarning` for tools present in the snapshot but absent from `config.tools`
  (`code: 'tool_removed'`) and vice versa (`code: 'tool_added'`).

## Delegate, chain, consolidate helpers

`src/helpers/delegate.ts`, `chain.ts`, `consolidate.ts` are orchestration
helpers for multi-agent patterns. They are NOT part of `AgentLoop` itself.
- `delegate` — creates a sub-agent, hands it a forked history, returns its result.
- `chain` — sequences agents; each receives the prior's output in context.
- `consolidate` — aggregates results from parallel runs into one summary.

## Extension points

- **Adding tools**: `agent.addTool(tool)` / `AgentLoopConfig.tools`. Tool is
  keyed by `toolKey(t)` (from `src/agent/tool-key.ts`).
- **Guardrails**: implement `Guardrail` interface; pass in `config.guardrails`.
- **Permission policy**: implement `PermissionPolicy` from
  `src/plugins/permissions/policy.ts`; pass in `config.policy`.
- **System prompt layers**: write named layers to `agent.history.registry` from
  any plugin that has access to it.
- **Hooks**: subscribe on `agent.hooks` (`HookBus`) — agent events, tool events,
  and all network/LLM events from the shared bus.

## Key invariants

- The loop appends messages in strict alternating order:
  `user → assistant → [tool] → assistant → [tool] → ...`
  Out-of-order messages would confuse providers.
- `stepCount` starts at 0 and only increments AFTER tool execution. The check
  `if (stepCount >= _maxSteps)` is evaluated at the BOTTOM of the loop (after
  tool dispatch), not at the top — so a run always executes at least one LLM
  step even with `maxSteps = 1`.
- `stop()` sets `_stopRequested = true` and calls `_abortController.abort()`.
  The loop exits after the CURRENT step completes (not mid-stream).
- `StepState` is created fresh per step (`makeStepState()`); no closure state
  leaks between steps in the streaming path.
- Tool-call IDs flow from `ToolCallPart.id` (assistant message) to
  `ToolResultPart.id` (tool message). Providers match them by ID.
- The loop never calls the network directly; it calls `client.complete()` or
  `client.stream()`, which route through `EngineFetch`.
- `beginRun` throws `'AgentLoop is already running'` if `_running` is true,
  preventing concurrent runs on the same instance.
