/** Registry key for an AgentTool: the function name, else the builtin type. */

import { isFunctionTool } from '../llm/types/tools';
import type { AgentTool } from './types';

export function toolKey(tool: AgentTool): string {
  return isFunctionTool(tool.definition) ? tool.definition.name : tool.definition.type;
}

/** A short label for a tool, for collision diagnostics. Names the KIND as well as the key, because
 *  a function tool shadowing a builtin (or the reverse) is the case that reads as impossible. */
export function describeTool(tool: AgentTool): string {
  return isFunctionTool(tool.definition)
    ? `function:${tool.definition.name}`
    : `builtin:${tool.definition.type}`;
}
