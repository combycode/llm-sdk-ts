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

/** Typed shape for an `mcp` builtin's `params` (OpenAI hosted MCP tool). The
 *  adapter forwards `params` verbatim, so this is for editor help — assign it as
 *  `{ type: 'mcp', params: <McpToolParams> }`. Exactly one of `server_url`,
 *  `connector_id`, or `tunnel_id` identifies the server (OpenAI enforces this):
 *    - `server_url`   — a publicly reachable MCP server OpenAI dials directly.
 *    - `connector_id` — a managed first-party connector (Gmail, Drive, …).
 *    - `tunnel_id`    — a Secure MCP Tunnel: reach a private/local server with no
 *                       public URL (behind NAT/firewall) via an outbound tunnel. */
export interface McpToolParams {
  server_label: string;
  server_url?: string;
  connector_id?: string;
  tunnel_id?: string;
  authorization?: string;
  headers?: Record<string, string>;
  require_approval?: 'always' | 'never' | Record<string, unknown>;
  allowed_tools?: string[] | Record<string, unknown>;
  server_description?: string;
  /** Forward-compat: any other field OpenAI accepts is passed through. */
  [key: string]: unknown;
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
