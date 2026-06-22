/** Mutable accumulator for a single agent loop step.
 *  Passed through stream-event helpers so they don't fight closure state. */

import type { ToolCallPart } from '../llm/types/messages';
import type { Usage } from '../llm/types/response';

/** Accumulation bucket for one in-progress tool call (before tool_call_end). */
export interface ToolCallAccumEntry {
  id: string;
  name: string;
  args: string;
  _meta?: Record<string, unknown>;
}

/** All mutable state for one streaming step inside AgentLoop.stream(). */
export interface StepState {
  stepText: string;
  stepThinking: string;
  stepToolCalls: ToolCallPart[];
  toolCallAccum: Map<string, ToolCallAccumEntry>;
  stepUsage: Usage;
  stepFinishReason: string;
}
