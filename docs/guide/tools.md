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
  model: 'anthropic/claude-haiku-4-5',
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

## Related

- [Agent Loop + delegate / chain / consolidate](./agent-loop.md)
- [LLM Client + complete/stream](./llm-client.md)
- [MCP (Model Context Protocol)](./mcp.md)
- [Permissions](./context-guard.md)
