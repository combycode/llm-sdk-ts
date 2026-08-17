/** Network layer shared types. */

export type FetchFn = typeof globalThis.fetch;

/** Request submitted to NetworkEngine. The semantic layer (LLMClient) sets
 *  `provider` and `model` purely for hook observability; the routing key is
 *  `queueName` (set by LLMClient via formula or RequestContext override). */
export interface HttpRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
  timeout?: number;
  signal?: AbortSignal;
  stream?: boolean;
  provider: string;
  model: string;
  /** How to parse the response body. Default 'json' (LLM responses, image-gen
   *  with b64_json, video-status JSON). Use 'arraybuffer' for binary downloads
   *  (TTS audio bytes, video file bytes). 'text' for plain-text responses.
   *  'stream' returns the raw `ReadableStream<Uint8Array>` body un-buffered (large
   *  file downloads that pipe straight to a sink). */
  responseType?: 'json' | 'arraybuffer' | 'text' | 'stream';
  /** When the request body is already a Uint8Array / ArrayBuffer (binary
   *  upload like multipart) the queue should NOT JSON.stringify it. Default
   *  false → body is JSON.stringify'd. */
  rawBody?: boolean;
  /** Trace correlation — set by the caller (LLM client / media op) from the
   *  RequestContext so every network event can echo `sessionId:requestId`. */
  trace?: TraceContext;
  /** Per-request retry overrides, applied over the queue's policy for THIS request only.
   *
   *  The queue's policy is shared by every call on it, so a one-off needing to be more (or less)
   *  patient — a long batch submit, a health check that should fail fast — previously had to accept
   *  the shared policy or get its own queue. Mirrors Google moving `retryOptions` from client-level
   *  to per-request `HttpOptions` (google-ts 2.15). */
  retry?: RequestRetryOverride;
}

/** The retry knobs a single request may override.
 *
 *  Deliberately a subset: `perKind` stays queue-level, because one request cannot sensibly redefine
 *  which error classes are retryable for the queue it shares with everyone else. */
export interface RequestRetryOverride {
  maxRetries?: number;
  totalTimeoutMs?: number;
  attemptTimeoutMs?: number;
  maxRetryAfterMs?: number;
  backoff?: Partial<{ initialMs: number; maxMs: number; multiplier: number; jitter: number }>;
}

/** Raw HTTP response (post-fetch, pre-provider-parse). */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** SSE event passed up from streaming response. */
export interface SSEEvent {
  event?: string;
  data: string;
  /** SSE `id:` field — used for resumption (Last-Event-ID). */
  id?: string;
}

/** Correlation ids carried on a request so network events can be stitched to the
 *  LLM call end-to-end. `sessionId:requestId` is the OTel trace id. */
export interface TraceContext {
  sessionId?: string;
  requestId?: string;
  callId?: string;
  /** W3C `traceparent` of the span this work runs UNDER, when the caller runs the SDK
   *  inside its own trace. It rides with the ids because every span we emit needs it,
   *  not only the ones built straight from a caller's RequestContext — an agent run
   *  reaches its tool calls and its nested agents through this object, and those were
   *  left rooting traces of their own while the LLM spans joined the caller's. */
  traceparent?: string;
}

/** Point-in-time numeric state of one queue (for metrics / observability). */
export interface QueueSnapshot {
  queueName: string;
  /** Requests queued, not yet started. */
  depth: number;
  /** Requests currently executing (semaphore held). */
  inFlight: number;
  /** Requests blocked waiting for a concurrency slot. */
  waiting: number;
  /** ms until the next request may proceed under the rate limit (0 = free now). */
  rateLimitWaitMs: number;
  /** Whether the queue's process loop is active. */
  running: boolean;
  /** Lifetime count of HTTP round-trips completed on this queue. A persistent
   *  counter so an idle queue still shows evidence of past activity (depth /
   *  inFlight are instantaneous and read 0 between bursts). */
  processed: number;
  /** High-water mark: the greatest depth this queue has reached. */
  peakDepth: number;
}

/** Per-call fetch options accepted by NetworkEngine.fetch / fetchStream.
 *  Re-declared here (vs. importing from engine.ts) to avoid a cycle when
 *  consumers (LLMClient) only need the function shape. */
export interface FetchOptionsLite {
  queueName?: string;
  priority?: number;
  estimatedTokens?: number;
  ctx?: Record<string, unknown>;
}

/** Function shape consumed by LLMClient. NetworkEngine.fetch.bind(engine)
 *  satisfies this; tests may provide simpler stubs. */
export type EngineFetch = (req: HttpRequest, options?: FetchOptionsLite) => Promise<HttpResponse>;

/** Streaming variant. */
export type EngineFetchStream = (
  req: HttpRequest,
  options?: FetchOptionsLite,
) => AsyncIterable<SSEEvent>;

// ─── Realtime transport (WebSocket) ──────────────────────────────────────
//
// Realtime is a persistent bidirectional socket, NOT request/response. It is
// engine-owned (auth, hooks, future cost) but queue-exempt — retry/rate-limit
// are meaningless for a live socket. `engine.connect` is the sibling primitive
// to `engine.fetch`.

/** A WebSocket open request. The semantic layer (a RealtimeProviderAdapter)
 *  builds `url` (including any `?key=` auth) and `protocols` (e.g. OpenAI's
 *  `openai-insecure-api-key.<key>` subprotocol). `provider`/`model` are carried
 *  for hook observability. */
export interface WsRequest {
  url: string;
  protocols?: string | string[];
  /** Header auth, where the underlying socket impl supports it (Node `ws`, Bun).
   *  Browsers cannot set WS headers — providers that must run in a browser use
   *  subprotocol or query-param auth instead. */
  headers?: Record<string, string>;
  provider: string;
  model: string;
}

/** Minimal WHATWG-WebSocket shape the engine depends on. Injectable so tests
 *  can supply a fake socket and the engine stays transport-agnostic. */
export interface RealtimeSocket {
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'close' | 'error' | 'message', cb: (ev: unknown) => void): void;
  readonly readyState: number;
}

/** Factory that opens a RealtimeSocket. Default wraps `globalThis.WebSocket`. */
export type ConnectFn = (
  url: string,
  opts?: { protocols?: string | string[]; headers?: Record<string, string> },
) => RealtimeSocket;

/** A normalized inbound frame surfaced to adapters: text or binary, never raw. */
export type RealtimeFrame = { text: string } | { binary: Uint8Array };

/** Engine-owned connection: normalized frames + lifecycle + hook emission.
 *  `on()` returns an unsubscribe function. */
export interface RealtimeConnection {
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  on(type: 'message', cb: (f: RealtimeFrame) => void): () => void;
  on(type: 'open' | 'close', cb: () => void): () => void;
  on(type: 'error', cb: (e: Error) => void): () => void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

/** Function shape consumed by RealtimeProviderAdapters. NetworkEngine.connect
 *  satisfies this. */
export type EngineConnect = (req: WsRequest) => RealtimeConnection;
