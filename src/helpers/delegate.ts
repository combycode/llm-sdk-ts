/** delegate — wrap an AgentLoop as a single AgentTool that another agent
 *  can call. The tool takes a `task: string` and returns the sub-agent's
 *  reply text. Useful for agent-as-tool composition / routing patterns. */

import type { AgentLoop } from '../agent/loop';
import type { AgentTool, ToolExecutionContext } from '../agent/types';
import { defineTool } from './define-tool';

/** What a nested run inherits from the call that started it.
 *
 *  Two things, and both used to be dropped: the caller's CANCELLATION, so
 *  stopping the parent left the sub-agent running a conversation nobody would
 *  read; and the caller's TRACE, so the sub-run rooted a trace of its own and
 *  the two halves of one request could not be joined — which is the entire
 *  point of a trace id.
 *
 *  Deliberately NOT inherited: anything about tool selection. A sub-agent is a
 *  different agent with its own tools, and the official agents SDK excludes
 *  `toolChoice`/`parallelToolCalls` from nested inheritance for the same reason
 *  — a parent's choice among ITS tools means nothing to a child that does not
 *  have them. */
export function nestedRunOptions(ctx: ToolExecutionContext): {
  signal: AbortSignal;
  ctx: Record<string, unknown>;
} {
  return {
    signal: ctx.signal,
    // The WHOLE trace, not a field or two of it. `beginRun` resolves
    // sessionId/requestId together and the comment there records why: a caller
    // passing only `sessionId` split one run across two traces. `callId` names
    // the call that delegated, so the nested run hangs off it rather than
    // floating beside the parent.
    ctx: { ...ctx.trace, callId: ctx.callId },
  };
}

export function delegate(name: string, description: string, agent: AgentLoop): AgentTool {
  return defineTool({
    name,
    description,
    params: { task: 'string' },
    execute: async ({ task }, ctx) => (await agent.complete(task, nestedRunOptions(ctx))).text,
  });
}
