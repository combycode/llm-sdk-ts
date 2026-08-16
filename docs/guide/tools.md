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

### Strict mode and optional parameters

Strict mode makes a provider constrain the tool name and argument shape while generating
them, instead of leaving you to validate afterwards.

**It is opt-in** (`strict: true` on a `FunctionTool`) everywhere except the OpenAI
Responses API, where it has long been the default. Measured against both providers it
makes no difference to argument quality -- 40 of 40 calls conformed with it and without
it, including prompts written to pull away from the schema -- while a schema the provider
dislikes is rejected with a 400 rather than degraded. Its one real effect is that
Anthropic refuses to call a tool that was never declared (10/10 undeclared without it,
0/10 with it), which only matters if something puts an undeclared tool in front of the
model.

When you do ask for it, the schema must satisfy that provider's rules, and the two
constrain different things:

| | OpenAI | Anthropic |
|---|---|---|
| optional properties (not in `required`) | rejected | fine |
| `maximum`, `minimum`, `multipleOf`, `maxItems`, `exclusive*` | fine | rejected |
| `additionalProperties: true` (an open object) | rejected | rejected |
| `{ type: 'object' }` with no `properties` key | rejected | fine |
| more than 20 strict tools in one request | fine | rejected |
| more than 24 optional parameters across all strict schemas | fine | rejected |
| "too complex to compile" (no published formula) | -- | rejected |

On the Responses API, where strict is the default, it is requested only for schemas that
satisfy OpenAI's rules -- so a tool with an optional parameter simply runs without it
rather than failing. `strictSupport(schema, 'openai' | 'anthropic')` is exported if you
want to ask the question yourself; it returns `{ ok, reason }`, and `reason` names the
property or keyword responsible.

Anthropic's last three rows are why strict is not defaulted on there. Two are aggregates
over the whole request, so no per-schema check can see them, and the third has no
published formula at all: 24 optional parameters spread over four tools compiles, the
same 24 in one tool does not. Twelve ordinary tools with five optional parameters each
already exceed the 24 limit. Non-strict tools count toward none of the limits.

One consequence worth knowing: **a generic "router" tool can never be strict.** If a
parameter must accept any shape (`{ type: 'object', additionalProperties: true }`), that
is the opposite of what strict means, and both providers refuse it.

A tool taking no arguments is unaffected: `properties: {}` is present but empty, which
both providers accept.

Keys listed in `optional` are optional in the inferred `execute` args too, so `unit`
above is `string | undefined` and the `?? 'celsius'` is load-bearing. Anthropic keeps
that working under strict: asked not to specify a unit it omitted the argument 10/10,
asked for fahrenheit it supplied it 10/10, and never invented the second optional one.

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

## Attaching out-of-band data — `customDataExtractor`

An `AgentTool` may declare an optional `customDataExtractor(result, args, context)` that runs
after a successful `execute`. Its return value is attached to that tool call's
`ToolCallReport.customData` — for your own telemetry, routing, or audit. **The model never sees
it** (it is not part of the tool result). A throwing extractor is swallowed, so this convenience
can never break the tool result.

```ts
const lookup: AgentTool = {
  definition: { name: 'lookup', description: 'Look up a record', parameters: { id: { type: 'string' } } },
  execute: async ({ id }) => fetchRecord(id),
  // model never sees this — it lands on the ToolCallReport.
  customDataExtractor: (result, args, ctx) => ({ bytes: String(result).length, callId: ctx.callId }),
};
```

## Built-in / hosted tools

Server-side tools the provider runs are passed as plain objects in `tools: [...]`
(no `defineTool`): `{ type: 'web_search' }`, `{ type: 'web_fetch' }`,
`{ type: 'code_interpreter' }`, `{ type: 'image_generation' }`, `{ type: 'file_search' }`,
and `{ type: 'mcp' }`. Provider-specific configuration goes in `params`, forwarded verbatim
(e.g. `{ type: 'web_fetch', params: { allowed_domains: ['docs.example'], max_content_tokens: 4096 } }`).

**Programmatic tool calling (OpenAI Responses, `gpt-5.6` family).** Add
`{ type: 'programmatic_tool_calling' }` to let the model write JS that orchestrates your tool calls.
Function tools can then declare who may invoke them and the shape they return:
`allowedCallers?: ('direct' | 'programmatic')[]` and `outputSchema?` on a `FunctionTool`. Both are
emitted only on the OpenAI Responses path (other providers ignore them). Model-gated — of the
gpt-5 / o3 / o4 / codex models tested, only `gpt-5.6-luna` / `-sol` / `-terra` accept the builtin;
the rest reject it by name.

The model's program arrives as a `program_call` content part and its return value as
`program_result`. The tool calls the program makes are ordinary `tool_call` parts — you execute them
exactly as before — each carrying `caller: { type: 'program', callerId }` pointing back at the
program that made it:

```ts
const res = await client.complete(messages, {
  tools: [
    { type: 'programmatic_tool_calling' },
    { ...getWeather, allowedCallers: ['programmatic'] },
  ],
});

for (const part of res.content) {
  if (part.type === 'program_call') console.log('model wrote:', part.code);
  if (part.type === 'program_result') console.log('program returned:', part.result);
}
for (const call of res.toolCalls) {
  console.log(call.name, call.caller?.type ?? 'direct'); // -> get_weather program
}
```

The program suspends at each `await`, so its calls still arrive one turn at a time; answer them the
usual way and the program resumes.

**Keep the `program_call` part in your history and send it back.** Dropping it is not just a lost
audit trail — the model re-emits the program and runs the whole thing again from the start. The
adapter also re-sends the provider items the program is bound to, which the API requires.

`allowedCallers` is enforced locally as well as by the provider: **a tool without it is
`direct`-only**, so model-written code cannot reach a tool that never opted in. A violation denies
that single call (an error result to the model, plus an `onWarning` with code
`tool_caller_not_allowed`) instead of ending the run.

Files a hosted tool produces (e.g. code-execution charts or data files) are surfaced
uniformly on `response.files` (`FileOutput[]` — `{ id?, name?, mimeType?, data?, url?, ref?, source? }`),
independent of generated `media`. You don't fetch per-provider — `retrieveFile(file)` /
`streamFile(file)` resolve every shape (id via the provider's files API, inline base64 `data` from
Google/xAI, or a `url`). See the [Code execution guide](./code-execution.md) and
[Retrieving output files](./retrieving-files.md).

Which models support which builtin is in the catalog: `capabilities.builtinTools`,
`catalog.supportsBuiltinTool(provider, model, tool)`, or `select('code_interpreter')`. Coverage:
`web_search` on all providers; `code_interpreter` on all except OpenRouter; `web_fetch` on
Anthropic (`web_fetch_20260318`) and Google (`urlContext`) — OpenAI's `web_search` already
opens pages, and xAI / OpenRouter expose no separate fetch tool.

**Seeing what ran.** Provider-run builtins surface a durable trail on
`response.builtinToolCalls` and, while streaming, `{ type: 'builtin_tool_start' }` /
`{ type: 'builtin_tool_end' }` events as each runs. Each entry carries **what the tool ran**:

```ts
interface BuiltinToolCall {
  tool: string;      // 'web_search' | 'web_fetch' | 'code_interpreter'
  id?: string;
  code?: string;     // code_interpreter: the code the model executed
  output?: string;   // code_interpreter: the code's stdout / logs
  query?: string;    // web_search: the query the model searched for
  url?: string;      // web_search: a page opened/read; web_fetch: the URL fetched
}
```

The payload is normalized across providers and present on both `complete()` and streamed responses
(the `builtin_tool_end` event carries the same fields). These are **informational** — unlike
`tool_call_*` (a function call the client must execute), the provider runs these itself. Use them
to show a "🔎 Searching: <query>" / "⚙️ Running code" panel with the actual code and output.

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

## Lazy tools -- register without declaring

Tool definitions are sent in full on every request. Three MCP servers and the tool block
can dominate the context before the conversation starts.

Mark a tool `lazy` and it is registered but **not declared**. The model finds it with a
built-in `tool_search`, which returns full schemas, and runs it through a built-in
`call_tool`:

```ts
import { connectMcp, createAgent } from '@combycode/llm-sdk';

// The common case: an entire MCP server, deferred.
const gh = await connectMcp({ url: 'https://example.com/mcp' }, { lazy: true });

const agent = createAgent({
  model: 'anthropic/claude-haiku-4.5',
  tools: gh.tools,
  lazyTools: { limit: 5, maxSearches: 5 }, // both optional
});
```

`tool_search` and `call_tool` are declared only when at least one lazy tool exists, so an
app that never opts in never sees them.

Per tool instead of per server:

```ts
import { defineTool } from '@combycode/llm-sdk';

defineTool({
  name: 'rare_thing',
  description: 'Something needed once in a hundred runs.',
  params: { id: 'string' },
  lazy: true,
  execute: ({ id }) => id,
});
```

**What it costs and what it saves.** Measured over 308 tools, six tasks, both providers:
identical correctness, **-72%** cost per task on `claude-haiku-4.5` and **-97%** on
`gpt-5.4-nano`, for **one extra round trip** (the search). The saving comes from the tool
block never being sent -- not from caching, which this design does not even rely on.

**It is not always a win.** Below roughly a hundred richly-schema'd tools it costs *more*
than declaring everything, because what remains in the prefix falls under the provider's
minimum cacheable size while a search round trip is still paid. There is deliberately no
automatic threshold: whether deferring pays depends on the size of your schemas, not their
count. Mark tools lazy on purpose.

**Nothing moves mid-run.** Registration, namespacing and `toolNameCollisionPolicy` are
unchanged, and the declared tool array is identical on every request of a conversation --
which is the point, since changing it would invalidate the cached prefix and cost more
than it saves.

### Watching it work

`ToolCallReport.toolName` names the tool that actually **ran**, not `call_tool`, and adds
`discoveredVia: 'search'`. Without that unwrapping every lazy call would look identical in
a trace.

```ts
agent.hooks.on('onToolSearch', ({ queries, matched, unmatched }) => {
  if (unmatched.length) console.warn('no tool matched:', unmatched);
});
```

`unmatched` is the field worth watching. Ranking is local token overlap over name,
description and parameter names -- it has no idea that "coughed up" means "payment
status", and against raw user phrasing it finds nothing at all. That is survivable because
the **model** writes the query, not the user, and it rewrites well. When a query does miss,
`tool_search` says so and the model searches again with different words; without that
signal a request needing two tools quietly becomes an answer from one.

## Related

- [Agent Loop + delegate / chain / consolidate](./agent-loop.md)
- [LLM Client + complete/stream](./llm-client.md)
- [MCP (Model Context Protocol)](./mcp.md)
- [Permissions](./context-guard.md)
