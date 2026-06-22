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
