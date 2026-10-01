/** Mutable accumulator for a single agent loop step.
 *  Passed through stream-event helpers so they don't fight closure state. */

import type { ToolCallPart } from '../llm/types/messages';
import type { Citation, Usage } from '../llm/types/response';

/** Accumulation bucket for one in-progress tool call (before tool_call_end). */
export interface ToolCallAccumEntry {
  id: string;
  name: string;
  args: string;
  _meta?: Record<string, unknown>;
}

/** All mutable state for one streaming step inside AgentLoop.stream(). */
export interface StepState {
  /** Which step this state belongs to. Needed so an event forwarded from inside
   *  the accumulator can be stamped like the ones the loop yields itself -- a
   *  stream event without a step number cannot be correlated with the step that
   *  produced it. */
  step: number;
  stepText: string;
  /** Commentary deltas, kept apart from stepText so the step's answer excludes narration. */
  stepCommentary: string;
  stepThinking: string;
  stepToolCalls: ToolCallPart[];
  toolCallAccum: Map<string, ToolCallAccumEntry>;
  stepUsage: Usage;
  stepFinishReason: string;
  /** Sources cited during this step, keyed by url. A Map rather than an array
   *  because Google repeats its grounding chunks across late chunks, and one page
   *  cited twice is one source. */
  stepCitations: Map<string, Citation>;
}
