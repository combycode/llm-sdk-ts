# MCP (Model Context Protocol) -- connectMcp / mcpToolset / finishMcpAuth

The MCP client connects to external MCP servers over stdio (Node/Bun) or HTTP,
lists their tools, and exposes each as a normal `AgentTool`. The model calls them
like any function tool; the SDK executes them through the `tools/call` protocol.
Works identically across all five providers -- the model never sees provider-specific
MCP surfaces.

## When to reach for this

- You want to give an agent access to tools served by an MCP server (local or
  remote).
- You want to use a public MCP server (e.g. DeepWiki) from any provider.
- You need a local stdio server for private/on-premises tools that hosted
  providers cannot reach.

## Main exports

| Export | What it does |
|---|---|
| `connectMcp(config, opts?)` | Connect to one MCP server (HTTP or stdio). Returns a `McpConnection` with `.tools` (array of `AgentTool`), `.serverInfo`, `.listTools()`, `.client` (low-level `McpClient`), `.close()`. |
| `mcpToolset(configs, opts?)` | Connect to multiple MCP servers at once. Returns `{ tools, connections, close() }` with the merged tool list from all servers. |
| `finishMcpAuth(serverUrl, code, state, { auth, engine?, security? })` | Complete an OAuth 2.1 / PKCE authorization flow. Positional `code` and `state` come from the redirect callback; `auth` (an `McpAuthProvider`) is required. Returns `Promise<void>`. Reconnect via `connectMcp` afterwards. |
| `McpClient` | Low-level client class (initialize/listTools/callTool/close). Use `connectMcp` instead for normal use. |
| `McpError` / `McpErrorCode` | Error class and error codes from JSON-RPC layer. |
| `McpOAuth` and related | OAuth helpers: `buildAuthorizationUrl`, `discoverMetadata`, `exchangeCode`, `generatePkce`, `refreshTokens`, `registerClient`. |
| `WsTransport` | WebSocket MCP transport (advanced/custom wiring). |

Type-only exports: `ConnectMcpOptions`, `McpConnection`, `McpServerConfig`,
`McpToolDef`, `McpCallResult`, `McpOAuthTokens`, `McpSamplingConfig`, and related.

## Two protocol eras, both supported

MCP `2026-07-28` is not an additive revision. It **removes** the `initialize` handshake, the session
id, and the entire server-to-client back-channel, replacing them with a single `server/discover`
probe and per-request `_meta` identity. Almost every server in the wild still speaks `2025-11-25`.

> **Tested against the real thing.** Everything below was run end to end against the official
> `mcp` 2.0.0 Python server over **stdio, Streamable HTTP and WebSocket**, and against a real
> `2025-11-25` server for the fallback — not only against our own test doubles.

So this client speaks **both**, and prefers neither:

- On connect it probes `server/discover`. If that succeeds the session is **modern**
  (`2026-07-28`); if the server rejects it, the client falls back to the `initialize` handshake and
  the session is **handshake-era** (`2025-11-25`). Servers that reject `server/discover` in a way we
  have not seen are remembered so the probe is not repeated needlessly.
- Everything the new revision removed — `ping` keep-alive, `logging/setLevel`,
  `resources/subscribe`, push sampling / roots / elicitation — **still works unchanged** on a
  handshake-era session, and is simply not sent on a modern one.
- Nothing was removed from this library. An upstream deletion is not our deletion.

```ts
import { connectMcp, mcpEraOf } from '@combycode/llm-sdk';

const mcp = await connectMcp({ url: 'https://example.com/mcp' });
console.log(mcp.client.protocolVersion);          // '2025-11-25' | '2026-07-28'
console.log(mcpEraOf(mcp.client.protocolVersion)); // 'handshake' | 'modern'
```

Version constants are exported (`MCP_KNOWN_PROTOCOL_VERSIONS`,
`MCP_HANDSHAKE_PROTOCOL_VERSIONS`, `MCP_MODERN_PROTOCOL_VERSIONS`, `MCP_LATEST_HANDSHAKE_VERSION`,
`MCP_LATEST_MODERN_VERSION`) with the guards `isHandshakeMcpVersion` / `isModernMcpVersion`.
**Versions are an enumerated set, not an ordered scalar** — compare with the guards, never with `<`.

### "The server needs more input" — one primitive, both eras

At `2026-07-28` a server no longer *pushes* a sampling or elicitation request at you. Instead the
tool call **returns** with `status: 'input_required'` and a sealed `requestState`, and you retry the
same call carrying the answers. That is a completely different mechanism from the legacy
back-channel — but it exists to do the same job, so it is exposed as one thing.

Your existing sampling / elicitation callbacks are used for both. `callTool` drives the exchange to
a terminal result on either era; you do not branch on the protocol version:

```ts
const result = await mcp.client.callTool('search', { q: 'mcp' });
// Already terminal. On a modern session any input_required round-trips happened inside.
```

The result type did not become a union (that would break every caller). `CallToolResult` grew
optional `status` / `inputRequests` / `requestState` fields instead, so code that reads `.content`
is untouched.

Declare the handler you already use and the capability goes out with it:

```ts
const mcp = await connectMcp(config, {
  elicit: async ({ message }) => ({ action: 'accept', content: { name: 'Alex' } }),
});
await mcp.client.callTool('greet', {});   // -> "hello Alex", one terminal result
```

Verified end to end on all three transports: the server returns `input_required`, the client answers
from `elicit`, retries with the sealed `requestState`, and the caller only ever sees the finished
result.

### Change notifications: `subscriptions/listen`

At `2026-07-28`, `resources/subscribe` and the standalone SSE GET stream are replaced by one
`subscriptions/listen` call where the client names the notification kinds it wants and the server
answers with the subset it will actually deliver:

```ts
const sub = await mcp.client.listen(
  { toolsListChanged: true, resourceSubscriptions: ['mem://note'] },
  (event) => console.log(event.type, event),   // 'tools_list_changed' | 'resource_updated' | …
);

// The acknowledgement arrives as a notification, so `honored` fills in a moment later.
console.log(sub.honored);            // what the server AGREED to send
console.log(sub.isHonored('toolsListChanged'));
await sub.close();
```

`honored` matters: a server may accept the call and quietly deliver only some kinds. Reading it is
the difference between "no events yet" and "this event is never coming". It stays `null` until the
server's `notifications/subscriptions/acknowledged` arrives.

The filter is **camelCase on the wire** (`toolsListChanged`, `resourceSubscriptions`) — that is the
spec's own serialisation, confirmed against the reference server, even though the Python attribute
names are snake_case.

`listen()` works on **every** transport — stdio and WebSocket (naturally duplex), and Streamable
HTTP (via a long-lived streaming POST). All three are verified against the reference server. On a
handshake-era session, `resources/subscribe` keeps working exactly as before.

### Result caching from server hints

List/read results may carry `ttlMs` and `cacheScope` hints. Caching is **opt-in** and does nothing
for servers that send no hints:

```ts
const mcp = await connectMcp({ url }, { cacheResults: true });
await mcp.client.listTools();   // second call inside ttlMs is served from cache
```

Entries are invalidated automatically by the matching `*_changed` notification, so a cached tool
list cannot go stale behind your back. `mcp.client.invalidateCache()` drops them by hand when you
know the server moved before it says so.

Measured against the reference server by counting wire frames (timing is not a reliable oracle over
a local pipe): with hints and `cacheResults`, three `listTools()` calls produce **one** request;
without hints, or with caching off, all three reach the wire.

`connectMcp` also takes `inputRequiredMaxRounds` — the cap on MRTR retry rounds before it gives up
(default 10).

### stdio buffer bound

The stdio transport's read buffer is bounded (`maxBufferSize`, default **10 MB**). A server that
streams without ever emitting a newline used to grow that buffer without limit; it now fails the
transport with a clear error instead of consuming memory until the process dies.

## Minimal examples

### HTTP MCP server (cross-env, including browser)

```ts
import { complete, connectMcp, createEngine } from '@combycode/llm-sdk';

// A bare engine carries the network layer for MCP HTTP calls.
const engine = createEngine();

const mcp = await connectMcp(
  { url: 'https://mcp.deepwiki.com/mcp', name: 'deepwiki' },
  { engine },
);

const { text } = await complete({
  model: process.env.LLM_MODEL!,
  apiKey: process.env.LLM_API_KEY,
  prompt: 'What transport protocols does the MCP TypeScript SDK support? Use the DeepWiki server.',
  tools: mcp.tools, // AgentTool[] from the MCP server
  maxTokens: 1024,
});

await mcp.close();
console.log(text);
```

### Stdio MCP server (Node/Bun only)

```ts
import { connectMcp } from '@combycode/llm-sdk';

const mcp = await connectMcp({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  name: 'filesystem',
});

console.log('Available tools:', mcp.tools.map((t) => t.definition.name));
await mcp.close();
```

### Multiple servers at once

```ts
import { mcpToolset, complete } from '@combycode/llm-sdk';

const toolset = await mcpToolset([
  { url: 'https://mcp.deepwiki.com/mcp', name: 'deepwiki' },
  { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], name: 'fs' },
]);

const { text } = await complete({
  model: process.env.LLM_MODEL!,
  apiKey: process.env.LLM_API_KEY,
  prompt: 'List the files in /tmp and tell me about MCP.',
  tools: toolset.tools,
  maxTokens: 512,
});

await toolset.close();
console.log(text);
```

### Authenticated MCP server (OAuth 2.1 + PKCE)

`McpUnauthorizedError` carries no `authorizationUrl` property. When `connectMcp`
detects that authorization is required it calls `auth.redirectToAuthorization(url)`
on the provider you supplied -- the URL is delivered through that callback, not via
the error. After the user completes the redirect flow, call `finishMcpAuth` with the
`code` and `state` from the callback URL, then call `connectMcp` again.

`connectMcp` only throws `McpUnauthorizedError` when you pass an `auth` provider;
without one it will throw a generic connection error instead.

```ts
import { connectMcp, finishMcpAuth, McpUnauthorizedError } from '@combycode/llm-sdk';
import type { McpAuthProvider } from '@combycode/llm-sdk';

// Implement McpAuthProvider to store tokens and handle the browser redirect.
// McpAuthProvider requires a `redirectUrl` field plus storage callbacks.
const provider: McpAuthProvider = {
  redirectUrl: 'https://your-app.example.com/oauth/callback',
  clientMetadata: {
    redirect_uris: ['https://your-app.example.com/oauth/callback'],
    client_name: 'My App',
  },
  // ... implement tokens(), saveTokens(), clientInformation(), etc.
  async redirectToAuthorization(url) {
    // The authorization URL is delivered here -- redirect the user to it.
    console.log('Redirect user to:', url);
  },
  // minimal stubs for the example:
  async clientInformation() { return undefined; },
  async tokens() { return undefined; },
  async saveTokens() {},
  async saveCodeVerifier() {},
  async codeVerifier() { return ''; },
  async saveState() {},
  async state() { return undefined; },
};

// Step 1: attempt to connect with the auth provider.
try {
  const mcp = await connectMcp(
    { url: 'https://secure-mcp-server.example.com/mcp', name: 'secure' },
    { auth: provider },
  );
  // use mcp.tools ...
  await mcp.close();
} catch (err) {
  if (err instanceof McpUnauthorizedError) {
    // The auth provider's redirectToAuthorization() was already called.
    // After the user completes the OAuth flow your callback receives code + state:
    const code = 'OAUTH_CODE_FROM_REDIRECT';
    const state = 'STATE_FROM_REDIRECT';

    // Step 2: exchange the code for tokens (saved via the provider).
    await finishMcpAuth('https://secure-mcp-server.example.com/mcp', code, state, {
      auth: provider,
    });

    // Step 3: reconnect -- tokens are now stored in the provider.
    const mcp = await connectMcp(
      { url: 'https://secure-mcp-server.example.com/mcp', name: 'secure' },
      { auth: provider },
    );
    // use mcp.tools ...
    await mcp.close();
  }
}
```

For full MCP design notes see [docs/design/mcp.md](../design/mcp.md).

## Observability hooks

Three hooks fire around MCP lifecycle events:

| Hook | When | `trace` available? |
|---|---|---|
| `onMcpConnect` | Server connected and initialized | No (connection setup has no run context) |
| `onMcpToolCall` | `tools/call` completed (success or `isError`) | Yes, when called through an `AgentLoop` run |
| `onMcpError` | `tools/call` threw a JSON-RPC error | Yes, same as `onMcpToolCall` |

When an MCP tool is invoked via `AgentLoop`, `onMcpToolCall` and `onMcpError` carry
`trace.sessionId` (the agent/conversation id) and `trace.requestId` (the run id for
that `.complete()`/`.stream()` call). This lets you stitch MCP tool activity to the
agent run in your observability pipeline.

```ts
engine.hooks.on('onMcpToolCall', (ctx) => {
  // ctx.trace is set when the call came from an AgentLoop run
  if (ctx.trace) {
    console.log(`MCP tool ${ctx.tool} in run ${ctx.trace.requestId} of session ${ctx.trace.sessionId}`);
  }
});
```

`onMcpConnect` fires at connection time when no run context is available, so `trace`
is always omitted there.

## Related

- [Tools (defineTool)](./tools.md)
- [Agent Loop + delegate / chain / consolidate](./agent-loop.md)
- [Network Engine](./network.md)
