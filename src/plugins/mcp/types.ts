/** MCP (Model Context Protocol) wire types + client config for protocol
 *  v2025-11-25. See docs/design/mcp.md. Hand-rolled (no `@modelcontextprotocol/sdk`)
 *  to stay zero-dep and browser-capable. */

/** Protocol version we advertise in `initialize`. */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

// ─── JSON-RPC 2.0 ─────────────────────────────────────────────────────────

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

// ─── MCP tools + content ──────────────────────────────────────────────────

/** Behavioural hints a server publishes about a tool. Advisory and UNVERIFIED — a
 *  server asserts them about itself — so they inform a host's UX (confirm before a
 *  destructive call) and must never be treated as a security boundary.
 *
 *  Open (CONSTITUTION R1): the spec gains hints over time and an unknown one must
 *  survive rather than be dropped. */
export interface McpToolAnnotations {
  title?: string;
  /** The tool does not modify its environment. Default false. */
  readOnlyHint?: boolean;
  /** The tool may perform destructive updates rather than only additive ones. */
  destructiveHint?: boolean;
  /** Repeated calls with the same arguments have no additional effect. */
  idempotentHint?: boolean;
  /** The tool touches an open world (the internet) rather than a closed one. */
  openWorldHint?: boolean;
  [hint: string]: unknown;
}

/** An icon a host may render beside the tool. Display only. */
export interface McpToolIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark' | (string & {});
}

/** How the tool must be invoked.
 *
 *  `taskSupport: 'required'` means the client MUST call it as a task rather than a
 *  plain `tools/call`. Task invocation is not implemented here, so such a tool
 *  cannot be called through this client — carrying the field lets a caller SEE
 *  that instead of discovering it as a server error. Absent means `'forbidden'`. */
export interface McpToolExecution {
  taskSupport?: 'required' | 'optional' | 'forbidden' | (string & {});
}

export interface McpToolDef {
  name: string;
  description?: string;
  title?: string;
  /** JSON Schema (object at root) for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for the tool's `structuredContent` output (optional). */
  outputSchema?: Record<string, unknown>;
  /** Advisory behavioural hints. HOST-facing, never sent to the model: no
   *  provider's function-tool schema has a field that could carry them. */
  annotations?: McpToolAnnotations;
  /** Display icons for a host UI. */
  icons?: McpToolIcon[];
  /** Invocation requirements; see {@link McpToolExecution}. */
  execution?: McpToolExecution;
  /** Spec-defined passthrough metadata. */
  _meta?: Record<string, unknown>;
}

/** A content block in a `tools/call` result. Open union — unknown types ignored. */
export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
  | { type: 'resource_link'; uri: string; mimeType?: string; title?: string }
  | { type: string; [k: string]: unknown };

/** One server→client request embedded in an `input_required` result: a `sampling/createMessage`,
 *  `elicitation/create` or `roots/list`, in JSON-RPC request shape. Identical in content to what a
 *  handshake-era server pushes over the back-channel — only the delivery differs. */
export interface McpInputRequest {
  method: string;
  params?: unknown;
}

/** Client-side caching directives carried by 2026-07-28 list/read results (`CacheableResult`).
 *
 *  Optional here because every pre-2026 server omits them, and a server that sends no hints must
 *  behave exactly as before (CONSTITUTION.md R3). */
export interface McpCacheHints {
  /** How long (ms) the client MAY reuse this result. **`0` means immediately stale** — re-fetch
   *  every time — so it is NOT the same as "absent" and must not be coerced to a default. */
  ttlMs?: number;
  /** `'public'`: no user-specific data, any cache may serve it across authorization contexts.
   *  `'private'`: reusable only within the same authorization context. */
  cacheScope?: 'private' | 'public';
}

/** The 2026-07-28 multi-round-trip fields (SEP-2322).
 *
 *  Upstream models this as a separate `InputRequiredResult` type, making every result a union. We
 *  attach it as OPTIONAL fields on the existing results instead (CONSTITUTION.md R2): code reading
 *  `result.content` keeps compiling, and callers who never meet a modern server never see them. */
export interface McpInputRequiredFields {
  /** `'complete'` | `'input_required'`. **Absent MUST be read as `'complete'`** — earlier revisions
   *  never send it. Open by R1: a future revision may add a third kind. */
  resultType?: 'complete' | 'input_required' | (string & {});
  /** Server-assigned key → the request to answer. Present when the server has questions. */
  inputRequests?: Record<string, McpInputRequest>;
  /** Opaque continuation token. Echoed back byte-exact and never inspected. */
  requestState?: string;
}

export interface McpCallResult extends McpInputRequiredFields {
  content: McpContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

// ─── Resources / prompts / logging (P2) ──────────────────────────────────

export interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpPromptArg {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArg[];
}

export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: McpContentBlock;
}

export interface McpGetPromptResult extends McpInputRequiredFields {
  description?: string;
  messages: McpPromptMessage[];
}

export type McpLogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

/** Reference for argument autocompletion (`completion/complete`). */
export type McpCompletionRef =
  | { type: 'ref/prompt'; name: string }
  | { type: 'ref/resource'; uri: string };

export interface McpCompletionResult {
  values: string[];
  total?: number;
  hasMore?: boolean;
}

// ─── Server->client requests (P3) ─────────────────────────────────────────

export interface McpSamplingMessage {
  role: 'user' | 'assistant';
  content: McpContentBlock;
}

/** Params of a server-initiated `sampling/createMessage` (the server asks us to
 *  run an LLM completion on its behalf). */
export interface McpCreateMessageParams {
  messages: McpSamplingMessage[];
  systemPrompt?: string;
  maxTokens: number;
  temperature?: number;
  stopSequences?: string[];
  modelPreferences?: {
    hints?: Array<{ name?: string }>;
    costPriority?: number;
    speedPriority?: number;
    intelligencePriority?: number;
  };
  includeContext?: 'none' | 'thisServer' | 'allServers';
  metadata?: Record<string, unknown>;
}

export interface McpCreateMessageResult {
  role: 'assistant';
  content: McpContentBlock;
  model: string;
  stopReason?: string;
}

/** Params of a server-initiated `elicitation/create` (ask the user for input). */
export interface McpElicitRequestParams {
  message: string;
  requestedSchema: Record<string, unknown>;
}

export interface McpElicitResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

/** A filesystem root we expose to the server (`roots/list`). */
export interface McpRoot {
  uri: string;
  name?: string;
}

// ─── Tasks — long-running tool calls (P4) ─────────────────────────────────

export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface McpTask {
  taskId: string;
  status: McpTaskStatus;
  /** ms to keep results after completion; null = unlimited. */
  ttl: number | null;
  createdAt: string;
  lastUpdatedAt: string;
  /** Suggested poll interval (ms). */
  pollInterval?: number;
  statusMessage?: string;
}

/** Request augmentation: include on a `tools/call` to run it as a task. */
export interface McpTaskMetadata {
  ttl?: number;
}

export interface McpServerInfo {
  name: string;
  version: string;
  title?: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: McpServerInfo;
  instructions?: string;
}

/** Result of the 2026-07-28 `server/discover` probe — the modern replacement for the `initialize`
 *  handshake. Shape verified against mcp-py 2.0.0 (`_v2026_07_28.DiscoverResult`).
 *
 *  `McpClient.info` synthesises an `McpInitializeResult` from this, so a caller never has to branch
 *  on the era (CONSTITUTION.md R2). This type exposes the fields that have no handshake equivalent. */
export interface McpDiscoverResult {
  capabilities: Record<string, unknown>;
  /** Revisions the server speaks; the client picks one from this list. */
  supportedVersions: string[];
  /** How long (ms) the client MAY cache this result. `0` = treat as immediately stale. */
  ttlMs?: number;
  /** `public` = cacheable across authorization contexts; `private` = same context only. */
  cacheScope?: 'private' | 'public';
  instructions?: string;
  /** Absent on servers implementing an earlier revision, which MUST be read as `'complete'`. */
  resultType?: string;
  /** Carries the display-only `io.modelcontextprotocol/serverInfo` stamp. */
  _meta?: Record<string, unknown>;
}

// ─── Client config (url variant = HTTP, command variant = stdio) ──────────

export interface McpHttpConfig {
  /** Streamable-HTTP MCP endpoint URL. Cross-env (browser needs server CORS). */
  url: string;
  /** Extra headers (e.g. `Authorization: Bearer …`). */
  headers?: Record<string, string>;
  /** Short label for tool namespacing + telemetry. Default: the URL host. */
  name?: string;
}

export interface McpStdioConfig {
  /** Command to spawn (stdio transport — Node/Bun only). */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Short label for tool namespacing. Default: the command basename. */
  name?: string;
}

export type McpServerConfig = McpHttpConfig | McpStdioConfig;

/** Discriminate the two config variants by the presence of `url`. */
export function isHttpConfig(c: McpServerConfig): c is McpHttpConfig {
  return typeof (c as McpHttpConfig).url === 'string';
}
