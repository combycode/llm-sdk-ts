/** Universal tool schema definitions. */

import type { SchemaSource } from './standard-schema';

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
    | 'programmatic_tool_calling'
    /** Shell commands (OpenAI + xAI Responses). Unlike every other builtin, this
     *  one is only provider-RUN when `params.environment` is a container:
     *
     *  - `{ environment: { type: 'container_auto' } }` -- OpenAI runs the commands
     *    in a container it provisions and streams stdout/stderr back. Measured
     *    2026-10-02: the request is rewritten to `container_reference` carrying the
     *    `container_id` it chose.
     *  - `{ environment: { type: 'local' } }` or omitted -- the model only ASKS;
     *    whoever called has to run the commands and feed the output back. The turn
     *    ends after the request, so `response.text` is empty by design and the
     *    commands are in `builtinToolCalls[].code`. An `onWarning` says so, because
     *    an empty answer with `finishReason: 'stop'` otherwise looks like success.
     *
     *  xAI REQUIRES `environment` (a 422 names the missing field) and accepts only
     *  `local`, so a shell call on xAI is always the second case. */
    | 'shell';
  params?: Record<string, unknown>;
}

/** Typed shape for an `image_generation` builtin's `params`. Editor help over a
 *  verbatim passthrough -- the adapter spreads `params` as siblings of `type`, so
 *  an option a provider adds tomorrow works today.
 *
 *  Supported on **openai** and **xai**, measured live 2026-10-01 through this
 *  library on `gpt-5.6-sol`, `gpt-5.4-nano`, `grok-4.6`, `grok-4.5` and
 *  `grok-4.3`: each returned an image on `response.media`.
 *
 *  One shape note worth knowing before reading `mimeType`: OpenAI reports
 *  `output_format` and reports it accurately, while xAI returns JPEG bytes and no
 *  format at all. The adapter therefore prefers the declared format, falls back to
 *  the image's own magic bytes, and only then to PNG -- so an xAI image is labeled
 *  `image/jpeg` rather than mislabeled `image/png`. */
export interface ImageGenerationToolParams {
  /** xAI: what the model may do with the tool. `auto` lets it choose, `generate`
   *  makes a new image, `edit` changes a supplied one.
   *
   *  Validated rather than inert -- `action: 'paint'` is a 400 naming the three
   *  values (measured 2026-10-01). Note `edit` with nothing to edit returns no
   *  image at all, which is a 200 with a text-only answer. */
  action?: 'auto' | 'generate' | 'edit' | (string & {});
  /** OpenAI: the encoding to return. Reported back on the item, which is why an
   *  OpenAI image's `mimeType` is the provider's word and an xAI image's is
   *  sniffed. */
  output_format?: 'png' | 'jpeg' | 'webp' | (string & {});
  /** OpenAI: rendering quality / size / background, forwarded verbatim. */
  quality?: string;
  size?: string;
  background?: string;
  /** Anything else the provider accepts, forwarded as given. */
  [key: string]: unknown;
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
 *                       public URL (behind NAT/firewall) via an outbound tunnel.
 *
 *  Measured 2026-10-01: all three pairings are refused by name
 *  (`Mutually exclusive parameters: 'tools[0]'. Ensure you are only providing one
 *  of: 'server_url' or 'connector_id'`, and the same for each other pair), so the
 *  one-of-three above is the API's rule, not our convention. `tunnel_id` is
 *  pattern-validated (`^tunnel_[a-z0-9]{32}$`) and a well-formed one reaches the
 *  point of dialling the tunnel, so it is a working field rather than a typed-only
 *  one. */
export interface McpToolParams {
  server_label: string;
  server_url?: string;
  /** A managed first-party connector.
   *
   *  **Deprecated by OpenAI for models released after 1 September 2026**, in
   *  favour of `server_url` or `tunnel_id`. It is still sent, and still works:
   *  measured 2026-10-01 on `gpt-5.6-sol`, `connector_id` with `authorization`
   *  answers 200. Without `authorization` it answers
   *  `Must specify 'authorization' parameter with 'connector_id'` — which is a
   *  requirement, not the deprecation biting.
   *
   *  So this is a documentation deprecation: nothing is removed here, because a
   *  field a provider still honours is not ours to withdraw. Prefer `server_url`
   *  or `tunnel_id` for new code. */
  connector_id?: string;
  tunnel_id?: string;
  /** Required alongside `connector_id`; the connector's OAuth token. */
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

/** A function tool as a CALLER may declare it: its schemas may be plain JSON
 *  Schema or any **Standard Schema** (`~standard`) -- a Zod/Valibot/ArkType
 *  schema passes straight in.
 *
 *  Separate from `FunctionTool` rather than a widening of it, because the two say
 *  different things. `FunctionTool` is the NORMALIZED form: by the time a tool
 *  reaches a wire spec, an adapter or a snapshot, every schema on it is plain
 *  JSON Schema, and that invariant is worth having in the type rather than in a
 *  comment. `toWireTools` is the one place the conversion happens. */
export type FunctionToolInput = Omit<FunctionTool, 'parameters' | 'outputSchema'> & {
  parameters: SchemaSource;
  outputSchema?: SchemaSource;
};

/** A tool as a caller may declare it. */
export type ToolInput = FunctionToolInput | BuiltinTool;

/** Overloaded over the two forms so one guard serves both: callers hold a
 *  declaration (`ToolInput`, whose schemas may be Standard Schemas) before the
 *  request boundary and a normalized `Tool` after it, and neither should need a
 *  second predicate to ask the same question. */
export function isFunctionTool(tool: Tool): tool is FunctionTool;
export function isFunctionTool(tool: ToolInput): tool is FunctionToolInput;
export function isFunctionTool(tool: Tool | ToolInput): boolean {
  return !tool.type || tool.type === 'function';
}

export function isBuiltinTool(tool: Tool): tool is BuiltinTool;
export function isBuiltinTool(tool: ToolInput): tool is BuiltinTool;
export function isBuiltinTool(tool: Tool | ToolInput): boolean {
  return !!tool.type && tool.type !== 'function';
}
