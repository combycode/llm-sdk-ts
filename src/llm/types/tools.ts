/** Universal tool schema definitions. */

export interface FunctionTool {
  type?: 'function';
  name: string;
  description: string;
  parameters: JsonSchema;
  strict?: boolean;
  cache?: boolean;
}

export interface BuiltinTool {
  type: 'image_generation' | 'web_search' | 'code_interpreter' | 'file_search' | 'mcp';
  params?: Record<string, unknown>;
}

export type Tool = FunctionTool | BuiltinTool;

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export type JsonSchema = Record<string, unknown>;

export function isFunctionTool(tool: Tool): tool is FunctionTool {
  return !tool.type || tool.type === 'function';
}

export function isBuiltinTool(tool: Tool): tool is BuiltinTool {
  return !!tool.type && tool.type !== 'function';
}
