/** Registry key for an AgentTool: the function name, else the builtin type. */

import { isFunctionTool } from '../llm/types/tools';
import type { AgentTool } from './types';

export function toolKey(tool: AgentTool): string {
  return isFunctionTool(tool.definition) ? tool.definition.name : tool.definition.type;
}
