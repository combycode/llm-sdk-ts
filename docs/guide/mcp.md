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
