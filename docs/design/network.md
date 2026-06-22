---
title: Network Engine
---

# Network Engine

Layer 1 of the four-layer stack. Zero knowledge of LLMs or providers.
All HTTP and WebSocket traffic in the SDK flows through this layer.
Source: `src/network/`.

## Purpose and responsibilities

- Route HTTP requests through named, per-model queues (`Map<queueName, QueueState>`).
- Enforce rate limits (RPM / TPM / RPD), concurrency caps, and retry policy per queue.
- Parse SSE streams and surface them as `AsyncIterable<SSEEvent>`.
- Open and manage WebSocket connections for realtime adapters via `engine.connect()`.
- Emit instrumentation hooks for every observable event (enqueue, dequeue, start,
  complete, error, retry, rate-limit hit, stream chunk, realtime frames).

Does NOT: know about LLMs, providers, models, auth headers, or body formats. The
semantic layer (`LLMClient`) sets `req.provider` and `req.model` on each
`HttpRequest` purely for hook observability and default queue-name derivation.

## Component hierarchy

```text
NetworkEngine                           src/network/engine.ts
  Map<queueName, QueueState>            src/network/queue-state.ts   (lazy per queue)
    RateLimiter                         src/network/rate-limiter.ts
      TokenBucket (rpm)
      TokenBucket (tpm)
      TokenBucket (rpd)
    Semaphore                           src/network/semaphore.ts
    RequestQueue (min-heap)             src/network/request-queue.ts
  RealtimeConnectionImpl                src/network/realtime-connection.ts
```

`NetworkEngineConfig` accepts optional `fetch`, `connect`, `hooks` (a `HookBus`),
and a `queues` map of pre-configured per-queue settings. All are injectable so
tests stub the network without real sockets.

## Key types (`src/network/types.ts`)

```ts
interface HttpRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
  timeout?: number;
  signal?: AbortSignal;
  stream?: boolean;
  provider: string;        // for hook payloads and default queueName
  model: string;
  responseType?: 'json' | 'arraybuffer' | 'text';
  rawBody?: boolean;       // skip JSON.stringify — for multipart uploads
  trace?: TraceContext;    // { sessionId?, requestId?, callId? }
}

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;          // parsed per responseType
}

interface SSEEvent {
  event?: string;
  data: string;
  id?: string;            // SSE id: field, used for Last-Event-ID resumption
}

interface QueueSnapshot {
  queueName: string;
  depth: number;          // requests queued, not yet started
  inFlight: number;       // requests holding the semaphore
  waiting: number;        // requests blocked on semaphore.acquire()
  rateLimitWaitMs: number;
  running: boolean;       // whether processLoop is active
  processed: number;      // lifetime HTTP round-trips completed (persistent counter)
  peakDepth: number;      // high-water mark
}

type EngineFetch = (req: HttpRequest, opts?: FetchOptionsLite) => Promise<HttpResponse>;
type EngineFetchStream = (req: HttpRequest, opts?: FetchOptionsLite) => AsyncIterable<SSEEvent>;
type EngineConnect = (req: WsRequest) => RealtimeConnection;
```

`TraceContext` (`src/network/types.ts`) carries `{ sessionId?, requestId?, callId? }`.
It is embedded on `HttpRequest` and echoed on every hook payload so all events
for one LLM call share a single `"sessionId:requestId"` trace key for OTel.

## Queue settings and lazy initialization

`NetworkEngine` holds two maps: `settings: Map<string, QueueSettings>` and
`queues: Map<string, QueueState>`. Queue creation is lazy — the first
`fetch`/`fetchStream` call for a given name triggers `getOrCreateQueue(name)`:

1. Look up `settings.get(queueName)` (may be absent).
2. Merge with `FALLBACK_LIMITS = { rpm: 30, tpm: null, rpd: null, concurrent: 5 }`.
3. Construct a `QueueState` with the merged config and store it.

**Settings are snapshotted at creation.** Calling `configureQueue(name, settings)`
after the queue exists throws `"settings are immutable"`. To reconfigure, call
`dropQueue(name)` first (in-flight requests continue; the next call creates a
fresh queue).

`QueueSettings` has three sub-objects:
- `limits?: Partial<RateLimiterConfig>` — rpm, tpm, rpd, concurrent
- `retry?: Partial<RetryConfig>` — maxRetries, backoff, per-kind overrides
- `queue?: Partial<QueueConfig>` — maxSize (default 200), timeoutMs (default 30 s)

## Data flow: `engine.fetch(req, opts?)`

```text
engine.fetch(req, opts?)
  resolveQueueName(req, opts)         // opts.queueName > opts.ctx.queueName > "${provider}/${model}"
  getOrCreateQueue(name)              // lazy init
  QueueState.submit(req, priority, estimatedTokens)
    emit onEnqueue (sync)
    ensureProcessing()                // start processLoop if not running
    RequestQueue.enqueue(...)         // returns Promise<HttpResponse>
      push into min-heap (priority, then FIFO by enqueuedAt)
      set deadline = now + timeoutMs
```

**processLoop** (runs until queue is empty):
1. `await queue.waitForItem()` — blocks on a waiter list when heap is empty.
2. `queue.dequeue()` — `purgeExpired()` fires first; expired entries are rejected.
3. Emit `onDequeue` (sync).
4. `rateLimiter.waitTimeMs(estimatedTokens)` — if > 0 and would exceed deadline,
   emit `onQueueTimeout` and reject. Otherwise `await sleep(waitMs)`.
5. `rateLimiter.canProceed(estimatedTokens)` — consumes RPM + RPD + TPM tokens.
6. `await semaphore.acquire()` — blocks if `inFlight >= concurrent`.
7. Spawn `executeWithRetry(entry)` (fire-and-forget; loop continues immediately).

**executeWithRetry(entry)**:
1. Emit `onRequestStart` (async). If handler sets `startCtx.abort = true`:
   release semaphore, reject the entry.
2. `executeOnce(req)` — wraps `fetchFn(url, init)` in an `AbortController` with
   per-attempt timeout (`req.timeout ?? retry.attemptTimeoutMs`, default 600 s).
   Body encoding: `rawBody=true` passes through as-is; string body passes through;
   otherwise `JSON.stringify`.
3. `rateLimiter.updateFromHeaders(resHeaders)` — ingests
   `x-ratelimit-remaining-requests` and `x-ratelimit-remaining-tokens`.
4. Emit `onRequestComplete` (async). Bump `processed`.
5. If `response.ok`: `parseResponseBody(response, responseType)`, release semaphore,
   resolve the entry.
6. On HTTP error: `classifyError(provider, status, body, headers)` → `LLMError`.
   - 429: `rateLimiter.pause(retryAfterMs)`, emit `onRateLimitHit`.
   - Call `handleRetry(entry, error, ...)`.
7. On thrown error (network, AbortError):
   - `DOMException.AbortError` → `kind: 'timeout'`; other → `kind: 'network'`.
   - Call `handleRetry(entry, error, ...)`.

**handleRetry**:
- Resolves `maxRetries` and `retryable` from `retry.perKind[error.kind]` with
  fallback to top-level defaults.
- `willRetry = isRetryable && attempt < maxRetries && elapsed < totalTimeoutMs`.
- Emit `onModelError` (async, always).
- If retrying: calculate backoff (priority: `error.retryAfterMs` > `fixedBackoffMs`
  > exponential-with-jitter), emit `onRetry` (sync), then:
  ```
  setTimeout(() => {
    queue.enqueue(req, Priority.RETRY, estimatedTokens, attempt + 1)
      .then(entry.resolve, entry.reject);
    ensureProcessing();
  }, backoffMs)
  ```
  Re-enqueued retries use `Priority.RETRY = 0` (highest priority) to prevent
  starvation.
- If not retrying: `entry.reject(error)`.

**settleOnWorkerCrash** (`src/network/queue-state.ts:232`): if `executeWithRetry`
itself throws from the pre-`try` setup (before the semaphore is managed), a
fire-and-forget call to `settleOnWorkerCrash` releases the semaphore, emits
`onInternalError`, and rejects the entry. This prevents a permanent deadlock.

## Data flow: `engine.fetchStream(req, opts?)`

Streaming bypasses the queue heap entirely. `QueueState.submitStream` calls:
1. `waitForCapacity(estimatedTokens)` — rate-limiter check (no semaphore yet).
2. `semaphore.acquire()`.
3. Emit `onRequestStart` (async).
4. `executeOnce(req)` → `Response`.
5. `rateLimiter.updateFromHeaders(resHeaders)`.
6. Emit `onRequestComplete` (async). Bump `processed`.
7. If `!response.ok`: classify error, emit `onRateLimitHit` or `onModelError`, throw.
8. `parseSSEStream(response.body)` → `AsyncIterable<SSEEvent>`. For each event,
   emit `onStreamChunk` (sync), then yield to caller.
9. `finally`: `semaphore.release()`.

Streaming is **never retried** — a partial stream cannot be safely replayed.
Errors surface immediately. `processLoop` is not involved.

## SSE parser (`src/network/sse.ts`)

`parseSSEStream(body: ReadableStream<Uint8Array>)` is a shared implementation
used by all providers (no per-provider parsing). It:
- Uses `TextDecoder` with `{ stream: true }` for incremental decoding.
- Splits on `\n\n`, `\r\n\r\n`, or `\r\r` (RFC 8895 line endings).
- Parses each block field-by-field: `event:`, `id:`, `data:`. Lines starting
  with `:` are SSE comments and are ignored.
- Drops frames where `data === '[DONE]'` (OpenAI terminator) or where no `data`
  field was present.
- Flushes the leftover `buffer` after the stream ends.

## Rate limiter (`src/network/rate-limiter.ts`)

`RateLimiter` composes up to three `TokenBucket` instances keyed by dimension:

```ts
class TokenBucket {
  tryConsume(n = 1): boolean         // consume if available, else return false
  waitTimeMs(n = 1): number          // ceil(deficit / refillRate)
  setRemaining(remaining: number)    // from x-ratelimit-remaining-* header
  setCapacity(capacity: number)      // from x-ratelimit-limit-* header
  drainUntil(resetAt: number)        // tokens=0, lastRefill=resetAt (pause)
  get available(): number
}
```

`TokenBucket` uses **lazy refill**: `refill()` runs on every `tryConsume` /
`waitTimeMs` call and computes `tokens += elapsed * refillRate`. RPM bucket:
`refillIntervalMs = 60_000 / rpm`; RPD bucket: `86_400_000 / rpd`.

`RateLimiter` methods:
- `canProceed(estimatedTokens)` — `tryConsume(1)` on each non-null bucket; also
  `tryConsume(estimatedTokens)` on TPM if provided. Returns false (but still
  consumes RPM + RPD) if TPM fails.
- `waitTimeMs(estimatedTokens)` — `max(rpmWait, rpdWait, tpmWait)`.
- `updateFromHeaders(headers)` — reads `x-ratelimit-remaining-requests`,
  `x-ratelimit-limit-requests`, `x-ratelimit-remaining-tokens`,
  `x-ratelimit-limit-tokens` and calls `setCapacity` / `setRemaining`.
- `pause(durationMs)` — calls `rpmBucket.drainUntil(now + durationMs)` on 429.

## Semaphore (`src/network/semaphore.ts`)

A counting semaphore. `acquire()` resolves immediately when `current < max`,
else queues a resolve function in `waiters[]`. `release()` decrements `current`;
if there are waiters, it dequeues one and increments `current` again (net-zero on
the counter). Exposed getters: `inFlight`, `waiting`, `available`.

## RequestQueue (`src/network/request-queue.ts`)

A **priority min-heap** (binary heap). Comparison: lower `priority` first;
ties broken by `enqueuedAt` (FIFO within same priority). Operations:
- `enqueue(req, priority, estimatedTokens, attempt)` — returns a
  `Promise<HttpResponse>` settled by `entry.resolve` / `entry.reject`.
- `dequeue()` — calls `purgeExpired()` first, then `pop()` from heap root.
- `purgeExpired()` — linear scan; rebuilds heap after removing expired entries
  (via `sinkDown` from the middle). Expired entries are `reject`-ed.
- `waitForItem()` — returns immediately if `length > 0`, else returns a Promise
  pushed onto `drainWaiters[]` and resolved on next `enqueue`.

`QueueEntry` fields: `id` (UUID), `request`, `priority`, `enqueuedAt`,
`deadline` (`enqueuedAt + timeoutMs`), `estimatedTokens`, `attempt`,
`resolve`, `reject`.

## Retry configuration (`src/network/queue-state-config.ts`)

```ts
const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 2,
  totalTimeoutMs: 120_000,
  attemptTimeoutMs: 600_000,
  backoff: { initialMs: 500, maxMs: 8_000, multiplier: 2, jitter: 0.25 },
  perKind: {
    rate_limit: { retryable: true, maxRetries: 5 },
    server_error: { retryable: true, maxRetries: 2 },
    timeout:      { retryable: true, maxRetries: 2 },
    network:      { retryable: true, maxRetries: 2 },
    context_overflow: { retryable: false },
    auth:          { retryable: false },
    invalid_request: { retryable: false },
    model_not_found: { retryable: false },
    quota_exceeded:  { retryable: false },
    content_filter:  { retryable: false },
    unsupported:     { retryable: false },
  },
};
```

Backoff formula: `base = min(initialMs * multiplier^attempt, maxMs)`;
jitter: `base * (1 - (random * jitter * 2 - jitter))` with `jitter=0.25`
giving ±25% spread. `error.retryAfterMs` (from `Retry-After` header) beats all.

Priority constants:
```ts
Priority = { RETRY: 0, INTERACTIVE: 1, BACKGROUND: 2, LOW: 3 }
```

## Error taxonomy (`src/network/errors.ts`)

`classifyError(provider, status, body, headers)` maps HTTP status + body to
`LLMError` with `kind: ErrorKind`:

| Status | ErrorKind |
|--------|-----------|
| 401, 403 | `auth` |
| 429 | `rate_limit` (retryable; parses `Retry-After-Ms` or `Retry-After`) |
| 400 (context/token msg) | `context_overflow` |
| 400 (unknown model) | `model_not_found` |
| 400 (unsupported) | `unsupported` |
| 400 (other) | `invalid_request` |
| 402, 413 | `quota_exceeded` |
| 5xx | `server_error` (retryable) |
| AbortError | `timeout` |
| Thrown non-LLMError | `network` |

`LLMError` fields: `message`, `kind`, `provider`, `status?`, `retryable`,
`retryAfterMs?`, `raw?`.

## Realtime WebSocket (`src/network/realtime-connection.ts`)

`engine.connect(req: WsRequest): RealtimeConnection` is a **sibling primitive**
to `fetch`, NOT routed through a `QueueState`. Persistent duplex sockets have
no per-call retry or rate-limit semantics.

`RealtimeConnectionImpl` wraps a `RealtimeSocket` (minimal WHATWG shape,
injectable for tests):
- `addEventListener` on `open`, `message`, `close`, `error`.
- `handleMessage` calls `normalizeFrame(ev.data)`: `string` → `{ text }`;
  `ArrayBuffer` / typed-array → `{ binary: Uint8Array }`.
- Four `Set<cb>` fan-out lists: `messageCbs`, `openCbs`, `closeCbs`, `errorCbs`.
- `on(type, cb)` returns an unsubscribe function.
- Hook emission: `onRealtimeOpen`, `onRealtimeFrame` (direction + kind + bytes,
  NOT payload), `onRealtimeClose`, `onRealtimeError`. All fire-and-forget
  (`hooks.emit(...).catch(() => {})`).

`WsRequest` fields: `url`, `protocols?`, `headers?`, `provider`, `model`.
The default `ConnectFn` wraps `globalThis.WebSocket`. When `headers` are needed
(non-browser: Node `ws`, Bun) it uses the extended constructor
`new WS(url, { protocols, headers })`; browsers use subprotocol or query-param auth.

## Extension points

- **Custom queue settings** — `engine.configureQueue(name, { limits, retry, queue })`
  before first use of that name.
- **Custom fetch** — pass `fetch` in `NetworkEngineConfig`.
- **Custom WebSocket factory** — pass `connect` in `NetworkEngineConfig`.
- **Observability** — subscribe on `engine.hooks` (a `HookBus`). All network
  events carry `TraceContext`.
- **Adding a new hook** — add the context type to `HookMap` in
  `src/bus/hook-map.ts`, then call `hooks.emitSync` or `hooks.emit` in the
  appropriate point in `QueueState` or `RealtimeConnectionImpl`.

## Key invariants

- All SDK HTTP traffic goes through `engine.fetch`/`fetchStream`. Direct
  `fetch()` calls anywhere else are a bug.
- Queue settings are immutable after first use; `dropQueue` + re-configure to
  change at runtime.
- `settleOnWorkerCrash` ensures the queue can never deadlock if the worker
  throws before releasing the semaphore.
- Streaming requests are never retried.
- `emitSync` is used on hot-path events (`onEnqueue`, `onDequeue`, `onStreamChunk`,
  `onRetry`, `onRateLimitUpdate`, `onStreamChunk`). `emit` (async, awaited) is
  used where a handler may set control flags (`onRequestStart.abort`).
- `inFlight` gauge is strictly maintained: every `semaphore.acquire()` is paired
  with a `semaphore.release()` in `finally` blocks or `settleOnWorkerCrash`.

## Cross-environment behavior

`src/network/` imports only `globalThis.fetch` and `globalThis.WebSocket` —
both available in Node 22+, Bun, and browsers. No `node:` imports anywhere.
The SSE parser reads `response.body` as a `ReadableStream<Uint8Array>`, which
is WHATWG-standard. `performance.now()` and `crypto.randomUUID()` are also
standard globals. Tests inject `fetch` and `connect` stubs via `NetworkEngineConfig`.
