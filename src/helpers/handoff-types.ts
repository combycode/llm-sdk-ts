/** Types for the handoff() helper — structured agent-to-agent delegation.
 *  Extracted per the library rule: types in *-types.ts, never inline. */

import type { Usage } from '../llm/types/response';

/** The structured result returned by a handoff tool call. */
export interface HandoffResult {
  /** Plain text response from the sub-agent. */
  text: string;
  /** Token usage reported by the sub-agent's run. Null when not available. */
  usage: Usage | null;
  /** The sub-agent's display name (passed as `name` to handoff()). */
  agentName: string;
}

/** Options for handoff(). */
export interface HandoffOptions {
  /** Transform the task string before passing it to the sub-agent.
   *  Useful for reformatting or adding context without modifying the parent's input. */
  inputFilter?: (task: string) => string;
}
