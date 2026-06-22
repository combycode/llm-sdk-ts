/** HITL (Human-in-the-Loop) approval types.
 *
 *  ApprovalRequest  — sent to the approve() callback when a tool call needs human sign-off.
 *  ApprovalDecision — returned by the approver to tell the loop what to do next.
 *  PendingToolCall  — serializable record stored in AgentLoopSnapshot while approval is awaited. */

import type { TraceContext } from '../network/types';

/** Sent to the `approve` callback when a tool call needs human approval. */
export interface ApprovalRequest {
  /** Unique ID of the tool call (from the LLM response). */
  callId: string;
  /** Name of the tool being called. */
  toolName: string;
  /** Arguments the model wants to pass to the tool. */
  arguments: Record<string, unknown>;
  /** Human-readable reason why approval is required (from the matching permission rule). */
  reason?: string;
  /** Step index within the run. */
  step: number;
  /** Run identity: sessionId = agentId (ConversationHistory id),
   *  requestId = runId for this .complete()/.stream() invocation,
   *  callId = this tool call's id (same as ApprovalRequest.callId). */
  trace: TraceContext;
}

/** Returned by the approver to direct the loop. */
export interface ApprovalDecision {
  /** 'approve' — execute the tool normally.
   *  'deny'    — block the tool; the model receives a denial message.
   *  'skip'    — skip silently; the model receives a skip message. */
  decision: 'approve' | 'deny' | 'skip';
  /** When set, inject this string as the tool result instead of executing. */
  overrideResult?: string;
  /** Optional note logged in the tool report. */
  note?: string;
}

/** Serializable record of a pending approval stored in AgentLoopSnapshot. */
export interface PendingToolCall {
  /** Unique ID of the tool call. */
  callId: string;
  /** Name of the tool. */
  toolName: string;
  /** Arguments the model wanted to pass. */
  arguments: Record<string, unknown>;
  /** Step index within the run. */
  step: number;
  /** ISO timestamp (ms since epoch) when the approval was requested. */
  requestedAt: number;
  /** Run ID of the suspended run. */
  runId: string;
}
