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

### TelemetryAdapter -- OTel-style traces + metrics

```ts
import { createEngine, TelemetryAdapter, complete } from '@combycode/llm-sdk';

const engine = createEngine({
  catalog: 'defaults',
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});

const telemetry = new TelemetryAdapter({ hooks: engine.hooks });

await complete({ model: 'anthropic/claude-haiku-4.5', prompt: 'Hello' });
await complete({ model: 'anthropic/claude-haiku-4.5', prompt: 'World' });

const metrics = telemetry.getMetrics();
console.log(`Requests: ${metrics.requests}`);
console.log(`Total cost: $${metrics.costUsd.toFixed(6)}`);

// Shape into OTLP for a real exporter:
const otlp = telemetry.toOtlpTraces();
console.log(JSON.stringify(otlp).slice(0, 200));
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
