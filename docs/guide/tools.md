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

## Returning an image (or a PDF, or audio) from a tool

`execute` may return `ContentPart[]` instead of a string, and media in it is sent to the model **as
media**. A screenshot tool, a chart renderer, a "fetch this page as a PDF" tool: the model sees the
picture rather than a description of one.

```ts
const screenshot = defineTool({
  name: 'take_screenshot',
  description: 'Take a screenshot of the current screen.',
  params: {},
  execute: async () => [
    { type: 'text', text: 'screenshot taken' },
    { type: 'image', source: { type: 'base64', mimeType: 'image/png', data: await grabPng() } },
  ],
});
```

Each API has its own place for this and they disagree about where, so the SDK splits the result into
its text half and its media half and puts each where that provider takes it:

| API | media travels as |
| --- | --- |
| Anthropic Messages | blocks inside `tool_result.content` |
| OpenAI Responses | items inside `function_call_output.output` |
| Google `generateContent` | `functionResponse.parts[].inlineData` |
| OpenAI Chat Completions | its own user message, right after the tool results — the API has no slot |
| Google Interactions | its own `user_input` item, for the same reason |

Verified live on 2026-09-30 against `claude-haiku-4.5`, `gpt-5.4-nano` (Responses **and**
Completions), `gemini-3.1-flash-lite` (generateContent **and** Interactions) and `grok-4.3`: a tool
returned a solid-colour square, and every model named the colour — which it can only do by decoding
the image.

A **string** result is unchanged on every backend, so this costs nothing when a tool returns text.

Two edges worth knowing:

- Anthropic has no `tool_result` block for **audio or video**, so those render as an
  `[unsupported: …]` note. Google's `functionResponse` takes **inline bytes only** (`fileData` there
  is documented Vertex-only), so a URL-sourced image leaves an `[image omitted: …]` line in the
  result text. Both say so rather than dropping the part.
- A content-part result containing only text now sends **the text**. It used to send the part
  wrapper as JSON — `[{"type":"text","text":"a"}]` to a model that only wanted `a`.

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

**Sources a hosted search cited** are on `response.citations` (`Citation[]` -- `{ url, title?,
text? }`), unified across the four ways providers report them: Anthropic on the text block (the only
one that also gives the cited passage, as `text`), Google in `groundingMetadata`, OpenAI Responses
and Chat as `url_citation` annotations, xAI as bare top-level URLs. It is distinct from
`builtinToolCalls`, which records what the model *invoked* -- a turn can run three searches and cite
one page. Optional, so read it as `response.citations ?? []`; through an agent run the sources
accumulate across every step and are deduped by URL. Google's Interactions surface is not mapped yet
and always reports none.

Note that Google reports each source as a `vertexaisearch.cloud.google.com/grounding-api-redirect/…`
URL rather than the page itself -- that is what the provider returns, and it redirects to the real
source. The other four report the page URL directly.

**Streaming reports them as they arrive.** `stream()` yields a `citation` event per source, and the
same sources land on the streamed final response's `citations`, so the two call styles agree:

```ts
for await (const ev of llm.stream(messages, { tools: [{ type: 'web_search' }] })) {
  if (ev.type === 'text') process.stdout.write(ev.text);
  if (ev.type === 'citation') footnotes.push(ev.citation);
}
```

A citation arrives when the model cites it, which is *not* when the search ran -- providers search
early and cite while writing, so `citation` events interleave with `text`. Raw events are passed
through exactly as the provider sent them, repeats included (Google resends its grounding chunks);
deduplication by URL happens where the final response is assembled, so a consumer rendering live
footnotes still sees everything that arrived.

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
  sources?: string[];          // web_search: the URLs the search drew on
  results?: Array<{            // web_search: the results, when asked for
    imageUrl?: string;
    sourceWebsiteUrl?: string;
    thumbnailUrl?: string;
    caption?: string;
    [key: string]: unknown;    // whatever else the provider sent
  }>;
}
```

The payload is normalized across providers and present on both `complete()` and streamed responses
(the `builtin_tool_end` event carries the same fields). These are **informational** — unlike
`tool_call_*` (a function call the client must execute), the provider runs these itself. Use them
to show a "🔎 Searching: <query>" / "⚙️ Running code" panel with the actual code and output.

### Image results from `web_search` (OpenAI)

Two halves, and only one of them is a parameter you set:

```ts
import type { WebSearchToolParams } from '@combycode/llm-sdk';

const search: { type: 'web_search'; params: WebSearchToolParams } = {
  type: 'web_search',
  params: {
    search_content_types: ['image', 'text'],
    image_settings: { max_results: 3, caption: true },
  },
};

const { response } = await complete({ model: 'openai/gpt-5.4-nano', apiKey, prompt: '…', tools: [search] });
for (const call of response.builtinToolCalls ?? []) {
  for (const r of call.results ?? []) console.log(r.imageUrl, r.caption);
}
```

The other half is `include: ['web_search_call.results']` on the request, and **the adapter adds it
for you** whenever `search_content_types` contains `'image'`. That matters because the results are
otherwise simply absent: measured 2026-09-30, the same request with the include returns results and
without it returns none — a search that found images and a response that does not contain them,
which reads as "no images found" rather than as a missing parameter.

`external_web_access: false` runs the search cache-only, fetching no new external content.

### Restricting what `web_fetch` may fetch (Anthropic)

`url_sources` decides which URLs are eligible — use the exported `WebFetchToolParams` for editor
help. Each key is a tagged variant: `user_input` is `all` or `none`; the two tool filters add
`only` and `except`, whose `tool_names` must name tools declared in the same request.

```ts
import type { WebFetchToolParams } from '@combycode/llm-sdk';

const fetchTool: { type: 'web_fetch'; params: WebFetchToolParams } = {
  type: 'web_fetch',
  params: {
    url_sources: {
      user_input: { type: 'all' },                              // URLs the user pasted
      server_tool_results: { type: 'only', tool_names: ['web_search'] },
      client_tool_results: { type: 'none' },                    // nothing from your own tools
    },
  },
};
```

Worth setting deliberately: left unset, the fetchable set is whatever the server defaults to, and
"any URL any tool result mentioned" is a wider reach than most callers intend.

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

A large tool block is paid for on every request. `lazy: true` registers a tool without
declaring it: the model finds it with a built-in `tool_search` and runs it through
`call_tool`. Measured over 308 tools, that is identical correctness at -72% / -97% cost per
task, for one extra round trip -- and *more* expensive than declaring everything below
roughly a hundred tools.

```ts
import { connectMcp, defineTool } from '@combycode/llm-sdk';

await connectMcp({ url: 'https://mcp.deepwiki.com/mcp' }, { lazy: true });  // whole server

defineTool({ name: 'rare_thing', description: 'Rarely needed.', params: {}, lazy: true, execute: () => 'ok' });
```

Full guide, including when NOT to use it: [Lazy tools](./lazy-tools.md).

## Related

- [Agent Loop + delegate / chain / consolidate](./agent-loop.md)
- [LLM Client + complete/stream](./llm-client.md)
- [MCP (Model Context Protocol)](./mcp.md)
- [Permissions](./context-guard.md)
