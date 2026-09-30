/** Private helpers for AgentLoop — extracted from the two god-functions.
 *  Not exported from the library public surface. */

import type { HookBus } from '../bus/hook-bus';
import type { ToolCallPart, ContentPart } from '../llm/types/messages';
import { emptyUsage, type CompletionResponse } from '../llm/types/response';
import { isFunctionTool } from '../llm/types/tools';
import type { StreamEvent } from '../llm/types/stream';
import type { TraceContext } from '../network/types';
import { linkSignals } from '../util/http';
import type { AgentStreamEvent, AgentTool, ToolCallReport, ToolExecutionContext } from './types';
import type { StepState, ToolCallAccumEntry } from './loop-step-state';

/** The trace one agent run belongs to — resolved once in `beginRun` and handed to
 *  everything the run emits: its own span, its LLM calls, its tool calls, and any agent
 *  nested inside a tool.
 *
 *  Not a bare `TraceContext` because `sessionId`/`requestId` are always resolved here
 *  (mint-if-absent), while `traceparent` appears only when the caller runs us inside a
 *  span of its own. Named rather than written inline because the shape was repeated at
 *  eleven signatures — and adding a field to ten of them is how a run ends up split
 *  across two traces. */
export type RunTrace = TraceContext & { sessionId: string; requestId: string };

/** Why a run ended. Written inline in both `complete()` and `stream()` and in
 *  `finalizeRun`'s argument list, which is three places to keep in step; named
 *  so adding a reason is one edit. */
export type { RunEndReason } from './types';

// ─── Stream event accumulation ───────────────────────────────────────────

/** Create a fresh StepState for the start of a streaming step. */
export function makeStepState(): StepState {
  return {
    stepText: '',
    stepCommentary: '',
    stepThinking: '',
    stepToolCalls: [],
    toolCallAccum: new Map<string, ToolCallAccumEntry>(),
    stepUsage: emptyUsage(),
    stepFinishReason: 'stop',
    stepCitations: new Map(),
  };
}

/** Which accumulating tool call a delta or an end belongs to.
 *
 *  By ID whenever there is one -- that is the whole point of the id, and with
 *  parallel calls in flight it is the only thing that can be right.
 *
 *  When the event carries no id the answer is the MOST RECENTLY STARTED call,
 *  not the first. A stream delivers a call's deltas after its start, so "most
 *  recent" is the only reading that holds for more than one call. This used to
 *  take `values().next().value` -- the FIRST accumulator -- which with two
 *  parallel Google function calls appended the second call's arguments to the
 *  first: `read_file` ended up with `{"path":"/a"}{"path":"/b"}` (unparseable, so
 *  refused as malformed) and `delete_file` ended up with NOTHING, which is an
 *  empty args string, which is indistinguishable from a deliberate no-argument
 *  call -- so it executed with `{}`. Exactly the failure `parseAccumEntry` was
 *  written to prevent, reached through a different door.
 *
 *  An id we have never seen is treated the same way: it is either a provider
 *  that does not echo ids on deltas, or a start we missed, and in both cases the
 *  most recent call is the best available answer. Inventing an accumulator for
 *  it would produce a nameless call that cannot be executed. */
function accumFor(state: StepState, id: string): ToolCallAccumEntry | undefined {
  const byId = id ? state.toolCallAccum.get(id) : undefined;
  if (byId) return byId;
  let last: ToolCallAccumEntry | undefined;
  for (const acc of state.toolCallAccum.values()) last = acc;
  return last;
}

/** Accumulate one SSE StreamEvent into StepState.
 *  Returns the AgentStreamEvent to yield upstream, or null if nothing to yield. */
export function accumulateStreamEvent(
  event: StreamEvent,
  state: StepState,
): AgentStreamEvent | null {
  switch (event.type) {
    case 'text':
      // `stepText` becomes the step's answer, so commentary is kept out of it — the same rule the
      // buffered path applies through `finalAnswerText`.
      if (event.phase === 'commentary') state.stepCommentary += event.text;
      else state.stepText += event.text;
      // The phase is FORWARDED, not just used internally. Dropping it left the agent layer
      // unable to tell narration from the answer, so a UI streaming these straight through
      // put the model's thinking-aloud in the transcript as if it were the reply —
      // and `finalAnswerText()` cannot help, because it operates on a finished message.
      return { type: 'text', text: event.text, ...(event.phase ? { phase: event.phase } : {}) };

    case 'thinking':
      state.stepThinking += event.text;
      return { type: 'thinking', text: event.text };

    case 'tool_call_start':
      state.toolCallAccum.set(event.id, {
        id: event.id,
        name: event.name,
        args: '',
        _meta: event._meta,
      });
      return null;

    case 'tool_call_delta': {
      const acc = accumFor(state, event.id);
      if (acc) acc.args += event.arguments;
      return null;
    }

    case 'tool_call_end': {
      const acc = accumFor(state, event.id);
      // De-duped on the accumulator's OWN id, not the event's: an end with no id
      // resolves to an accumulator that may already have been pushed, and pushing
      // it twice runs the tool twice.
      if (acc && !state.stepToolCalls.some((tc) => tc.id === acc.id)) {
        state.stepToolCalls.push(parseAccumEntry(acc));
      }
      return null;
    }

    case 'citation':
      // Collected, not forwarded: `AgentStreamEvent` is a deliberately narrow set
      // (it carries no `file` or `builtin_tool_end` either), and the sources reach
      // the caller on the final response's `citations`.
      state.stepCitations.set(event.citation.url, event.citation);
      return null;

    case 'usage':
      state.stepUsage = event.usage;
      return null;

    case 'done':
      state.stepFinishReason = event.finishReason;
      return null;

    default:
      return null;
  }
}

/** Parse a single accumulator entry into a ToolCallPart.
 *
 *  Unparseable arguments are MARKED, not discarded. This used to fall back to an
 *  empty object, which is a different call rather than a failed one: a stream cut
 *  at `{"path": "/et` arrived as `{}` and the tool ran with no arguments at all.
 *  For anything destructive that is the worst available reading of the model's
 *  intent, and nothing downstream could tell it from a real no-argument call.
 *
 *  An absent or empty `args` string is NOT malformed — that is how a genuine
 *  no-argument call comes across the wire. */
function parseAccumEntry(acc: ToolCallAccumEntry): ToolCallPart {
  let parsedArgs: Record<string, unknown> = {};
  let malformed = false;
  const raw = acc.args ?? '';
  if (raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      // A bare scalar parses but is not an argument object.
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedArgs = parsed as Record<string, unknown>;
      } else {
        malformed = true;
      }
    } catch {
      malformed = true;
    }
  }
  return {
    type: 'tool_call',
    id: acc.id,
    name: acc.name,
    arguments: parsedArgs,
    ...(acc._meta ? { _meta: acc._meta } : {}),
    ...(malformed ? { malformed: true as const } : {}),
  };
}

/** Finalize any tool calls that never received a tool_call_end event
 *  (Anthropic/OpenAI streaming quirk). Mutates state.stepToolCalls. */
export function finalizeUnendedToolCalls(state: StepState): void {
  for (const [id, acc] of state.toolCallAccum) {
    if (!state.stepToolCalls.find((tc) => tc.id === id)) {
      state.stepToolCalls.push(parseAccumEntry(acc));
    }
  }
}

// ─── Step response assembly ──────────────────────────────────────────────

/** Build the CompletionResponse for a completed streaming step. */
export function buildStepResponse(
  state: StepState,
  model: string,
  stepStart: number,
): { response: CompletionResponse; content: ContentPart[]; stepLatency: number } {
  const stepLatency = performance.now() - stepStart;
  const content: ContentPart[] = [];
  // Commentary is kept as its own phase-tagged part rather than discarded, so a streamed step
  // carries the same shape as a buffered one. Phases are only stamped when the provider actually
  // reported them — inferring `final_answer` for a model that reports nothing would be a guess.
  if (state.stepCommentary) {
    content.push({ type: 'text', text: state.stepCommentary, phase: 'commentary' });
  }
  if (state.stepText) {
    content.push({
      type: 'text',
      text: state.stepText,
      ...(state.stepCommentary ? { phase: 'final_answer' as const } : {}),
    });
  }
  content.push(...state.stepToolCalls);

  const hasToolCalls = state.stepToolCalls.length > 0;
  // A step holding a call we cannot run did not finish in `tool_use`: no tool is
  // going to be used. Saying so is what lets `reflectAndRetry` fire on EVERY
  // provider — until now only Google ever produced this reason, because only
  // Google's own API reports it, so the same truncation on OpenAI or Anthropic
  // was silently indistinguishable from a successful turn.
  const hasMalformed = state.stepToolCalls.some((tc) => tc.malformed);
  const effectiveFinishReason = hasMalformed
    ? 'malformed_tool_call'
    : hasToolCalls
      ? 'tool_use'
      : state.stepFinishReason;

  const response: CompletionResponse = {
    id: crypto.randomUUID(),
    model,
    content,
    finishReason:
      effectiveFinishReason === 'tool_use'
        ? 'tool_use'
        : effectiveFinishReason === 'malformed_tool_call'
          ? 'malformed_tool_call'
          : 'stop',
    usage: state.stepUsage,
    text: state.stepText,
    toolCalls: state.stepToolCalls,
    thinking: state.stepThinking || null,
    media: [],
    ...(state.stepCitations.size ? { citations: [...state.stepCitations.values()] } : {}),
    latencyMs: stepLatency,
    raw: null,
  };
  return { response, content, stepLatency };
}

// ─── Tool lookup ─────────────────────────────────────────────────────────

type LookupResult = { found: true; tool: AgentTool } | { found: false; errorResult: ContentPart };

/** Reject a tool call made by a caller the tool did not opt into.
 *
 *  `allowedCallers` is declared per tool and enforced by the provider, but it is
 *  enforced here too: the whole point of restricting a tool to `direct` is that
 *  model-written code must not be able to reach it, and a client that only trusts
 *  the provider's check has no defence if the provider's ever slips.
 *
 *  Absent `allowedCallers` means `['direct']` — a tool that never opted in is not
 *  callable by a program. Note the two vocabularies differ upstream and we mirror
 *  them: the caller reports `program`, the allow-list spells it `programmatic`. */
function callerViolation(tc: ToolCallPart, tool: AgentTool): string | undefined {
  const caller = tc.caller?.type === 'program' ? 'programmatic' : 'direct';
  const def = tool.definition;
  const allowed = (isFunctionTool(def) ? def.allowedCallers : undefined) ?? ['direct'];
  if (allowed.includes(caller)) return undefined;
  return (
    `Tool "${tc.name}" was invoked by a ${caller} caller, but it allows only ` +
    `${allowed.join(', ')}. The call was not executed.`
  );
}

/** Resolve a tool by name; emit not-found hooks and push an error report.
 *  Returns found tool or an error ContentPart to return to the model. */
export async function lookupToolOrError(
  tc: ToolCallPart,
  tools: Map<string, AgentTool>,
  hooks: HookBus,
  runId: string,
  agentId: string,
  step: number,
  metrics: Map<string, { value: number | string | boolean; type: string }>,
  reports: ToolCallReport[],
  toolStart: number,
  runTrace?: TraceContext,
): Promise<LookupResult> {
  const tool = tools.get(tc.name);
  const violation = tool ? callerViolation(tc, tool) : undefined;
  if (tool && !violation) return { found: true, tool };

  const errMsg =
    violation ??
    `Tool "${tc.name}" is not available. Available tools: ${[...tools.keys()].join(', ')}`;
  const latencyMs = performance.now() - toolStart;

  await hooks.emit('onToolCallError', {
    runId,
    agentId,
    step,
    callId: tc.id,
    toolName: tc.name,
    arguments: tc.arguments,
    error: new Error(errMsg),
    latencyMs,
    metrics,
    continueOnError: true,
    trace: runTrace,
  });

  await hooks.emit('onWarning', {
    source: 'agent',
    code: violation ? 'tool_caller_not_allowed' : 'tool_not_found',
    message: errMsg,
    details: violation
      ? { toolName: tc.name, caller: tc.caller?.type ?? 'direct' }
      : { toolName: tc.name, available: [...tools.keys()] },
  });

  reports.push({
    callId: tc.id,
    toolName: tc.name,
    arguments: tc.arguments,
    resultSizeBytes: errMsg.length,
    latencyMs,
    skipped: false,
    error: errMsg,
    metrics: Object.fromEntries(metrics),
  });
  return { found: false, errorResult: { type: 'tool_result', id: tc.id, content: errMsg, isError: true } };
}

// ─── Tool execution with timeout ─────────────────────────────────────────

/** Execute a tool under a signal that fires on the tool's timeout OR on the run
 *  being stopped.
 *
 *  `stop()` used to reach the in-flight LLM request and nothing else, so a tool
 *  already running kept running: a fetch inside it finished, its side effects
 *  landed, and the result was then thrown away by a loop that had already
 *  stopped. A cancellation that only cancels the cheap half of the work is not
 *  a cancellation.
 *
 *  The two causes stay distinguishable through `signal.reason`, because a tool
 *  writing its own cleanup needs to know which happened -- a timeout is its own
 *  problem to report, a stop is the caller changing their mind. */
export async function executeWithTimeout(
  tool: AgentTool,
  tc: ToolCallPart,
  baseCtx: Omit<ToolExecutionContext, 'signal'>,
  timeoutMs: number,
  runSignal?: AbortSignal,
): Promise<string | ContentPart[]> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(new Error(`Tool "${tc.name}" timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const linked = runSignal
    ? linkSignals(abortController.signal, runSignal)
    : { signal: abortController.signal, dispose: () => {} };
  const ctx: ToolExecutionContext = { ...baseCtx, signal: linked.signal };
  try {
    return await tool.execute(tc.arguments, ctx);
  } finally {
    clearTimeout(timeoutId);
    // The run's signal outlives this call, so the listener has to come off it.
    linked.dispose();
  }
}

// ─── Tool error handling ─────────────────────────────────────────────────

/** Handle a tool execution error: emit onToolCallError, push report, return fallback result.
 *  Throws if the hook sets continueOnError = false. */
export async function handleToolError(
  e: unknown,
  tc: ToolCallPart,
  hooks: HookBus,
  runId: string,
  agentId: string,
  step: number,
  metrics: Map<string, { value: number | string | boolean; type: string }>,
  reports: ToolCallReport[],
  toolStart: number,
  runTrace?: TraceContext,
): Promise<ContentPart> {
  const latencyMs = performance.now() - toolStart;
  const error = e instanceof Error ? e : new Error(String(e));
  const errMsg = `Error executing ${tc.name}: ${error.message}`;

  const errorCtx = {
    runId,
    agentId,
    step,
    callId: tc.id,
    toolName: tc.name,
    arguments: tc.arguments,
    error,
    latencyMs,
    metrics,
    continueOnError: true as boolean | undefined,
    fallbackResult: undefined as string | undefined,
    trace: runTrace,
  };
  await hooks.emit('onToolCallError', errorCtx);

  if (errorCtx.continueOnError === false) throw error;

  const resultContent = errorCtx.fallbackResult ?? errMsg;
  reports.push({
    callId: tc.id,
    toolName: tc.name,
    arguments: tc.arguments,
    resultSizeBytes: resultContent.length,
    latencyMs,
    skipped: false,
    error: error.message,
    metrics: Object.fromEntries(metrics),
  });
  return { type: 'tool_result', id: tc.id, content: resultContent, isError: true };
}
