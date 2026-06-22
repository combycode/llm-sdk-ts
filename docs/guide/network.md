# Network Engine

The network layer is a multi-queue HTTP router that sits under every outbound call
in the SDK. You rarely need to touch it directly -- `createEngine()` builds and
wires it for you -- but understanding it helps when you want to tune concurrency,
retry behavior, or hook into raw HTTP events.

## When to reach for this

- You need to tune rate limits or concurrency per provider queue.
- You want to inspect the low-level HTTP request/response cycle (e.g. for
  debugging a custom provider or a test double).
- You are building a plugin that must go through the queue (all HTTP *must* flow
  through `engine.fetch` -- never call `globalThis.fetch` directly).

## Main exports

| Export | What it does |
|---|---|
| `NetworkEngine` | Core HTTP router. Owns the queue map. Every LLMClient, MCP client, and MediaOutput uses it. |
| `createEngine()` | Factory helper that builds an `EngineHandle` containing a `NetworkEngine` (and other plugins). The standard entry point. |
| `LLMError` / `classifyError` | Normalized error class + classifier used by the retry layer. |
| `RequestQueue` / `QueueState` | Per-provider queue with semaphore + rate-limiter + retry state. Exposed for advanced configuration. |
| `RateLimiter` / `TokenBucket` / `Semaphore` | Building blocks wired inside each queue. |
| `parseSSEStream` | Utility to parse a Server-Sent Events body; used internally and available for custom adapters. |
| `Priority` / `DEFAULT_RETRY` | Constants for request priority and default retry config. |
| `isBrowser` | Runtime detection -- returns true in browser environments. Guards Node-only code paths. |

Type-only exports: `FetchFn`, `HttpRequest`, `HttpResponse`, `SSEEvent`,
`QueueSnapshot`, `TraceContext`, `RealtimeConnection`, and related.

## Minimal example

```ts
import { createEngine, complete } from '@combycode/llm-sdk';

// createEngine() builds and registers a NetworkEngine automatically.
// After this call, complete() / createLLM() / etc. use it without
// you passing `engine` explicitly.
const engine = createEngine({
  catalog: 'defaults',
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});

// All HTTP goes through engine.network (the NetworkEngine) transparently.
const { text } = await complete({
  model: 'anthropic/claude-haiku-4.5',
  prompt: 'Hello',
});
console.log(text);
```

If you need two engines at once (e.g. different concurrency limits per tenant):

```ts
import { createEngine, createLLM } from '@combycode/llm-sdk';

const e1 = createEngine({ apiKeys: { openai: process.env.OPENAI_KEY! } });
const e2 = createEngine({
  registerAsDefault: false,
  apiKeys: { anthropic: process.env.ANTHROPIC_KEY! },
});

const llm1 = createLLM({ model: 'openai/gpt-5.4-nano', engine: e1 });
const llm2 = createLLM({ model: 'anthropic/claude-haiku-4.5', engine: e2 });
```

## Related

- [LLM Client + complete/stream](./llm-client.md)
- [Observability / Telemetry](./telemetry.md)
