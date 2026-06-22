/** Public MCP entry points.
 *
 *  `connectMcp(config)` — connect to one MCP server (url = Streamable HTTP,
 *  command = stdio) and get its tools as `AgentTool[]`, ready to drop into
 *  `complete()` / `createAgent()` with any provider.
 *  `mcpToolset(configs)` — connect to several servers and get one flat toolset.
 *
 *  Client-side execution: the model sees ordinary function tools; our loop runs
 *  `tools/call`. Works identically across every provider. See docs/design/mcp.md. */

import type { AgentTool } from '../agent/types';
import { McpClient } from '../plugins/mcp/client';
import { McpError, McpErrorCode } from '../plugins/mcp/jsonrpc';
import { type McpAuthProvider, McpOAuth, McpUnauthorizedError } from '../plugins/mcp/oauth';
import type { SsrfGuardOptions } from '../plugins/mcp/url-guard';
import { type McpSamplingConfig, samplingHandler } from '../plugins/mcp/sampling';
import { mcpToolToAgentTool } from '../plugins/mcp/tools';
import type { McpTransport } from '../plugins/mcp/transport';
import { HttpTransport } from '../plugins/mcp/transport-http';
import { StdioTransport } from '../plugins/mcp/transport-stdio';
import { WsTransport } from '../plugins/mcp/transport-ws';
import {
  isHttpConfig,
  type McpCreateMessageParams,
  type McpElicitRequestParams,
  type McpElicitResult,
  type McpHttpConfig,
  type McpInitializeResult,
  type McpRoot,
  type McpServerConfig,
  type McpStdioConfig,
} from '../plugins/mcp/types';
import { coreRegistry, type EngineHandle } from './engine';

export interface ConnectMcpOptions {
  /** Engine providing `fetch`/`fetchStream` for HTTP transports. Default: the registered core engine. */
  engine?: EngineHandle;
  clientInfo?: { name: string; version: string };
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Namespace for tool names. Default: server name / url host / command basename. */
  namespace?: string;
  /** Every server->client notification (logging, *_changed, progress, …). */
  onNotification?: (method: string, params: unknown) => void;
  /** Re-list tools on `notifications/tools/list_changed` (updates `connection.tools` in place). */
  autoRefreshTools?: boolean;
  /** Called after an auto-refresh with the updated tool list. */
  onToolsChanged?: (tools: AgentTool[]) => void;
  /** Enable sampling: fulfill the server's `sampling/createMessage` with our LLM
   *  (pass a model id) or a custom handler. Declares the `sampling` capability. */
  sampling?: McpSamplingConfig;
  /** Enable elicitation: answer the server's `elicitation/create`. Declares the capability. */
  elicit?: (params: McpElicitRequestParams) => Promise<McpElicitResult>;
  /** Expose filesystem roots to the server (`roots/list`). Declares the capability. */
  roots?: McpRoot[] | (() => McpRoot[] | Promise<McpRoot[]>);
  /** Validate tool `structuredContent` against the tool's `outputSchema`. */
  validateOutput?: boolean;
  /** Send a `ping` every N ms to keep the connection alive (0 = off). */
  keepAliveMs?: number;
  /** OAuth provider for servers that require authorization (HTTP only). On a
   *  required interactive grant, `connectMcp` throws `McpUnauthorizedError`
   *  after the provider redirects; finish with `finishMcpAuth`, then reconnect. */
  auth?: McpAuthProvider;
  /** SSRF security options for the OAuth flow. All options default to the most
   *  restrictive posture (https-only, no loopback, same-origin). Use
   *  `allowInsecureHttp`/`allowLoopback` ONLY for local development. */
  security?: SsrfGuardOptions;
}

export interface McpConnection {
  /** The server's initialize result (capabilities, serverInfo). */
  readonly serverInfo: McpInitializeResult | null;
  /** The server's tools, namespaced and ready for the loop. */
  readonly tools: AgentTool[];
  /** Re-fetch the tool list (returns freshly-wrapped AgentTools). */
  listTools(): Promise<AgentTool[]>;
  /** The underlying client (resources/prompts/logging/low-level access). */
  readonly client: McpClient;
  /** Disconnect (kill the process / terminate the HTTP session). */
  close(): Promise<void>;
}

function defaultNamespace(config: McpServerConfig): string {
  if (isHttpConfig(config)) {
    if (config.name) return config.name;
    try {
      return new URL(config.url).hostname.split('.')[0];
    } catch {
      return 'mcp';
    }
  }
  return config.name ?? config.command.replace(/.*[\\/]/, '').replace(/\.[a-z]+$/i, '');
}

function sanitizeNs(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_') || 'mcp';
}

/** Connect to a single MCP server and return its tools + lifecycle handle. */
export async function connectMcp(
  config: McpServerConfig,
  opts: ConnectMcpOptions = {},
): Promise<McpConnection> {
  const ns = sanitizeNs(opts.namespace ?? defaultNamespace(config));
  const isHttp = isHttpConfig(config);
  const isWs = isHttp && /^wss?:/i.test(config.url);
  const engine = isHttp ? (opts.engine ?? coreRegistry.get()) : undefined;

  // OAuth (HTTP only): attach the bearer per request + re-auth on 401.
  const oauth = isHttp && !isWs && opts.auth && engine ? new McpOAuth(config.url, opts.auth, engine.fetch, opts.security) : null;

  let transport: McpTransport;
  if (isWs && engine) {
    transport = new WsTransport(config as McpHttpConfig, { connect: engine.connect, timeoutMs: opts.timeoutMs });
  } else if (isHttp && engine) {
    transport = new HttpTransport(config as McpHttpConfig, {
      fetch: engine.fetch,
      fetchStream: engine.fetchStream,
      queueName: `mcp/${ns}`,
      timeoutMs: opts.timeoutMs,
      getAuthHeaders: oauth ? () => oauth.authHeader() : undefined,
      onUnauthorized: oauth ? () => oauth.reauthorize() : undefined,
    });
  } else {
    transport = new StdioTransport(config as McpStdioConfig, { timeoutMs: opts.timeoutMs });
  }

  // `tools` is a STABLE array mutated in place on refresh, so a holder of the
  // reference (e.g. an AgentLoop) sees dynamic tool updates.
  const tools: AgentTool[] = [];
  const refresh = async (c: McpClient): Promise<void> => {
    const defs = await c.listTools();
    tools.length = 0;
    for (const d of defs) tools.push(mcpToolToAgentTool(c, d, ns, { validateOutput: opts.validateOutput }));
  };

  // Capability declaration + server->client request dispatch (P3).
  const sampler = opts.sampling ? samplingHandler(opts.sampling) : null;
  const capabilities: Record<string, unknown> = {};
  if (sampler) capabilities.sampling = {};
  if (opts.elicit) capabilities.elicitation = {};
  if (opts.roots) capabilities.roots = { listChanged: false };

  const hasServerHandlers = Boolean(sampler || opts.elicit || opts.roots);
  const onServerRequest = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'sampling/createMessage' && sampler) return sampler(params as McpCreateMessageParams);
    if (method === 'elicitation/create' && opts.elicit) return opts.elicit(params as McpElicitRequestParams);
    if (method === 'roots/list' && opts.roots) {
      return { roots: typeof opts.roots === 'function' ? await opts.roots() : opts.roots };
    }
    throw new McpError({ code: McpErrorCode.MethodNotFound, message: `unsupported server request: ${method}` });
  };

  const engineHooks = opts.engine?.hooks;
  const transportKind: 'stdio' | 'http' | 'ws' = isHttpConfig(config)
    ? /^wss?:/i.test(config.url)
      ? 'ws'
      : 'http'
    : 'stdio';

  const client = new McpClient(transport, {
    clientInfo: opts.clientInfo,
    capabilities,
    hooks: engineHooks,
    server: ns,
    keepAliveMs: opts.keepAliveMs,
    onServerRequest: hasServerHandlers ? onServerRequest : undefined,
    onNotification: (method, params) => {
      opts.onNotification?.(method, params);
      if (opts.autoRefreshTools && method === 'notifications/tools/list_changed') {
        void refresh(client).then(() => opts.onToolsChanged?.(tools));
      }
    },
  });
  try {
    // Ensure authorization before the handshake (so initialize carries the bearer).
    if (oauth && (await oauth.authorize()) === 'redirect') {
      throw new McpUnauthorizedError(`MCP server ${(config as McpHttpConfig).url} requires authorization`);
    }
    await client.connect();
    await refresh(client);
  } catch (e) {
    engineHooks?.emitSync('onMcpError', { server: ns, phase: 'connect', error: e instanceof Error ? e : new Error(String(e)) });
    throw e;
  }
  engineHooks?.emitSync('onMcpConnect', {
    server: ns,
    transport: transportKind,
    serverName: client.info?.serverInfo.name,
    serverVersion: client.info?.serverInfo.version,
    toolCount: tools.length,
  });

  return {
    get serverInfo() {
      return client.info;
    },
    tools,
    client,
    async listTools() {
      await refresh(client);
      return tools;
    },
    close: () => client.close(),
  };
}

/** Connect to several MCP servers and return one combined, namespaced toolset. */
/** Finish an interactive OAuth grant: exchange the callback `code` for tokens
 *  (saved via the provider). The `state` from the authorization callback MUST
 *  be provided and is validated against the persisted value (CSRF guard).
 *  Call after catching `McpUnauthorizedError`, then `connectMcp` again. */
export async function finishMcpAuth(
  serverUrl: string,
  code: string,
  state: string,
  opts: { auth: McpAuthProvider; engine?: EngineHandle; security?: SsrfGuardOptions },
): Promise<void> {
  const fetch = (opts.engine ?? coreRegistry.get()).fetch;
  await new McpOAuth(serverUrl, opts.auth, fetch, opts.security).finish(code, state);
}

export async function mcpToolset(
  configs: McpServerConfig[],
  opts: ConnectMcpOptions = {},
): Promise<{ tools: AgentTool[]; connections: McpConnection[]; close(): Promise<void> }> {
  const connections = await Promise.all(configs.map((c) => connectMcp(c, opts)));
  return {
    tools: connections.flatMap((c) => c.tools),
    connections,
    close: async () => {
      await Promise.all(connections.map((c) => c.close()));
    },
  };
}
