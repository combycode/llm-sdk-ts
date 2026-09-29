/** Guardrail types — input/output validators with tripwire halt.
 *  Extracted per the library rule: types in *-types.ts, never inline. */

import type { Message } from '../llm/types/messages';
import type { CompletionResponse } from '../llm/types/response';
import type { TraceContext } from '../network/types';

// ─── Decision ──────────────────────────────────────────────────────────────

/** Guardrail passed — proceed normally. */
export interface GuardrailPass {
  pass: true;
}

/** Guardrail tripped — halt the run. */
export interface GuardrailTrip {
  pass: false;
  /** When true the loop MUST halt immediately (hard stop). */
  tripwire: true;
  /** Human-readable explanation surfaced in the response and hooks. */
  reason: string;
  /** Optional severity label for observability routing. */
  severity?: 'low' | 'medium' | 'high';
}

export type GuardrailDecision = GuardrailPass | GuardrailTrip;

// ─── Context passed to check() ─────────────────────────────────────────────

/** Context given to an input guardrail (before the LLM call). */
export interface InputGuardrailContext {
  kind: 'input';
  /** Run trace: sessionId = agentId (ConversationHistory id),
   *  requestId = runId for this .complete()/.stream() invocation. */
  trace: TraceContext;
  step: number;
  messages: Message[];
  system?: string;
}

/** Context given to an output guardrail (after a step's response is produced). */
export interface OutputGuardrailContext {
  kind: 'output';
  /** Run trace: sessionId = agentId (ConversationHistory id),
   *  requestId = runId for this .complete()/.stream() invocation. */
  trace: TraceContext;
  step: number;
  response: CompletionResponse;
}

export type GuardrailCheckContext = InputGuardrailContext | OutputGuardrailContext;

// ─── Guardrail interface ───────────────────────────────────────────────────

export interface Guardrail {
  /** Unique label shown in hooks and error messages. */
  name: string;
  /** Whether this runs before ('input') or after ('output') the LLM call. */
  kind: 'input' | 'output';
  /** Return a decision; throw only for unexpected infrastructure errors. */
  check(ctx: GuardrailCheckContext): Promise<GuardrailDecision>;
}

// ─── Tool-input guardrails (per tool call, not run-halting) ───────────────

/** Context for a tool-input guardrail: the specific tool call about to run. */
export interface ToolInputGuardrailContext {
  toolName: string;
  arguments: Record<string, unknown>;
  callId: string;
  step: number;
  trace: TraceContext;
}

/** A tool-input guardrail decision. Unlike message-level guardrails it does NOT
 *  halt the run — a trip denies just this one tool call. */
export type ToolInputGuardrailDecision = { pass: true } | { pass: false; reason: string };

// ─── Tool-output guardrails (per tool result, not run-halting) ────────────

/** Context for a tool-output guardrail: what the tool actually returned. */
export interface ToolOutputGuardrailContext {
  toolName: string;
  arguments: Record<string, unknown>;
  callId: string;
  step: number;
  trace: TraceContext;
  /** What the tool returned, as the model would receive it. */
  result: string;
}

/** A tool-output guardrail decision.
 *
 *  A trip does NOT halt the run and does not fail the call: the output is
 *  WITHHELD and a placeholder takes its place. That is the difference that
 *  matters -- a tool that returned somebody else's data has already run, so the
 *  only thing left to control is what reaches the model and the transcript.
 *  Halting would leave the output in the history it was meant to be kept out of. */
export type ToolOutputGuardrailDecision =
  | { pass: true }
  | {
      pass: false;
      /** Why it was withheld. Reaches hooks and reports, NOT the model -- a
       *  reason that quotes what it found would put the thing back. */
      reason: string;
      /** What the model sees instead. Defaults to the loop's
       *  `toolOutputBlockedMessage`, itself defaulting to a data-free sentence. */
      replaceWith?: string;
    };

/** Inspects a tool's output AFTER it ran and before it reaches the model or the
 *  history. On a trip the output is replaced by a placeholder everywhere it
 *  would otherwise be kept: the result the model sees, the conversation, and any
 *  checkpoint written from it. */
export interface ToolOutputGuardrail {
  name: string;
  check(
    ctx: ToolOutputGuardrailContext,
  ): Promise<ToolOutputGuardrailDecision> | ToolOutputGuardrailDecision;
}

/** What the model is told when a tool's output was withheld.
 *
 *  A string, or a formatter for something more specific. The formatter FAILS
 *  CLOSED: if it throws or returns nothing usable, the default sentence is used
 *  rather than the output it was deciding about. */
export type ToolOutputBlockedMessage =
  | string
  | ((args: {
      defaultMessage: string;
      guardrailName: string;
      toolName: string;
      callId: string;
    }) => string | undefined | Promise<string | undefined>);

/** The data-free placeholder, used when nothing else resolves. */
export const TOOL_OUTPUT_WITHHELD = 'Output withheld by an output guardrail.';

/** Validates a tool call's arguments BEFORE it executes (and before any HITL
 *  approval interruption). On a trip the call is denied — the model receives the
 *  denial reason as an error tool result; the run continues and the approver is
 *  never consulted. Arguments are immutable once the model emits them, so a single
 *  pre-execution check is sufficient. */
export interface ToolInputGuardrail {
  name: string;
  check(
    ctx: ToolInputGuardrailContext,
  ): Promise<ToolInputGuardrailDecision> | ToolInputGuardrailDecision;
}

// ─── Hook context emitted when a guardrail trips ──────────────────────────

export interface GuardrailTriggeredContext {
  runId: string;
  agentId: string;
  step: number;
  guardrailName: string;
  kind: 'input' | 'output';
  reason: string;
  severity?: 'low' | 'medium' | 'high';
  trace?: TraceContext;
}
