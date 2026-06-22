---
title: MCP Client
---

# MCP Client

Source: `src/plugins/mcp/`, `src/helpers/mcp.ts`.

## Purpose and responsibilities

A client-side Model Context Protocol (MCP) integration. Connects to MCP servers, lists
their tools, and exposes each as a normal `AgentTool` so the model calls them like any
function tool and the `AgentLoop` executes them via `tools/call`. Works uniformly across
all five providers — the model never sees provider-specific MCP surfaces.

Three transports: **stdio** (spawn a local process; Node/Bun only), **Streamable HTTP**
(POST-based, cross-env including browser), **WebSocket** (`wss://`, cross-env).

Zero runtime dependencies. JSON-RPC 2.0 and all transports are hand-rolled. The reference
SDK (`official-skds/mcp-ts` v1.29.0) is the correctness oracle.

Does NOT implement the MCP **server** role -- this is a client-only implementation.

---

## Architecture

```text
src/plugins/mcp/
  types.ts           MCP wire types + McpServerConfig (HttpConfig / StdioConfig)
  jsonrpc.ts         McpErrorCode constants + McpError class
  transport.ts       McpTransport interface + IncomingMcpHandlers
  base-transport.ts  BaseJsonRpcTransport (shared pending-map, routing, timeout)
  transport-stdio.ts StdioTransport — node:child_process, NDJSON, browser-guarded
  transport-http.ts  HttpTransport — Streamable HTTP via engine.fetch (cross-env)
  transport-ws.ts    WsTransport — WebSocket via engine.connect (cross-env)
  client.ts          McpClient — connect/listTools/callTool/close + P2/P4 methods
  tools.ts           MCP tool -> AgentTool adapter; mcpContentToResult; mcpPromptToMessages
  sampling.ts        samplingHandler — fulfill server's sampling/createMessage
  oauth.ts           McpOAuth — OAuth 2.1 + PKCE + DCR + SSRF guard
  url-guard.ts       assertSafeAuthUrl + McpSsrfError (SSRF protection)
  win-spawn.ts       windowsSpawnPlan — Windows .cmd/.bat spawn resolution
src/helpers/mcp.ts   connectMcp() / mcpToolset() / finishMcpAuth() — public API
```

---

## Protocol constants (`src/plugins/mcp/types.ts`)

```ts
const MCP_PROTOCOL_VERSION = '2025-11-25';
```

Advertised in `initialize`. The client accepts any version returned by the server in the
`initialize` result (no strict version gating on responses).

JSON-RPC 2.0 response shape:
```ts
interface JsonRpcResponse {
  jsonrpc: '2.0'; id: number | string | null;
  result?: unknown; error?: JsonRpcError;
}
interface JsonRpcError { code: number; message: string; data?: unknown; }
```

---

## `McpError` and error codes (`src/plugins/mcp/jsonrpc.ts`)

```ts
const McpErrorCode = {
  ConnectionClosed: -32000, RequestTimeout: -32001,
  ParseError: -32700, InvalidRequest: -32600,
  MethodNotFound: -32601, InvalidParams: -32602, InternalError: -32603,
} as const;

class McpError extends Error {
  readonly code: number; readonly data?: unknown;
  constructor(err: JsonRpcError)
}
```

`McpError` is thrown for protocol-level failures (server unreachable, JSON-RPC error
response, timeout). Tool execution failures arrive as a normal result with `isError: true`
and are NOT thrown — `mcpContentToResult` surfaces them as error text to the model.

---

## Transport interface (`src/plugins/mcp/transport.ts`)

```ts
interface McpTransport {
  start(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  setHandlers(handlers: IncomingMcpHandlers): void;
  setProtocolVersion?(version: string): void;
  listen?(): Promise<void> | void;
  close(): Promise<void>;
}

interface IncomingMcpHandlers {
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  onNotification?: (method: string, params: unknown) => void;
}
```

`listen()` opens the server-to-client channel. For stdio it is a no-op (the process
stdout is already duplex). For HTTP it opens a GET SSE stream. `McpClient.connect` calls
`transport.listen?.()` after the initialize handshake.

---

## `BaseJsonRpcTransport` (`src/plugins/mcp/base-transport.ts`)

Abstract base class shared by all three transports. Owns:

- `nextId: number` — monotonic JSON-RPC request id counter.
- `pending: Map<number, Pending>` — in-flight requests waiting for a response.
- `handlers: IncomingMcpHandlers` — set via `setHandlers()`.

```ts
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
```

**`routeIncoming(msg)`** dispatches a parsed message:
- `msg.id` present, `msg.method` absent → response: `resolveResponse(msg)`.
- `msg.id` and `msg.method` both present → server-initiated request: `handleRequest(msg)`.
- `msg.method` present, `msg.id` absent → notification: `handlers.onNotification?.()`.

**`registerPending(id, resolve, reject, timeoutMs, method)`** arms a timer. On timeout,
removes from `pending` and rejects with `McpError({ code: RequestTimeout })`.

**`resolveResponse(msg)`** looks up `msg.id` in `pending`, clears the timer, and either
resolves with `msg.result` or rejects with `new McpError(msg.error)`.

**`handleRequest(msg)`** calls `handlers.onRequest` and sends back `{ jsonrpc, id,
result }` or `{ jsonrpc, id, error }` via the abstract `sendMessage(obj)`. If no handler
is registered, responds with `MethodNotFound`.

**`failAll(err)`** rejects all in-flight pending requests (called on transport close / process
exit).

Concrete transports implement:
- `protected abstract sendMessage(obj: unknown): void | Promise<void>` — write a
  serialized JSON-RPC object to the peer.

---

## `StdioTransport` (`src/plugins/mcp/transport-stdio.ts`)

Node/Bun only. Spawns the MCP server as a child process.

### Startup (`start()`)

1. Lazy-loads `node:child_process` via `nodeChildProcess()` (browser guard).
2. On Windows: calls `windowsSpawnPlan(file, args, env, existsSync)` from
   `src/plugins/mcp/win-spawn.ts` to resolve `.cmd`/`.bat` paths and route through
   `cmd.exe` with `windowsVerbatimArguments: true`.
3. Calls `cp.spawn(file, args, { env: safeEnv() + config.env, stdio: ['pipe', 'pipe',
   'inherit'], windowsHide: true })`.
4. `safeEnv()` (module-level function) copies only essential env keys (PATH, HOME, etc.)
   — platform-branched between Windows and POSIX. Prevents leaking PYTHONHOME,
   NODE_PATH, and other version-manager vars into the child.
5. Registers `'data'` handler on `proc.stdout` for NDJSON parsing.
6. Registers `'exit'` and `'error'` handlers to call `failAll()`.

### NDJSON parsing (`onData`, `parseAndRoute`)

Accumulates chunks in `this.buffer`. Splits on `\n`, strips `\r`, skips empty lines.
Each complete line is `JSON.parse`d and dispatched to `routeIncoming`. Malformed JSON
lines are silently dropped — server stderr is inherited so diagnostics appear in the
parent's stderr.

### Shutdown (`close()`)

1. `failAll()` to reject all in-flight requests.
2. `proc.stdin.end()`.
3. Waits up to 500 ms, then sends `SIGTERM`.
4. Waits up to 2500 ms, then sends `SIGKILL`.
5. Resolves on `proc 'exit'` event.

`setProtocolVersion()` is a no-op for stdio (no per-message headers).

`sendMessage(obj)` writes `JSON.stringify(obj) + '\n'` to `proc.stdin`.

---

## `HttpTransport` (`src/plugins/mcp/transport-http.ts`)

Cross-env. Every request is a POST through `engine.fetch`. Session state is tracked via
the `mcp-session-id` response header.

### Per-request headers

```ts
private headers(): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...this.config.headers,   // consumer-supplied (Bearer, etc.)
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
  };
}
```

Auth headers from `deps.getAuthHeaders()` are merged in `authedHeaders()` on every call.

### `request(method, params)` flow

1. Build `{ jsonrpc: '2.0', id, method, params }` with a monotonic `nextHttpId`.
2. POST via `this.post(message)` — uses `engine.fetch` with
   `responseType: 'text'`, `provider: 'mcp'`, `model: config.name ?? 'server'`,
   optional `queueName`.
3. If `mcp-session-id` appears in response headers, store it for future requests.
4. On 401 with `deps.onUnauthorized`: call the hook; if it returns true, retry once
   (OAuth re-auth path).
5. On `status >= 400`: throw `McpError({ code: ConnectionClosed })`.
6. `pickResponse(contentType, text, id)` extracts the matching JSON-RPC response:
   - `text/event-stream`: split on `\r?\n\r?\n`, extract `data:` lines from each frame,
     JSON.parse each, find the response with `msg.id === id`.
   - `application/json`: parse the body as a single object or array, find by id.
7. Throw `McpError` on error field; return `msg.result`.

`notify(method, params)` POSTs without waiting for a meaningful response body.

### Server-to-client GET SSE stream (`listen()`)

Opens an `AbortController`-controlled background loop that calls `deps.fetchStream` (the
streaming-capable engine fetch) with `method: 'GET'` and `accept: text/event-stream`. If
the server returns 405 on the first attempt, the loop stops (request/response-only server
mode). On connection drops, reconnects with exponential backoff up to 5 retries. Tracks
`last-event-id` for resumption. Each SSE frame is JSON.parsed and routed via
`this.routeIncoming(msg)` (using `BaseJsonRpcTransport.routeIncoming`).

`close()` aborts the event loop and sends `DELETE {url}` with the `mcp-session-id` header
(best-effort: 405 is silently ignored).

`sendMessage(obj)` (abstract impl) POSTs the JSON-RPC object (used by `BaseJsonRpcTransport.
handleRequest` to reply to server-initiated requests).

---

## `McpClient` (`src/plugins/mcp/client.ts`)

```ts
class McpClient {
  constructor(transport: McpTransport, opts: McpClientOptions = {})

  get info(): McpInitializeResult | null  // null before connect()
  async connect(): Promise<McpInitializeResult>
  async listTools(): Promise<McpToolDef[]>
  async callTool(name: string, args?: {}, trace?: TraceContext): Promise<McpCallResult>
  // P2: listResources, readResource, subscribeResource, listPrompts, getPrompt, setLogLevel
  // P4: callToolTask, getTask, awaitTask, cancelTask
  async close(): Promise<void>
}

interface McpClientOptions {
  clientInfo?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  hooks?: HookBus; server?: string;     // for onMcpToolCall/onMcpError
  telemetry?: { hooks: HookBus; server: string };  // @deprecated
  keepAliveMs?: number;
}
```

### `connect()` lifecycle

1. `transport.setHandlers({ onRequest, onNotification })`:
   - `onRequest` → `handleServerRequest(method, params)`.
   - `onNotification` → `opts.onNotification?.(method, params)`.
2. `transport.start()`.
3. `transport.request('initialize', { protocolVersion, capabilities, clientInfo })` →
   `McpInitializeResult`. Stores in `this.serverInfo`.
4. `transport.setProtocolVersion?.(result.protocolVersion)`.
5. `transport.notify('notifications/initialized')`.
6. `transport.listen?.()`.
7. If `keepAliveMs > 0`: start `setInterval(() => transport.request('ping'))`. The timer
   is `unref()`d so it does not hold the Node/Bun process open.

### `listTools()` and pagination

`paginate<T>(method, field)` (private) follows cursor pagination:
```ts
do {
  res = await transport.request(method, cursor ? { cursor } : {});
  out.push(...res[field]);
  cursor = res.nextCursor;
} while (cursor);
```

### `callTool(name, args, trace?)`

1. Record `t0 = performance.now()`.
2. `transport.request('tools/call', { name, arguments: args })`.
3. On success: `hooks?.emitSync('onMcpToolCall', { server, tool: name, latencyMs, isError:
   res.isError ?? false, trace })`.
4. On error: `hooks?.emitSync('onMcpError', { server, phase: 'request', error, trace })`,
   then rethrow.

`trace` is the `TraceContext` from the `AgentLoop` run (sessionId + requestId + callId).
When present, `onMcpToolCall` and `onMcpError` carry the full trace so MCP tool calls
appear in telemetry correlated with the agent run that triggered them.

### Server-initiated request handling (`handleServerRequest`)

`ping` is handled internally (returns `{}`). All other methods are routed to
`opts.onServerRequest`. If no handler is registered, throws `McpError({ code:
MethodNotFound })`.

`connectMcp` wires `onServerRequest` to handle `sampling/createMessage`,
`elicitation/create`, and `roots/list` based on which `ConnectMcpOptions` are provided.

---

## Tool adapter (`src/plugins/mcp/tools.ts`)

### `mcpToolToAgentTool(client, tool, namespace, opts)`

Returns an `AgentTool`:
```ts
{
  definition: {
    type: 'function',
    name: `${namespace}__${tool.name}`,      // double-underscore namespace separator
    description: tool.description ?? tool.title ?? tool.name,
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
  },
  execute: async (args, ctx) => {
    const res = await client.callTool(tool.name, args, ctx.trace);
    // optional outputSchema validation via validateJsonSchema
    return mcpContentToResult(res);
  },
}
```

The namespaced name `<ns>__<tool>` avoids collisions across servers. `client.callTool` is
called with the un-namespaced name (what the server registered).

`ctx.trace` from `ToolExecutionContext` is threaded into `callTool` so that telemetry
hooks carry the run's `sessionId`, `requestId`, and `callId`.

If `opts.validateOutput` is true and `tool.outputSchema` is present: validate
`res.structuredContent` via `validateJsonSchema` (`src/util/json-schema.ts`); on
mismatch return an error string to the model.

### `mcpContentToResult(res)`

Maps `McpCallResult` to `string | ContentPart[]`:
- If all content is text (no media): returns joined text string. If `res.isError`, wraps
  with `"Tool error: "` prefix.
- If any block is image or audio: returns `ContentPart[]` with base64 sources.
- Unknown block types are silently dropped (null from `blockToPart`).
- `resource` blocks: if `resource.text` is set, returns text; if `resource.uri`, returns
  `"[resource {uri}]"`.
- `resource_link` blocks: returns `"[resource {uri}]"`.

### `mcpPromptToMessages(result)`

Converts `McpGetPromptResult.messages` to `Message[]` for direct injection into a request.

---

## Sampling (`src/plugins/mcp/sampling.ts`)

When the server sends `sampling/createMessage`, it asks the client to run an LLM call on
its behalf. `samplingHandler(config)` builds an `McpSamplingHandler`:

- If `config` is a function: use it directly.
- If `config` is `{ model, provider?, engine? }`: auto-wire to `complete()` from
  `src/helpers/one-shot.ts`. Maps `McpSamplingMessage[]` → `Message[]` and maps
  finish reason (`'stop'` → `'endTurn'`, `'length'` → `'maxTokens'`).

Enabled by passing `sampling: config` to `connectMcp`. The `sampling` capability is
declared in the `initialize` call when a handler is configured.

---

## OAuth 2.1 + PKCE (`src/plugins/mcp/oauth.ts`)

HTTP-only. Zero-dependency implementation of:
- Metadata discovery at `/.well-known/oauth-authorization-server` or
  `/.well-known/openid-configuration`.
- Dynamic Client Registration (RFC 7591) via `registration_endpoint`.
- Authorization code flow with PKCE (S256 code challenge via `crypto.subtle.digest`).
- CSRF state token generation and constant-time comparison (`safeEqual`).
- Token refresh via `refresh_token` grant.
- 60-second expiry buffer in `isExpired`.

All HTTP goes through `engine.fetch` on queue `'mcp/oauth'`.

```ts
class McpOAuth {
  async authorize(): Promise<'authorized' | 'redirect'>
  async authHeader(): Promise<Record<string, string>>
  async reauthorize(): Promise<boolean>  // 401 handler: refresh or redirect
  async finish(code: string, returnedState: string): Promise<void>
}
```

`McpAuthProvider` is the consumer-implemented interface for token/verifier/state storage
and user redirect. The library handles all non-interactive machinery.

`McpUnauthorizedError` is thrown by `connectMcp` when `authorize()` returns `'redirect'`
(the user must complete the browser flow). Catch it, handle the redirect, then call
`finishMcpAuth` and reconnect.

---

## SSRF guard (`src/plugins/mcp/url-guard.ts`)

`assertSafeAuthUrl(url, issuerUrl, opts)` validates any server-controlled URL before it is
fetched. Three checks:

1. **Scheme**: must be `https:`. Allow `http:` only when `opts.allowInsecureHttp === true`.
2. **Host**: must not be loopback, link-local, or private. Blocked by default; allow via
   `opts.allowLoopback`.
3. **Origin**: hostname must match `issuerUrl`'s hostname or be in `opts.allowedHosts`.
   When `allowLoopback` is true and the host is a private address, the origin check is
   skipped (explicit local-dev mode).

`parseCanonicalIpv4` (exported) handles 1-, 2-, 3-, and 4-part IPv4 literals in decimal,
octal (0-prefix), and hex (0x-prefix) — covering all forms `inet_aton` accepts. Private
range checks in `isPrivateIpv4` cover RFC-1918, loopback, link-local, CGNAT, and reserved
blocks. IPv6 private prefixes: `fc`/`fd` (ULA), `fe80` (link-local), `ff` (multicast),
and IPv4-mapped ranges.

Throws `McpSsrfError` with `url` and `reason` properties.

---

## Public API (`src/helpers/mcp.ts`)

### `connectMcp(config, opts?): Promise<McpConnection>`

```ts
type McpServerConfig = McpHttpConfig | McpStdioConfig;

interface McpHttpConfig { url: string; headers?: Record<string, string>; name?: string; }
interface McpStdioConfig { command: string; args?: string[]; env?: Record<string, string>;
  cwd?: string; name?: string; }

interface McpConnection {
  readonly serverInfo: McpInitializeResult | null;
  readonly tools: AgentTool[];    // stable array, mutated in place on refresh
  listTools(): Promise<AgentTool[]>;
  readonly client: McpClient;
  close(): Promise<void>;
}
```

Transport selection: `isHttpConfig(config)` checks for `typeof url === 'string'`. WebSocket
is detected by `/^wss?:/i.test(config.url)`. Engine is required for HTTP/WS transports
and is sourced from `opts.engine ?? coreRegistry.get()`.

The `tools` array is **stable** — the same array reference is mutated in place on tool
refresh. An `AgentLoop` holding a reference to `connection.tools` automatically sees tool
list changes after `autoRefreshTools` triggers a refresh.

**Namespace**: derived from `config.name`, URL hostname first label, or command basename
(with extension stripped). Special chars are replaced by `_` via `sanitizeNs`.

**OAuth flow** (HTTP, non-WS): `McpOAuth.authorize()` is called before `client.connect()`.
On `'redirect'` result, throws `McpUnauthorizedError`. Engine hooks receive `onMcpError`
with `phase: 'connect'`.

**Capability declaration**: `sampling`/`elicitation`/`roots` capabilities are added to
the `initialize` request only when the corresponding options are present.

**Telemetry**: emits `onMcpConnect { server, transport, serverName, serverVersion,
toolCount }` on success; `onMcpError { server, phase: 'connect', error }` on failure.

### `mcpToolset(configs, opts?)`

Calls `connectMcp` for each config in parallel, returns `{ tools, connections, close() }`.
`tools` is a flat array of all servers' tools (namespaces prevent collisions).

### `finishMcpAuth(serverUrl, code, state, opts)`

Exchanges an OAuth authorization code for tokens. Must be called after catching
`McpUnauthorizedError`. Validates `state` against the persisted value (constant-time
comparison). After this call succeeds, call `connectMcp` again.

---

## Data flow: tool call through the stack

```text
AgentLoop calls tool.execute(args, toolCtx)       [toolCtx.trace set by loop]
  -> mcpToolToAgentTool.execute(args, ctx)
     -> McpClient.callTool(tool.name, args, ctx.trace)
        -> transport.request('tools/call', { name, arguments: args })
           [StdioTransport]: write NDJSON to child stdin; await pending[id]
           [HttpTransport]:  engine.fetch POST; pickResponse from JSON/SSE body
        -> emitSync('onMcpToolCall', { server, tool, latencyMs, isError, trace })
        <- McpCallResult
     -> mcpContentToResult(res)          [map blocks -> string | ContentPart[]]
  <- tool result string or ContentPart[] returned to AgentLoop
  -> AgentLoop appends tool_result message, continues loop
```

---

## Extension points

**Custom transport**: implement `McpTransport` (extend `BaseJsonRpcTransport` for free
pending-map, routing, and timeout logic). Pass to `new McpClient(transport, opts)`.

**Custom tool adapter**: call `mcpToolToAgentTool` directly with a custom `McpClient` and
`McpToolDef`. Pass `validateOutput: true` to enforce `outputSchema` validation.

**Sampling**: implement `McpSamplingHandler` or pass `{ model: 'provider/model' }` to
auto-wire. Handler receives the full `McpCreateMessageParams` including `modelPreferences`.

**OAuth**: implement `McpAuthProvider` for custom token/verifier storage and redirect
mechanism.

---

## Gotchas and edge cases

- `StdioTransport` is browser-guarded via the lazy `nodeChildProcess()` loader. Calling
  `connectMcp({ command: '...' })` in a browser throws at `start()` time with a clear
  error. Check `isHttpConfig(config)` before calling in cross-env code.
- `HttpTransport` request IDs (`nextHttpId`) are separate from `BaseJsonRpcTransport`'s
  `nextId`. Only `nextHttpId` is used for HTTP requests; `nextId` would be used by
  server-initiated response correlation in `sendMessage`. Do not conflate the two counters.
- `HttpTransport.listen()` runs in the background and is not awaited by `McpClient.
  connect()`. Errors in the event loop are swallowed (the loop reconnects). To detect
  persistent GET stream failures, subscribe to `onMcpError` hooks.
- The `tools` array returned by `connectMcp` is mutated in place on `listTools()` and on
  `autoRefreshTools` notification. Code that copies `connection.tools` to a local variable
  at connect time will NOT see updates. Always use the `connection.tools` reference
  directly.
- `McpClient.connect()` does not retry. A transport-level failure during `initialize`
  throws and the connection is left in an unusable state. Call `close()` and reconnect.
- `McpOAuth.finish()` validates the returned state with `safeEqual` (constant-time). If
  the `McpAuthProvider` does not persist the state between redirect and callback (e.g. on
  a page reload), `provider.state()` returns `undefined` and `finish` throws.
- `assertSafeAuthUrl` uses hostname-exact comparison for origin checks (not same-site/
  public-suffix matching). An MCP server at `api.example.com` whose auth server is at
  `auth.example.com` requires `allowedHosts: ['auth.example.com']` in `security` options.
- `callTool` is called with the un-namespaced tool name. The namespace prefix is only in
  the `AgentTool.definition.name` seen by the model. If you call `client.callTool` directly
  (bypassing the adapter), pass the raw server tool name, not the namespaced one.
- `keepAliveMs` timer is `unref()`d when the runtime supports it. On runtimes that do not
  expose `unref` (e.g. non-Bun/Node environments), the timer fires normally and is
  silently ignored on error.
