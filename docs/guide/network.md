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

## Retries

Retry policy is configured per queue (per provider), and a **single request can override it**
without disturbing anything else on that queue:

Retry is a cross-cutting setting, so you configure it **once on the engine** and every request
inherits it — there is nothing to thread through individual calls:

```ts
createEngine({
  apiKeys: { openai: process.env.OPENAI_API_KEY! },
  retry: {
    maxRetries: 5,
    attemptTimeoutMs: 10_000,
    maxRetryAfterMs: 30_000,
    backoff: { initialMs: 200, maxMs: 8_000, multiplier: 2, jitter: 0.2 },
    perKind: { server_error: { retryable: true, maxRetries: 3 } },
  },
});
```

One provider needing different treatment is a per-queue override, keyed by queue name
(`provider/model` unless you route otherwise):

```ts
createEngine({
  retry: { maxRetries: 5 },
  queues: { 'openai/gpt-5.4-nano': { retry: { maxRetries: 1 } } },
});
```

**Three layers, narrowest wins:** `HttpRequest.retry` (one request, for the rare one-off — a long
batch submit, a health check that should fail fast) → `queues[name].retry` (one provider) →
`createEngine({ retry })` (everything). Nested groups merge rather than replace, so overriding one
`backoff` knob keeps the rest.

`RetryConfig` accepts `maxRetries` / `totalTimeoutMs` / `attemptTimeoutMs` / `maxRetryAfterMs` /
`backoff` (`initialMs`, `maxMs`, `multiplier`, `jitter`) / `perKind`. `RequestRetryOverride` is the
same minus `perKind`: one request cannot sensibly redefine which error classes are retryable for a
queue it shares with everyone else.

Note that `perKind` beats the top-level `maxRetries` for the kinds it names — the built-in policy
already sets `server_error: 2` and `rate_limit: 5`, so raising the ceiling for those means raising
them in `perKind`.

> **Corrected 2026-08-11.** This section previously showed `complete({ retry: … })` with the fields
> `attempts` / `initialDelay` / `maxDelay` / `expBase` / `httpStatusCodes`. None of those exist, and
> `complete()` takes no `retry` option — the sample raised `TS2353` for anyone who copied it. The
> retry machinery was always correct, but it was only reachable by hand-building an `HttpRequest`;
> `createEngine({ retry })` now exposes it where a cross-cutting setting belongs.

### `Retry-After` is honoured, but bounded

A server-supplied `Retry-After` is capped by `RetryConfig.maxRetryAfterMs` (default **120 s**), and a
value **above** the cap is treated as a refusal — the request fails fast rather than being parked:

- Uncapped, `Retry-After: 86400` held a request for a day, which from the caller's side is
  indistinguishable from a hang.
- On the rate-limit path an uncapped value also paused the **entire limiter** — every request on
  that queue, not just the throttled one. Both paths are clamped.

The HTTP-date form (RFC 9110) is parsed as well as the seconds form. Malformed values — `NaN`,
negative, non-finite, or a date in the past — are discarded rather than propagated, because
`setTimeout(fn, NaN)` fires immediately and turned one bad header into a retry storm.

## Related

- [LLM Client + complete/stream](./llm-client.md)
- [Observability / Telemetry](./telemetry.md)
