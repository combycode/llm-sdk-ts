# Observability / Telemetry -- createObserver / TelemetryAdapter / HookBus

The observability layer converts every internal SDK event into OpenTelemetry-style
signals (traces, metrics, logs) with no `@opentelemetry` dependency. All events
flow over a typed `HookBus`; you can subscribe directly or use `TelemetryAdapter`
to aggregate them into spans + counters.

## When to reach for this

- You want to log every LLM call, tool execution, or cost event.
- You want to export traces to an OTel collector.
- You want to react to agent lifecycle events (run start/complete, errors) with
  a side-effect function or an observer agent.
- You are building a plugin that needs to emit or receive events.

## Main exports

| Export | What it does |
|---|---|
| `createObserver(agent, event, reactor)` | Subscribe to a specific agent event. Reactor is a plain async function or an agent config that runs a sub-agent on each event. Returns an unsubscribe function. |
| `TelemetryAdapter` | Attaches to a `HookBus` and builds in-memory spans + metrics from all events. Call `.toOtlpTraces()` to export for a real OTel collector. |
| `HookBus` | Typed pub/sub bus. `.on(event, handler)` → unsubscribe fn. `.emit(event, ctx)` → async. `.emitSync(event, ctx)` → sync. |
| `AgentBus` | Secondary bus for plugin-to-tool / module events. |
| `Logger` / `ConsoleSink` | Structured logger that routes `LogEvent`s to sinks. Wired to the hook bus. |

Type-only exports: `HookMap`, `HookName`, `HookHandler`, `TelemetryEvent`,
`TelemetryMetrics`, `Span`, `SpanKind`, `LogEvent`, `LogLevel`, `LogSink`.

## Minimal examples

### Hook directly into completion events

```ts
import { createEngine, complete } from '@combycode/llm-sdk';

const engine = createEngine({
  catalog: 'defaults',
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});

engine.hooks.on('onCompletion', (ctx) => {
  console.log(
    `[completion] ${ctx.provider}/${ctx.model} ` +
    `in=${ctx.response.usage.inputTokens} out=${ctx.response.usage.outputTokens}`,
  );
});

await complete({ model: 'anthropic/claude-haiku-4.5', prompt: 'Hello' });
```

Long-running async video (generate / extend / edit) emits `onMediaProgress` once
per poll, so a UI can show a progress bar:

```ts
engine.hooks.on('onMediaProgress', ({ provider, operationId, progress }) => {
  console.log(`[video] ${provider} ${operationId} ${progress ?? '?'}%`);
});
```

### TelemetryAdapter -- OTel-style traces + metrics

```ts
import { createEngine, TelemetryAdapter, complete } from '@combycode/llm-sdk';

const engine = createEngine({
  catalog: 'defaults',
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});

const telemetry = new TelemetryAdapter(engine.hooks);

await complete({ model: 'anthropic/claude-haiku-4.5', prompt: 'Hello' });
await complete({ model: 'anthropic/claude-haiku-4.5', prompt: 'World' });

const metrics = telemetry.metrics;
console.log(`Requests: ${metrics.requests}`);
console.log(`Total cost: $${metrics.costUsd.toFixed(6)}`);

// Shape into OTLP for a real exporter:
const otlp = telemetry.toOtlpTraces();
console.log(JSON.stringify(otlp).slice(0, 200));
```

### Sending it to an OTLP endpoint

`toOtlpTraces()` returns an OTLP/JSON `resourceSpans` payload -- POST it to any collector
(Grafana Cloud, Tempo, Jaeger, Honeycomb) with your own auth header. No `@opentelemetry`
dependency anywhere in this path.

```ts
import type { TelemetryAdapter } from '@combycode/llm-sdk';

declare const telemetry: TelemetryAdapter;

await fetch('https://otlp-gateway-<zone>.grafana.net/otlp/v1/traces', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Basic ${process.env.OTLP_AUTH}` },
  body: JSON.stringify(telemetry.toOtlpTraces()),
});
```

What the payload conforms to, and why each part matters:

| | |
|---|---|
| trace / span ids | 16- and 8-byte **hex**, derived deterministically from the readable internal ids. A collector rejects anything else outright. |
| span kind | the int enum -- `CLIENT` for inference, HTTP and MCP; `INTERNAL` for agent and tool work. |
| attribute values | typed. Token counts go out as `intValue`, so a backend can sum them; as strings every token metric is unaggregatable. |
| span name | the conventional one -- `chat claude-haiku-4.5`, `execute_tool search`, `invoke_agent`. |
| parent | `parentSpanId` on every span, so a backend draws a **tree** rather than a flat list of siblings. |

The **internal** model keeps readable ids (`s:r`, `mcp:tool:deepwiki:ask:3`) and the domain
`kind`: `snapshot()` is unchanged, and that is what the sandbox sidebar groups by. Only the
export is translated.

### Running inside your application's trace

By default the SDK roots a trace of its own. That is right for a script and wrong for a service:
your app already owns the span where the request arrived, and the model calls it triggers belong
*under* it. Without this, the business chain and the agent work reach the backend as two unrelated
traces with nothing to join them.

Pass the app's span as `traceparent` -- the W3C header shape, which is exactly what an inbound
`traceparent` header or an active OTel span gives you:

```ts
await agent.complete(userInput, {
  ctx: {
    traceparent: req.headers['traceparent'],   // 00-<32 hex trace>-<16 hex span>-<flags>
    conversationId: thread.id,
  },
});
```

Everything the run emits then joins that trace and hangs under that span:

```
POST /api/orders                 <- your span
  └ price confirmed              <- your span
    └ invoke_agent
      └ chat claude-haiku-4.5
      └ execute_tool set_brief_fields
        └ invoke_agent           <- an agent nested in a tool lands where it ran
          └ chat gpt-5.4-nano
```

A malformed or absent header is ignored rather than fatal: the run keeps its own trace and its
telemetry, it simply does not join yours.

For a nested agent, hand down the trace your tool executor already receives -- that is all the
inner run needs to stay in the same trace:

```ts
const tool = defineTool({
  name: 'research',
  params: { topic: 'string' },
  execute: async ({ topic }, toolCtx) => inner.complete(topic, { ctx: toolCtx.trace }),
});
```

### GenAI attributes and span names

Spans carry the [OTel GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai),
which is what makes a backend recognise them as agent work rather than anonymous spans -- and what
saves you writing a bespoke mapping per backend:

| attribute | source |
|---|---|
| `gen_ai.provider.name` *(required)* | the provider the call went to |
| `gen_ai.operation.name` *(required)* | `chat`, `invoke_agent`, `execute_tool` |
| `gen_ai.request.model` | the model you asked for |
| `gen_ai.response.model` | the model that answered -- an alias can resolve to a dated snapshot |
| `gen_ai.conversation.id` | the agent's history id; absent for a bare client call |
| `gen_ai.usage.input_tokens` / `output_tokens` | reported usage |
| `gen_ai.agent.id` | the agent that ran |
| `gen_ai.tool.name` / `gen_ai.tool.call.id` | the tool that ran, and the call it answered |

Exported span names follow from the operation: `chat {model}`, `execute_tool {name}`, and
`invoke_agent` -- bare, because the SDK has agent IDs rather than human names and the convention
only asks for the subject when one is readily available.

Internally the spans stay `llm.request`, `agent.run` and `tool.call`: `snapshot()` is unchanged,
and that is what the sandbox sidebar groups by. These conventions are still marked *Development*
upstream, so names can move -- they are applied at the export boundary precisely so a rename does
not reach into the rest of the library.

### Redacting error text (`includeSensitiveData`)

URLs and headers are **always** redacted before anything reaches telemetry storage. Provider error
*text* is not: `error.message` and `error.raw` can echo request content back at you — a moderation
refusal quotes the prompt, a validation error names the offending field and its value.

That is fine for local debugging and is the default (`includeSensitiveData: true`, matching the
OpenAI Agents SDK's `trace_include_sensitive_data`). When telemetry leaves your trust boundary — a
shared collector, a vendor APM — turn it off:

```ts
const telemetry = new TelemetryAdapter(engine.hooks, { includeSensitiveData: false });
// error.message -> '***REDACTED***', error.raw dropped
// error.name / error.code / error.status are KEPT, so traces stay triageable
```

### Observer -- react to agent events

```ts
import { createAgent, createObserver } from '@combycode/llm-sdk';

const agent = createAgent({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  system: 'You are a helpful assistant.',
});

// Plain function reactor.
const unsub = createObserver(agent, 'onRunComplete', (ctx) => {
  console.log(`Agent run finished. Text length: ${ctx.response?.text.length ?? 0}`);
});

await agent.complete('What is 2 + 2?');

unsub(); // stop observing
```

## Related

- [Agent Loop + delegate / chain / consolidate](./agent-loop.md)
- [Cost tracking + estimate()](./cost.md)
- [Network Engine](./network.md)
