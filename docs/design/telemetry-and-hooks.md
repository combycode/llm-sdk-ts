---
title: Telemetry & Hooks
---

# Telemetry & Hooks

Source: `src/bus/hook-bus.ts`, `src/bus/hook-map.ts`, `src/bus/agent-bus.ts`,
`src/bus/async-context.ts`, `src/plugins/telemetry/telemetry.ts`.

## Purpose and responsibilities

`HookBus` is the typed pub/sub backbone for all SDK instrumentation. Every
subsystem (network engine, LLM client, agent loop, server, plugins) emits
named events; consumers (logger, cache, cost collector, context guard, telemetry
adapter) subscribe.

`TelemetryAdapter` is a single `HookBus.onAny` tap that turns the event stream
into three OpenTelemetry-compatible signals — traces, metrics, and logs — with
NO `@opentelemetry` package dependency. The adapter is the OTel exporter bridge.

## `HookBus` (`src/bus/hook-bus.ts`)

```ts
class HookBus {
  on<K extends HookName>(name: K, handler: HookHandler<K>): () => void
  once<K>(name: K, handler: HookHandler<K>): () => void
  onAny(handler: AnyHookHandler): () => void     // catch-all for every event
  off(name?: HookName): void                     // remove named or all handlers
  emit<K>(name: K, ctx: HookMap[K]): Promise<void>     // async, sequential
  emitSync<K>(name: K, ctx: HookMap[K]): void           // sync, hot paths
  has(name: HookName): boolean
  get handlerCount(): number                     // diagnostic for leak detection
}

type AnyHookHandler = (name: HookName, ctx: unknown) => void | Promise<void>;
```

**Two dispatch paths**:

`emit` (async): handlers run **sequentially** in registration order; each is
`await`-ed. Used where a handler may perform async work OR set a mutable control
flag on the context object:
- `onRequestStart.abort` — cancel the HTTP call.
- `onMessageResolve.abort` / `abortReason` — cancel pre-send.
- `onBeforeSubmit.intercepted` + `resultPromise` — Cache plugin short-circuit.

Handler errors propagate to the emitter. Handlers that must never break requests
(like the TelemetryAdapter) must catch their own errors.

`emitSync` (sync): used on hot-path events where the emitter cannot block:
`onEnqueue`, `onDequeue`, `onStreamChunk`, `onRetry`, `onRateLimitUpdate`,
`onCostEntry`, `onBudgetWarning`, `onBudgetExceeded`, `onAgentCreate`,
`onClientCreate`, etc. Async handlers in `emitSync` calls start but are NOT
awaited — resolution timing is undefined.

**`on()` and unsubscription**: returns a zero-arg unsubscribe function.
`once()` calls `on()` and calls the returned unsub inside the handler.

**`handlerCount`**: sums all named handlers plus anyHandlers. After
`engine.destroy()`, if no external subscribers remain, this should return 0.
Useful in tests to detect listener leaks.

`HookBus` stores handlers in `Map<string, Array<(ctx: any) => void | Promise<void>>>`.
The `any` cast is necessary because handlers for different `K` are heterogeneously
typed; the call site enforces typing via the generic `on<K>()` overload.

## `HookMap` — typed event contract (`src/bus/hook-map.ts`)

The single source of truth for every event name and its context type. No
module-level declaration merging — all events are declared in one file.

| Group | Events |
|-------|--------|
| Cross-cutting | `onWarning`, `onInternalError` |
| Network — queue | `onEnqueue`, `onDequeue`, `onQueueTimeout`, `onRateLimitUpdate` |
| Network — HTTP | `onRequestStart`, `onRequestComplete`, `onRetry`, `onStreamChunk`, `onModelError`, `onRateLimitHit` |
| Network — realtime | `onRealtimeOpen`, `onRealtimeFrame`, `onRealtimeClose`, `onRealtimeError` |
| LLM client | `onClientCreate`, `onClientDestroy`, `onMessageResolve`, `onBeforeSubmit`, `onCompletion` |
| Agent | `onAgentCreate`, `onAgentDestroy`, `onRunStart`, `onStepStart`, `onStepComplete`, `onRunComplete`, `onRunError`, `onGuardrailTriggered`, `onApprovalRequested`, `onApprovalResolved` |
| Tool | `onToolCallStart`, `onToolCallComplete`, `onToolCallError` |
| Internal tools | `onInternalToolCallStart`, `onInternalToolCallComplete`, `onInternalToolCallError` |
| Cost | `onCostEntry`, `onBudgetWarning`, `onBudgetExceeded` |
| Context | `onContextMeasure` |
| Media | `onMediaGenerated`, `onMediaError` |
| Server | `onServerRequest`, `onServerResponse`, `onAuthFail` |
| MCP | `onMcpConnect`, `onMcpToolCall`, `onMcpError` |

**Control fields** (only set on `emit`, not `emitSync`):
- `RequestStartContext.abort?: boolean` — handler sets to cancel the HTTP call.
- `MessageResolveContext.abort?` + `abortReason?` — cancel pre-send.
- `BeforeSubmitContext.intercepted?` + `resultPromise?` — Cache short-circuit.
- `ToolCallErrorContext.continueOnError?` — set false to abort the run.
- `ToolCallErrorContext.fallbackResult?` — substitute error message.
- `ToolCallStartContext.skip?` / `overrideResult?` — hook-level tool interception.
- `ContextMeasureContext.abort?` / `abortReason?` — ContextGuard pre-send cancel.

**`TraceContext`**: `{ sessionId?, requestId?, callId? }` is embedded in most
network/LLM/agent events. The canonical trace key is `"sessionId:requestId"` —
built in `TelemetryAdapter` as `traceKey({ sessionId, requestId })`.

**`onInternalError`** (distinct from `onModelError`): fired by `settleOnWorkerCrash`
in `QueueState` when the SDK's own invariant is violated (e.g. worker throws
before releasing the semaphore). Kept separate so engine bugs don't pollute
per-provider error metrics.

**`onWarning`**: advisory notifications from any subsystem. `WarningSource`
includes `'agent'`, `'llm'`, `'network'`, `'queue'`, `'cache'`, `'cost'`,
`'context'`, `'media'`, `'files'`, `'persistence'`, `'server'`, `'plugin'`.

## `AgentBus` (`src/bus/agent-bus.ts`)

A separate, distinct bus from `HookBus`. Carries cross-module business events
with pattern matching (`"agent.foo"`, `"agent.*"`, `"*"`). NOT used for SDK
instrumentation. Do not confuse the two: `HookBus` = SDK internals;
`AgentBus` = application business events.

## Async context (`src/bus/async-context.ts`)

A thin wrapper around `AsyncLocalStorage` (Node/Bun) with a browser fallback
using a module-level variable (`src/bus/async-context.browser.ts`). Used to
propagate `RequestContext` through async call chains without threading it
through every function signature.

The browser swap is controlled by package.json `exports` (or bundler conditions)
pointing `./async-context` to the browser file in browser environments.

## `TelemetryAdapter` (`src/plugins/telemetry/telemetry.ts`)

Constructed with `(hooks: HookBus, opts?: TelemetryAdapterOptions)`. Calls
`hooks.onAny((name, ctx) => this.handle(name, ctx))` and stores the unsubscribe
function. `destroy()` unsubscribes.

```ts
interface TelemetryAdapterOptions {
  maxEvents?: number;           // ring-buffer cap (default 2000)
  resource?: TelemetryResource;
}

interface TelemetryResource {
  serviceName: string;
  serviceNamespace?: string;
  serviceInstanceId?: string;   // recommend: set to engine.sessionId
  serviceVersion?: string;
  attributes?: Record<string, string>;
}
```

### Traces

Spans are managed via `open: Map<string, Span>` (in-flight) and `spans: Span[]`
(completed). Span key format: `"<kind>:<traceId>"` or `"<kind>:<traceId>:<attempt>"`.

```ts
interface Span {
  traceId: string;
  spanId: string;
  name: string;
  kind: SpanKind;              // 'llm' | 'http' | 'media' | 'agent' | 'tool' | 'mcp' | 'other'
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'unset' | 'ok' | 'error';
  attributes: Record<string, unknown>;
}
```

Span lifecycle per event:

| Span kind | Open trigger | Close trigger |
|-----------|-------------|---------------|
| `llm` | `onBeforeSubmit` (key `llm:<traceId>`) | `onCompletion` |
| `http` | `onRequestStart` (key `http:<traceId>:<attempt>`) | `onRequestComplete` |
| `agent` | `onRunStart` (key `agent:<runId>`) | `onRunComplete` / `onRunError` |
| `tool` | `onToolCallStart` (key `tool:<callId>`) | `onToolCallComplete` / `onToolCallError` |
| `media` | — | point span on `onMediaGenerated` |
| `mcp` | — | point span on `onMcpConnect` / `onMcpToolCall` |

**Stream path special case**: `stream()` does not emit `onBeforeSubmit` (no
intercept point before streaming). On `onCompletion` for a streaming call, the
adapter checks `this.open.has('llm:<traceId>')`:
- If the span is open (complete path): close it normally.
- If not open (stream path): synthesize a completed `llm` span by searching the
  closed `spans[]` for an `http` span with the same `traceId` and using its
  `startTime`.

`openSpan(key, traceId, spanName, kind, attributes)`: creates a `Span` in
`this.open`. `closeSpan(key, status, attributes)`: moves it to `this.spans[]`
with `endTime`, `durationMs`, `status`, and merged attributes.

### Metrics

`TelemetryMetrics` is updated in-place on each relevant event:

```ts
interface TelemetryMetrics {
  requests: number;          // onRequestStart
  errors: number;            // onModelError
  retries: number;           // onRetry
  rateLimitHits: number;     // onRateLimitHit
  completions: number;       // onCompletion
  mediaGenerated: number;    // onMediaGenerated
  costUsd: number;           // onCostEntry (accumulated)
  inputTokens: number;       // onCompletion (per-call usage)
  outputTokens: number;
  inFlight: number;          // gauge: +1 onRequestStart, -1 onRequestComplete
  queueDepth: number;        // gauge: mirrored from queueLength on onEnqueue/onDequeue
  latency: { count, min, max, avg };  // running from onRequestComplete.latencyMs
}
```

`queueDepth` is a GAUGE: `onEnqueue` raises it to `ctx.queueLength`; `onDequeue`
lowers it to the post-dequeue `ctx.queueLength`. The dequeue event already
carries the post-dequeue length so it is mirrored directly (no decrement).

Latency: `recordLatency(ms)` updates a running sum (`latSum`) and increments
`latency.count`. `avg = latSum / count`. `min` and `max` are running extremes.

### Event log

Every event is appended as `TelemetryEvent`:
```ts
interface TelemetryEvent {
  seq: number;            // monotone sequence number
  time: number;           // Date.now()
  name: HookName;
  category: string;       // from CATEGORY map (see below)
  traceId?: string;       // "sessionId:requestId" when available
  ctx: unknown;           // sanitized context
}
```

The `CATEGORY` map (`telemetry.ts:74`) classifies every hook name:
- `'network'` — all queue and HTTP events
- `'realtime'` — WebSocket events
- `'llm'` — client lifecycle + completion
- `'agent'` — run/step/guardrail/approval events
- `'tool'` — all tool-call events (both agent-layer and internal-tools)
- `'cost'`, `'context'`, `'media'`, `'server'`, `'mcp'`
- `'error'` — `onWarning`, `onInternalError`
- `'other'` — any hook not in the map

The event log is a **ring buffer**: when `events.length > maxEvents`,
`events.shift()` drops the oldest entry.

### Secret redaction

`sanitizeEventCtx(name, ctx)` is applied before storing. Only three event types
carry URLs and headers: `onRequestStart`, `onRequestComplete`, `onModelError`.

`sanitizeUrl(url)`: parses with `new URL(...)`, replaces values of query params
in `SENSITIVE_QUERY_PARAMS` (`'key'`, `'api_key'`, `'access_token'`, `'token'`)
with `'***REDACTED***'`. Non-parseable URLs pass through unchanged.

`sanitizeHeaders(headers)`: returns a new record with values of headers in
`SENSITIVE_HEADERS` (`'authorization'`, `'x-goog-api-key'`, `'x-api-key'`,
`'api-key'` — all lower-cased) replaced with `'***REDACTED***'`.

For `onModelError`, `sanitizeErrorForTelemetry(error)` extracts only safe
fields (`name`, `message`, `code?`, `status?`, `raw?`) from the error and caps
`raw` to `MAX_ERROR_RAW_CHARS = 512`.

**Important**: the event stream inside the process is unredacted. Only the
stored log (`this.events[]`) receives sanitized context. This is intentional —
other subscribers (logger) may need full URLs for debugging in controlled
environments.

### Export

```ts
adapter.snapshot()      // { spans: Span[], events: TelemetryEvent[], metrics: TelemetryMetrics }
adapter.serialize()     // JSON string with trimReplacer applied
adapter.toOtlpTraces()  // OTLP-compatible resourceSpans JSON
```

`trimReplacer` (`telemetry.ts:623`):
- `Error` instances → `{ name, message, code?, cause? }` (drops arbitrary
  attached props that might carry secrets).
- Strings longer than 512 chars → `"first-256-chars... (N chars trimmed)"`.
  This prevents base64 media blobs from bloating debug exports.

`toOtlpTraces()` produces:
```json
{
  "resourceSpans": [{
    "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "..." } }] },
    "scopeSpans": [{
      "scope": { "name": "combycode.telemetry" },
      "spans": [/* per Span: traceId, spanId, name, startTimeUnixNano, endTimeUnixNano, kind, status, attributes */]
    }]
  }]
}
```

Timestamps are converted: `Math.round(epochMs * 1e6)` → nanoseconds (OTLP convention).
Span kind maps to OTel integer codes via string value (`'llm'`, `'http'`, etc.)
but the spec integer is not mapped — the string is passed as-is (custom kind).
Status: `'error'` → code 2; `'ok'` → code 1; `'unset'` → code 0.

## `traceIdsOf` and `traceKey` helpers

```ts
function traceIdsOf(ctx: unknown): { sessionId?, requestId? }
```

Inspects `ctx.trace`, `ctx.ctx`, and `ctx` itself (flat fields) to extract
`sessionId` and `requestId`. This covers all three layout patterns used across
event types: network events carry `.trace`, LLM events carry `.ctx`, and some
events carry both flat on the top level.

```ts
const traceKey = (ids) => ids.requestId ? `${ids.sessionId ?? '?'}:${ids.requestId}` : undefined
```

## Extension points

- **Subscribe to all events**: `hooks.onAny(handler)` — receives every emit.
- **Subscribe to specific events**: `hooks.on('onCompletion', handler)`.
- **Adding a new event**: add the context type to `HookMap` in `hook-map.ts`,
  then `emitSync` or `emit` at the appropriate point. The `TelemetryAdapter`
  automatically logs it (category `'other'` unless the `CATEGORY` map is
  updated).
- **Adding span coverage**: add cases in `TelemetryAdapter.handle()` with
  `openSpan` / `closeSpan` calls.
- **Custom exporter**: call `adapter.toOtlpTraces()` and POST to your collector;
  or subscribe to the bus and stream events yourself.

## Key invariants

- `emit` (async, awaited) is required for control-flag hooks.
  `emitSync` must NOT be used for hooks where control flags must take effect
  before the next line of the emitter runs.
- Handler errors from `emit()` propagate to the emitter. The caller (e.g.
  `QueueState.executeWithRetry`) expects certain hooks to be await-safe.
  Plugins that should never break requests must catch their own errors.
- All secret redaction happens in the telemetry adapter's stored log, not at
  emit time. The in-process event stream is unredacted.
- `AgentBus` and `HookBus` are distinct objects. Sharing them accidentally
  would route business events into instrumentation handlers.
- `destroy()` must be called on `TelemetryAdapter` when the engine is torn
  down; otherwise the `onAny` subscription leaks and `handlerCount` stays
  elevated.
