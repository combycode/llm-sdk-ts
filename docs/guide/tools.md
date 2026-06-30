# Tools -- defineTool

`defineTool` is the ergonomic builder for function tools. It infers TypeScript
types from a compact `params` spec so you get typed `args` in `execute` without
writing a JSON schema by hand.

## When to reach for this

- You want to give the model a callable function (weather lookup, database query,
  API call, file read, etc.).
- You want TypeScript inference on the tool's argument types.

For built-in server-side tools (web search, code interpreter) pass them as plain
objects -- `{ type: 'web_search' }` -- directly in `tools: [...]`; no `defineTool`
needed for those.

## Main exports

| Export | What it does |
|---|---|
| `defineTool(input)` | Build an `AgentTool` from a name, description, param spec, and execute function. |
| `AgentTool` (type) | The shape expected by `complete()`, `createAgent()`, and `delegate()`. |
| `ParamSpec` (type) | Allowed param spec values: `'string'`, `'number'`, `'boolean'`, `'string[]'`, `'number[]'`, or an inline schema object. |

## Minimal example

```ts
import { complete, defineTool } from '@combycode/llm-sdk';

const getWeather = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  params: {
    city: 'string',
    unit: { type: 'string', enum: ['celsius', 'fahrenheit'] as const },
  },
  optional: ['unit'],
  execute: ({ city, unit }) => {
    // Return value is a string (or ContentPart[]) handed back to the model.
    return `It is sunny in ${city} (${unit ?? 'celsius'}).`;
  },
});

const { text } = await complete({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  prompt: 'What is the weather in Paris?',
  tools: [getWeather],
  maxTokens: 128,
});
console.log(text);
```

### Multi-step tool loop

`complete()` runs the full loop until the model stops requesting tools:

```ts
import { complete, defineTool } from '@combycode/llm-sdk';

const getUserCity = defineTool({
  name: 'get_user_city',
  description: "Get the user's current city.",
  params: {},
  execute: () => 'Paris',
});
const getWeather = defineTool({
  name: 'get_weather',
  description: 'Get the weather for a city.',
  params: { city: 'string' },
  execute: ({ city }) => `sunny in ${city}`,
});

const { text } = await complete({
  model: process.env.LLM_MODEL!,
  apiKey: process.env.LLM_API_KEY,
  prompt: 'What is the weather where I am?',
  tools: [getUserCity, getWeather],
  maxTokens: 512,
});
console.log(text);
```

### Using the tool execution context

`execute` receives a second `ToolExecutionContext` argument with run trace ids and
call metadata. Useful for logging, correlation, or accessing the agent's conversation
history.

`ctx.trace` carries three ids:
- `sessionId` -- the agent id (the ConversationHistory id, same as `loop.id`)
- `requestId` -- the run id for this specific `.complete()` / `.stream()` invocation
- `callId` -- this tool call's id (same as `ctx.callId`)

```ts
import { defineTool } from '@combycode/llm-sdk';
import type { ToolExecutionContext } from '@combycode/llm-sdk';

const loggedTool = defineTool({
  name: 'read_db',
  description: 'Read a row from the database.',
  params: { id: 'string' },
  execute: async ({ id }, ctx: ToolExecutionContext) => {
    console.log(
      `Tool call ${ctx.callId} | agent ${ctx.trace?.sessionId} | run ${ctx.trace?.requestId}`,
    );
    return `row data for ${id}`;
  },
});
```

## Built-in / hosted tools

Server-side tools the provider runs are passed as plain objects in `tools: [...]`
(no `defineTool`): `{ type: 'web_search' }`, `{ type: 'code_interpreter' }`,
`{ type: 'image_generation' }`, `{ type: 'file_search' }`, and `{ type: 'mcp' }`.
Provider-specific configuration goes in `params`, forwarded verbatim.

Files a hosted tool produces (e.g. code-execution charts or data files) are surfaced
uniformly on `response.files` (`FileOutput[]` — `{ id?, name?, mimeType?, data?, source? }`),
independent of generated `media`. When only `id` is set, fetch the bytes via the provider's
files API.

### Hosted MCP tool (`{ type: 'mcp' }`)

OpenAI's hosted MCP tool lets the model call a remote MCP server that **OpenAI**
connects to. Identify the server with **exactly one** of three targets (use the
exported `McpToolParams` type for editor help):

```ts
import type { McpToolParams } from '@combycode/llm-sdk';

// 1. Public server — OpenAI dials the URL directly.
{ type: 'mcp', params: { server_label: 'docs', server_url: 'https://mcp.example/sse' } }

// 2. Managed connector (Gmail, Drive, …).
{ type: 'mcp', params: { server_label: 'gmail', connector_id: 'connector_gmail' } }

// 3. Secure MCP Tunnel — reach a private/local server (behind NAT/firewall, no
//    public URL) through an outbound tunnel registered under a tunnel id.
{ type: 'mcp', params: { server_label: 'local', tunnel_id: 'tnl_abc123' } }
```

Optional `params`: `authorization`, `headers`, `require_approval`, `allowed_tools`,
`server_description`. OpenAI enforces the "exactly one target" rule server-side.

> This is the **provider-hosted** MCP path. For connecting the SDK itself to MCP
> servers as a client, see [MCP (Model Context Protocol)](./mcp.md).

## Related

- [Agent Loop + delegate / chain / consolidate](./agent-loop.md)
- [LLM Client + complete/stream](./llm-client.md)
- [MCP (Model Context Protocol)](./mcp.md)
- [Permissions](./context-guard.md)
