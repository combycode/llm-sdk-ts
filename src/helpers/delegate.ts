/** delegate — wrap an AgentLoop as a single AgentTool that another agent
 *  can call. The tool takes a `task: string` and returns the sub-agent's
 *  reply text. Useful for agent-as-tool composition / routing patterns. */

import type { AgentLoop } from '../agent/loop';
import type { AgentTool } from '../agent/types';
import { defineTool } from './define-tool';

export function delegate(name: string, description: string, agent: AgentLoop): AgentTool {
  return defineTool({
    name,
    description,
    params: { task: 'string' },
    execute: async ({ task }) => (await agent.complete(task)).text,
  });
}
