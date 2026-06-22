/** handoff — richer sibling to delegate().
 *
 *  Wraps an AgentLoop as an AgentTool but returns a structured HandoffResult
 *  (text + usage + agentName) serialised as JSON, rather than bare text.
 *  The parent loop sees usage and routing metadata in the tool result.
 *
 *  Like delegate(), it is a normal AgentTool so it flows through
 *  onToolCallStart — approval gates or hook overrides still apply.
 *
 *  delegate() is kept unchanged for back-compat; handoff() is the richer path. */

import type { AgentLoop } from '../agent/loop';
import type { AgentTool } from '../agent/types';
import { defineTool } from './define-tool';
import type { HandoffOptions, HandoffResult } from './handoff-types';

export function handoff(
  name: string,
  description: string,
  agent: AgentLoop,
  opts: HandoffOptions = {},
): AgentTool {
  const { inputFilter } = opts;

  return defineTool({
    name,
    description,
    params: { task: 'string' },
    execute: async ({ task }) => {
      const resolvedTask = inputFilter ? inputFilter(task) : task;
      const response = await agent.complete(resolvedTask);

      const result: HandoffResult = {
        text: response.text,
        usage: response.usage,
        agentName: name,
      };

      return JSON.stringify(result);
    },
  });
}
