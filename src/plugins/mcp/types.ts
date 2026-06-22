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

export interface McpToolDef {
  name: string;
  description?: string;
  title?: string;
  /** JSON Schema (object at root) for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for the tool's `structuredContent` output (optional). */
  outputSchema?: Record<string, unknown>;
}

/** A content block in a `tools/call` result. Open union — unknown types ignored. */
export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
  | { type: 'resource_link'; uri: string; mimeType?: string; title?: string }
  | { type: string; [k: string]: unknown };

export interface McpCallResult {
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

export interface McpGetPromptResult {
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
