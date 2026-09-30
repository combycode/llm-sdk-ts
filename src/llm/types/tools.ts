/** Universal tool schema definitions. */

export interface FunctionTool {
  type?: 'function';
  name: string;
  description: string;
  parameters: JsonSchema;
  strict?: boolean;
  cache?: boolean;
  /** OpenAI **Responses** programmatic tool calling: which callers may invoke this
   *  tool — `direct` (the model calls it) and/or `programmatic` (generated
   *  orchestration code calls it). OpenAI-Responses-only; ignored elsewhere. */
  allowedCallers?: Array<'direct' | 'programmatic'>;
  /** OpenAI **Responses** JSON schema for the tool's return value (lets the model
   *  reason over structured tool output). OpenAI-Responses-only. */
  outputSchema?: JsonSchema;
}

export interface BuiltinTool {
  type:
    | 'image_generation'
    | 'web_search'
    | 'web_fetch'
    | 'code_interpreter'
    | 'file_search'
    | 'mcp'
    /** OpenAI Responses: lets the model write JS to orchestrate tool calls. */
    | 'programmatic_tool_calling';
  params?: Record<string, unknown>;
}

/** Typed shape for a `web_search` builtin's `params` (OpenAI Responses). Like
 *  `McpToolParams` this is editor help over a verbatim passthrough -- the
 *  adapter forwards `params` as given -- so an option OpenAI adds tomorrow
 *  still works today.
 *
 *  Asking for images has a second half the caller must not have to know about:
 *  image results are only returned when the request also carries
 *  `include: ["web_search_call.results"]`. The adapter adds that itself
 *  whenever `search_content_types` contains `"image"`, so
 *  `response.builtinCalls[].results` is populated rather than quietly empty.
 */
export interface WebSearchToolParams {
  /** `false` runs the search offline: the tool answers from cache and fetches
   *  no new external content. Defaults to `true` when omitted. */
  external_web_access?: boolean;
  /** What the search may return. Include `'image'` for image results, and
   *  `'text'` as well when the model needs supporting text to reason over. */
  search_content_types?: Array<'text' | 'image'>;
  /** Shapes the image results, and only meaningful with `'image'` above. */
  image_settings?: {
    /** How many image results to ask for. Positive. */
    max_results?: number;
    /** Request a short description of each image where one is available. */
    caption?: boolean;
  };
  /** How much context window the search may spend. `medium` is the default. */
  search_context_size?: 'low' | 'medium' | 'high';
  /** Restrict the search to these domains; subdomains count. */
  filters?: { allowed_domains?: string[] };
  /** Where the user is, for localised results. Omitted defaults to the US. */
  user_location?: {
    type?: 'approximate';
    city?: string;
    country?: string;
    region?: string;
    timezone?: string;
  };
  /** Forward-compat: any other field OpenAI accepts is passed through. */
  [key: string]: unknown;
}

/** Which sources contribute URLs that Anthropic's `web_fetch` may fetch.
 *
 *  Each key is a tagged variant. `user_input` is `all` or `none`; the two tool
 *  filters add `only` (just the named tools' results) and `except` (every
 *  result but theirs). A name listed in `tool_names` must be a tool declared
 *  in the same request.
 *
 *  Worth setting deliberately: left unset, the fetchable set is whatever the
 *  server defaults to, and "the model may fetch any URL a tool result
 *  mentioned" is a wider reach than most callers intend. */
export interface WebFetchUrlSources {
  /** URLs in the user's own messages. */
  user_input?: { type: 'all' } | { type: 'none' };
  /** URLs appearing in YOUR tools' results. */
  client_tool_results?:
    | { type: 'all' }
    | { type: 'none' }
    | { type: 'only'; tool_names: string[] }
    | { type: 'except'; tool_names: string[] };
  /** URLs appearing in the provider's own tool results. Only `web_search` and
   *  `web_fetch` results ever contribute any. */
  server_tool_results?:
    | { type: 'all' }
    | { type: 'none' }
    | { type: 'only'; tool_names: string[] }
    | { type: 'except'; tool_names: string[] };
}

/** Typed shape for a `web_fetch` builtin's `params` (Anthropic). Editor help
 *  over a verbatim passthrough, like `McpToolParams`. */
export interface WebFetchToolParams {
  /** Which sources contribute fetchable URLs. */
  url_sources?: WebFetchUrlSources;
  /** Cap on how many fetches this tool may perform in one turn. */
  max_uses?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  /** Forward-compat: any other field Anthropic accepts is passed through. */
  [key: string]: unknown;
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
