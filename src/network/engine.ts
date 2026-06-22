/** NetworkEngine — multi-queue HTTP router (Layer 1).
 *
 *  Holds a Map<queueName, QueueState>. Each queue has its own rate limiter,
 *  semaphore, retry policy, and request queue. Queues are created lazily on
 *  first use of a queueName, with default settings (or settings supplied via
 *  `configureQueue()` BEFORE first use — snapshot semantics).
 *
 *  Knows nothing about LLMs, providers, or models. The semantic layer
 *  (LLMClient) populates `req.provider` and `req.model` for hook payloads
 *  and decides `queueName` (default formula: "$provider/$model").
 *
 *  Public surface:
 *    - fetch(req, ctx?)        — submit a non-streaming request
 *    - fetchStream(req, ctx?)  — submit a streaming request (SSE)
 *    - configureQueue(name, settings) — pre-configure rate limit / retry
 *    - getQueueState(name)     — introspect a queue (for tests / metrics)
 *    - destroy()               — drop all queues (for teardown)
 */

import { HookBus } from '../bus/hook-bus';
import type { RequestContext } from '../types/request-context';
import type { RateLimiterConfig } from './rate-limiter';
import type { QueueConfig } from './request-queue';
import { QueueState } from './queue-state';
import { Priority } from './queue-state-config';
import type { QueueStateConfig, RetryConfig } from './queue-state-config';
import { RealtimeConnectionImpl } from './realtime-connection';
import type {
  ConnectFn,
  FetchFn,
  HttpRequest,
  HttpResponse,
  RealtimeConnection,
  RealtimeSocket,
  SSEEvent,
  WsRequest,
} from './types';

// ─── Defaults ───────────────────────────────────────────────────────────

/** Provider-known limit defaults. Keyed by `queueName` (LLMClient defaults
 *  to `"$provider/$model"`, so a bare provider name typically won't match —
 *  callers extend the engine with their own defaults via `configureQueue()`).
 *
 *  When a queue is created lazily and no specific settings exist, a fallback
 *  is used (see `FALLBACK_LIMITS`). */
const FALLBACK_LIMITS: RateLimiterConfig = {
  rpm: 30,
  tpm: null,
  rpd: null,
  concurrent: 5,
};

export interface QueueSettings {
  limits?: Partial<RateLimiterConfig>;
  retry?: Partial<RetryConfig>;
  queue?: Partial<QueueConfig>;
}

export interface NetworkEngineConfig {
  /** Bus to share with QueueStates so plugins can subscribe. Default: new HookBus(). */
  hooks?: HookBus;
  /** Default fetch function for all queues. Per-call override via ctx not supported
   *  (queue is bound to its fetch at creation). Default: globalThis.fetch. */
  fetch?: FetchFn;
  /** WebSocket factory for `connect()` (realtime). Default wraps globalThis.WebSocket.
   *  Injectable so tests supply a fake socket and the engine stays transport-agnostic. */
  connect?: ConnectFn;
  /** Pre-configured per-queue settings. Looked up by queueName at queue creation. */
  queues?: Record<string, QueueSettings>;
}

/** Optional context for fetch/fetchStream. RequestContext + per-call overrides. */
export interface FetchOptions {
  /** Routing key. If omitted, uses `req.provider/req.model` as fallback. */
  queueName?: string;
  priority?: number;
  estimatedTokens?: number;
  ctx?: Partial<RequestContext>;
}

// ─── NetworkEngine ──────────────────────────────────────────────────────

export class NetworkEngine {
  readonly hooks: HookBus;
  private readonly fetchFn: FetchFn;
  private readonly connectFn: ConnectFn;
  private readonly settings = new Map<string, QueueSettings>();
  private readonly queues = new Map<string, QueueState>();

  constructor(config?: NetworkEngineConfig) {
    this.hooks = config?.hooks ?? new HookBus();
    this.fetchFn = config?.fetch ?? globalThis.fetch.bind(globalThis);
    this.connectFn = config?.connect ?? defaultConnectFn;
    if (config?.queues) {
      for (const [name, settings] of Object.entries(config.queues)) {
        this.settings.set(name, settings);
      }
    }
  }

  /** Pre-configure (or reconfigure) a queue's settings.
   *  Throws if the queue already exists — settings are snapshotted at queue
   *  creation, so changes after that have no effect. To reconfigure an
   *  existing queue, call `dropQueue(name)` first. */
  configureQueue(queueName: string, settings: QueueSettings): void {
    if (this.queues.has(queueName)) {
      throw new Error(
        `NetworkEngine: queue "${queueName}" already created — settings are immutable. ` +
          `Call dropQueue("${queueName}") first to reconfigure.`,
      );
    }
    this.settings.set(queueName, settings);
  }

  /** Drop a queue (frees its state). In-flight requests on that queue continue
   *  but the next call with the same queueName creates a fresh queue. */
  dropQueue(queueName: string): void {
    this.queues.delete(queueName);
  }

  /** Whether a queue has been created. */
  hasQueue(queueName: string): boolean {
    return this.queues.has(queueName);
  }

  /** Names of all live queues. */
  queueNames(): string[] {
    return Array.from(this.queues.keys());
  }

  /** Get the underlying QueueState for a queueName (for tests / metrics).
   *  Returns null if not yet created. */
  getQueueState(queueName: string): QueueState | null {
    return this.queues.get(queueName) ?? null;
  }

  /** Numeric state of every live queue — for the States panel / metrics. */
  snapshot(): import('./types').QueueSnapshot[] {
    return Array.from(this.queues.values(), (q) => q.snapshot());
  }

  /** Submit a request. */
  async fetch(req: HttpRequest, options?: FetchOptions): Promise<HttpResponse> {
    const queueName = resolveQueueName(req, options);
    const queue = this.getOrCreateQueue(queueName);
    return queue.submit(
      req,
      options?.priority ?? Priority.INTERACTIVE,
      options?.estimatedTokens ?? 0,
    );
  }

  /** Submit a streaming request. Yields SSE events. */
  async *fetchStream(req: HttpRequest, options?: FetchOptions): AsyncIterable<SSEEvent> {
    const queueName = resolveQueueName(req, options);
    const queue = this.getOrCreateQueue(queueName);
    yield* queue.submitStream(
      req,
      options?.priority ?? Priority.INTERACTIVE,
      options?.estimatedTokens ?? 0,
    );
  }

  /** Open a realtime WebSocket connection. Engine-owned (auth via the request's
   *  protocols/headers, observability hooks) but QUEUE-EXEMPT: a persistent duplex
   *  socket has no per-call retry / rate-limit / idempotency, so it does not route
   *  through a QueueState. Sibling primitive to `fetch`. */
  connect(req: WsRequest): RealtimeConnection {
    const socket = this.connectFn(req.url, { protocols: req.protocols, headers: req.headers });
    return new RealtimeConnectionImpl({ socket, req, hooks: this.hooks });
  }

  /** Drop all queues. */
  destroy(): void {
    this.queues.clear();
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private getOrCreateQueue(queueName: string): QueueState {
    let queue = this.queues.get(queueName);
    if (queue) return queue;

    const settings = this.settings.get(queueName) ?? {};
    const limits: RateLimiterConfig = {
      ...FALLBACK_LIMITS,
      ...settings.limits,
    };

    const config: QueueStateConfig = {
      queueName,
      fetch: this.fetchFn,
      hooks: this.hooks,
      limits,
      retry: settings.retry,
      queue: settings.queue,
    };
    queue = new QueueState(config);
    this.queues.set(queueName, queue);
    return queue;
  }
}

function resolveQueueName(req: HttpRequest, options?: FetchOptions): string {
  if (options?.queueName) return options.queueName;
  if (options?.ctx?.queueName) return options.ctx.queueName;
  return `${req.provider}/${req.model}`;
}

/** Default WebSocket factory. Uses the WHATWG `WebSocket` global (present in Bun,
 *  Node 22+, and browsers). When `headers` are supplied we use Bun's extended
 *  options form (`new WebSocket(url, { protocols, headers })`); otherwise the
 *  standard 2-arg form (protocols positionally). Our shipping adapters use
 *  subprotocol (OpenAI) or query-param (Google) auth, so the header path is a
 *  convenience for custom adapters on runtimes that support it. */
const defaultConnectFn: ConnectFn = (url, opts) => {
  const WS = (globalThis as { WebSocket?: unknown }).WebSocket as
    | (new (
        url: string,
        options?: unknown,
      ) => RealtimeSocket)
    | undefined;
  if (!WS) {
    throw new Error(
      'NetworkEngine.connect: no global WebSocket available. Pass a `connect` factory to createEngine.',
    );
  }
  return opts?.headers
    ? new WS(url, { protocols: opts.protocols, headers: opts.headers })
    : new WS(url, opts?.protocols);
};
