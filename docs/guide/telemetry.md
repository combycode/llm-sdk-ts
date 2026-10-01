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
| `HookBus` | Typed pub/sub bus. `.on(event, handler)` → unsubscribe fn. `.onAny(handler)` → every event as one union, also returning an unsubscribe fn. `.emit(event, ctx)` → async. `.emitSync(event, ctx)` → sync. |
| `AgentBus` | Secondary bus for plugin-to-tool / module events. |
| `Logger` / `ConsoleSink` | Structured logger that routes `LogEvent`s to sinks. Wired to the hook bus. |

Type-only exports: `HookEvent`, `HookEventOf`, `AnyHookHandler`, `HookMap`, `HookName`,
`HookHandler`, `TelemetryEvent`, `TelemetryMetrics`, `Span`, `SpanKind`, `LogEvent`,
`LogLevel`, `LogSink`.

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

### Every event through one handler (`onAny`)

`on(name, handler)` is right when you want one thing. When you want the whole stream — a log
line per event, your own metrics, forwarding somewhere — subscribe once with `onAny`.

The stream is a single discriminated union: each event is `{ type, ctx }`, and `event.type`
narrows `event.ctx` to the context that name actually carries. That is the point of the shape.
A handler that took `(name, ctx)` had to cast to read anything, and a cast keeps compiling
after a field is renamed — it just starts reading `undefined`, which for a token count is a
metric that quietly goes to zero.

```ts
import { createEngine, complete, type HookEvent } from '@combycode/llm-sdk';

const engine = createEngine({
  catalog: 'defaults',
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});

const unsubscribe = engine.hooks.onAny((event: HookEvent) => {
  switch (event.type) {
    case 'onCompletion':
      // `event.ctx` is the completion context here — no cast, and the compiler
      // checks every field against it.
      console.log(
        `[completion] ${event.ctx.provider}/${event.ctx.model} ` +
        `out=${event.ctx.response.usage.outputTokens}`,
      );
      break;
    case 'onWarning':
      console.warn(`[warning] ${event.ctx.source} ${event.ctx.code}: ${event.ctx.message}`);
      break;
    default:
      break;
  }
});

await complete({ model: 'anthropic/claude-haiku-4.5', prompt: 'Hello' });

unsubscribe();
```

`onAny` returns its own unsubscribe function. Call it when the subscriber goes away — a
long-lived engine otherwise keeps the handler, and with it whatever the closure holds.

Keep a `default` branch. The event set grows between releases, and a `switch` without one
stops compiling the moment it does.

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

### Naming your agents

An unlabelled agent exports as a bare `invoke_agent` carrying only its generated id -- and
that id changes per process, so you can neither tell which of your agents ran nor compare
one across runs. Give it a name:

```ts
const agent = createAgent({
  model: 'anthropic/claude-haiku-4.5',
  label: 'briefing',                       // -> `invoke_agent briefing`, gen_ai.agent.name
  source: 'customer',                      // -> agent.source: which part of YOUR system
  attributes: { 'app.tenant': 'acme' },    // -> anything the fixed fields do not cover
});
```

`source` is free text, not a fixed set: the taxonomy is your application's -- product
surface, team, bounded context -- and a library that imposed its own categories would just
push you into encoding yours inside `label`. It exports as `agent.source`, our attribute,
because the GenAI conventions have no term for it.

Attribute keys are used verbatim, so namespace yours (`app.tenant`). Ours win on a
collision: a stray `gen_ai.*` key in the bag cannot relabel what the span claims to be.

### `onTrace` -- take the events, send them yourself

This SDK is one part of a larger system. The traces an operator reads are the *business*
ones -- order confirmed, worker selected -- and our HTTP retries are detail to unfold only
when something is wrong. So the library does not export anything and does not decide what
is worth keeping: it hands you events, filtered the way you asked, and your pipeline --
which already exists, and already carries the spans that matter more than ours -- decides
where they go.

```ts
const engine = createEngine({
  catalog: 'defaults',
  telemetry: {
    types: ['agent', 'tool', 'message'],   // business level; http/llm detail stays out
    content: 'none',                       // conversation text off unless you ask
    sample: 0.05,                          // per TRACE, not per span
    onTrace: (event) => myPipeline.push(map(event)),
  },
});

// More sinks, each with its own filter -- returns an unsubscribe function:
const stop = engine.telemetry!.onTrace({ types: ['message'] }, (e) => debugStore.write(e));
```

Each event carries the tree, so nothing has to be reconstructed:

```ts
interface TraceEvent {
  type: 'agent' | 'tool' | 'llm' | 'http' | 'mcp' | 'media' | 'message' | 'other';
  traceId: string;
  spanId: string;
  parentSpanId?: string;   // already re-parented past whatever YOU filtered out
  name: string;            // `execute_tool search`, `chat gpt-5.4-nano`
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'unset' | 'ok' | 'error';
  attributes: Record<string, unknown>;
}
```

Three things worth knowing, because the obvious implementation of each is broken:

**Filtering splices the tree, it does not punch holes in it.** Drop `http` and the spans
underneath re-parent to the nearest ancestor *you* still receive. Dropping without that
leaves children pointing at a span that never arrives, and a backend draws a dangling
parent as a second root -- worse than not filtering. Two subscribers with different
filters each get a tree that is correct for them.

**Sampling is per trace.** Sampling spans independently shreds every tree it touches: a
tool call with no run, a model call with no tool. The decision is a hash of the trace id,
so it is stable across processes and two services sharing a trace agree without
coordinating. It is *head* sampling -- the choice is made before we know whether the trace
ends in an error, so "keep every error" belongs in your collector, which is built for it.

**Conversation content is off by default.** Prompts and completions are the debugging gold
and the PII both. `content: 'full'` adds the Opt-In `gen_ai.input.messages` /
`gen_ai.output.messages` attributes to `message` events; `'none'` still reports the shape
(counts, sizes), which is enough to spot a runaway prompt. Content rides on `message`
events *only* -- never on spans -- so routing spans to a metrics backend cannot leak a
prompt into it.

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
| `gen_ai.usage.input_tokens` / `output_tokens` | reported usage. On a **chat** span, that call. On an **agent** span, the whole invocation -- every call the run made, including a run that failed |
| `gen_ai.agent.id` | the agent that ran |
| `gen_ai.agent.name` | its label, on the agent span **and on the tool spans beneath it** -- so tool calls group by the same name the agent does rather than by an opaque id. Absent when the run was given no label |
| `gen_ai.tool.name` / `gen_ai.tool.call.id` | the tool that ran, and the call it answered |

Exported span names follow from the operation: `chat {model}`, `execute_tool {name}`, and
`invoke_agent {label}` when the run was labelled -- bare otherwise.

**Per-run cost.** `gen_ai.usage.*` on the agent span is the sum over the run, so "what did this
invocation spend" is one attribute rather than a sum over the children. The process-wide counters in
`snapshot().metrics` still answer the different question of how much has been spent overall.

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

## Catching provider drift (`checkResponseShapes`)

A bad request comes back as a 400 and you know at once. A bad **response** comes
back as a 200: the parse succeeds, the field the SDK reads is not there any more,
and the value becomes `undefined`. When that field is `usage.output_tokens`, cost
reporting quietly goes to zero and nothing errors.

Turn the check on and drift is reported on the warning bus:

```ts
import { createEngine } from '@combycode/llm-sdk';

const engine = createEngine({ checkResponseShapes: true });

engine.hooks.on('onWarning', (ctx) => {
  if (ctx.code.startsWith('response_shape_')) console.warn(ctx.code, ctx.message);
});
```

Four codes, in the order they matter:

| code | what happened |
| --- | --- |
| `response_shape_unknown_value` | a discriminator (`type`, `stop_reason`, …) carries a value nothing branches on — a new content-block type is dropped in silence |
| `response_shape_unknown_event` | a streaming event type the parser does not handle, skipped in silence |
| `response_shape_missing_field` | a field present in every recorded response is absent — what a rename looks like from outside |
| `response_shape_unknown_field` | a field never seen before; the provider added something |

It is **off by default**, never changes what is parsed, and reports each distinct
finding **once per client** — a warning that repeats on every request is one people
switch off. Turn it on in staging and in your test suite; leave it off in a hot
production path if you would rather not walk every response body.

The shapes it compares against are **derived from recorded provider responses**
(`tests/fixtures/response-golden.json`), not hand-written, so they describe what
providers actually send rather than what someone remembered. That distinction is
not academic: a hand-written "normal Anthropic response" omits `stop_details`,
`usage.service_tier` and `usage.cache_read_input_tokens`, all of which arrive on
every call.

A provider with no recording is not checked, rather than having every field
called unknown.

## Related

- [Agent Loop + delegate / chain / consolidate](./agent-loop.md)
- [Cost tracking + estimate()](./cost.md)
- [Network Engine](./network.md)
