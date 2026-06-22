/** Private helpers for AgentLoop — extracted from the two god-functions.
 *  Not exported from the library public surface. */

import type { HookBus } from '../bus/hook-bus';
import type { ToolCallPart, ContentPart } from '../llm/types/messages';
import { emptyUsage, type CompletionResponse } from '../llm/types/response';
import type { StreamEvent } from '../llm/types/stream';
import type { TraceContext } from '../network/types';
import type { AgentStreamEvent, AgentTool, ToolCallReport, ToolExecutionContext } from './types';
import type { StepState, ToolCallAccumEntry } from './loop-step-state';

// ─── Stream event accumulation ───────────────────────────────────────────

/** Create a fresh StepState for the start of a streaming step. */
export function makeStepState(): StepState {
  return {
    stepText: '',
    stepThinking: '',
    stepToolCalls: [],
    toolCallAccum: new Map<string, ToolCallAccumEntry>(),
    stepUsage: emptyUsage(),
    stepFinishReason: 'stop',
  };
}

/** Accumulate one SSE StreamEvent into StepState.
 *  Returns the AgentStreamEvent to yield upstream, or null if nothing to yield. */
export function accumulateStreamEvent(
  event: StreamEvent,
  state: StepState,
): AgentStreamEvent | null {
  switch (event.type) {
    case 'text':
      state.stepText += event.text;
      return { type: 'text', text: event.text };

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
      const acc = state.toolCallAccum.get(event.id) ?? state.toolCallAccum.values().next().value;
      if (acc) acc.args += event.arguments;
      return null;
    }

    case 'tool_call_end': {
      const acc =
        (event.id && state.toolCallAccum.get(event.id)) ??
        [...state.toolCallAccum.values()].find(
          (a) => !state.stepToolCalls.some((tc) => tc.id === a.id),
        );
      if (acc) {
        state.stepToolCalls.push(parseAccumEntry(acc));
      }
      return null;
    }

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
 *  Silently treats invalid JSON as an empty args object. */
function parseAccumEntry(acc: ToolCallAccumEntry): ToolCallPart {
  let parsedArgs: Record<string, unknown> = {};
  try {
    parsedArgs = JSON.parse(acc.args || '{}');
  } catch {}
  return {
    type: 'tool_call',
    id: acc.id,
    name: acc.name,
    arguments: parsedArgs,
    ...(acc._meta ? { _meta: acc._meta } : {}),
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
  if (state.stepText) content.push({ type: 'text', text: state.stepText });
  content.push(...state.stepToolCalls);

  const hasToolCalls = state.stepToolCalls.length > 0;
  const effectiveFinishReason = hasToolCalls ? 'tool_use' : state.stepFinishReason;

  const response: CompletionResponse = {
    id: crypto.randomUUID(),
    model,
    content,
    finishReason: effectiveFinishReason === 'tool_use' ? 'tool_use' : 'stop',
    usage: state.stepUsage,
    text: state.stepText,
    toolCalls: state.stepToolCalls,
    thinking: state.stepThinking || null,
    media: [],
    latencyMs: stepLatency,
    raw: null,
  };
  return { response, content, stepLatency };
}

// ─── Tool lookup ─────────────────────────────────────────────────────────

type LookupResult = { found: true; tool: AgentTool } | { found: false; errorResult: ContentPart };

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
  if (tool) return { found: true, tool };

  const errMsg = `Tool "${tc.name}" is not available. Available tools: ${[...tools.keys()].join(', ')}`;
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
    code: 'tool_not_found',
    message: errMsg,
    details: { toolName: tc.name, available: [...tools.keys()] },
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

/** Execute a tool with an AbortController-based timeout.
 *  Builds a ToolExecutionContext with the timeout signal internally. */
export async function executeWithTimeout(
  tool: AgentTool,
  tc: ToolCallPart,
  baseCtx: Omit<ToolExecutionContext, 'signal'>,
  timeoutMs: number,
): Promise<string | ContentPart[]> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
  const ctx: ToolExecutionContext = { ...baseCtx, signal: abortController.signal };
  try {
    return await tool.execute(tc.arguments, ctx);
  } finally {
    clearTimeout(timeoutId);
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
