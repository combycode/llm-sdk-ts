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
| `connectMcp(config, opts?)` | Connect to one MCP server (HTTP or stdio). Returns a `McpConnection` with `.tools` (array of `AgentTool`), `.listTools()`, `.callTool()`, `.close()`. |
| `mcpToolset(configs, opts?)` | Connect to multiple MCP servers at once. Returns a combined `McpConnection` (merged tools from all servers). |
| `finishMcpAuth(url, opts?)` | Complete an OAuth 2.1 / PKCE authorization flow for an authenticated MCP server. Call after the user is redirected back. |
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

```ts
import { connectMcp, finishMcpAuth } from '@combycode/llm-sdk';

// Step 1: attempt to connect; catch McpUnauthorizedError to get the auth URL.
import { McpUnauthorizedError } from '@combycode/llm-sdk';

try {
  const mcp = await connectMcp({ url: 'https://secure-mcp-server.example.com/mcp', name: 'secure' });
  // use mcp.tools ...
  await mcp.close();
} catch (err) {
  if (err instanceof McpUnauthorizedError) {
    // Redirect the user to err.authorizationUrl, then after redirect:
    const mcp = await finishMcpAuth(err.authorizationUrl, {
      code: 'OAUTH_CODE_FROM_REDIRECT',
      state: 'STATE_FROM_REDIRECT',
    });
    // now mcp is connected and authorized
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
