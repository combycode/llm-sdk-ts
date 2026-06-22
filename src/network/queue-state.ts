/** QueueState — owns queue + rate limiter + semaphore + retry for ONE queue.
 *
 *  This is the per-queue body that NetworkEngine creates lazily. Today's
 *  llm-sdk packed all this inside ProviderExecutor (one executor per LLMClient,
 *  hence one queue per LLMClient); we extract it so a single NetworkEngine
 *  can host many queues keyed by `queueName` (e.g. "anthropic/claude-3-5",
 *  "openai/gpt-4o", "shared/cheap"). */

import type { HookBus } from '../bus/hook-bus';
import { sleep } from '../util/async';
import { anySignal, headersToRecord, parseIntHeader, parseResponseBody } from '../util/http';
import { LLMError, classifyError } from './errors';
import { Priority, mergeRetry } from './queue-state-config';
import type { ErrorRetryConfig, QueueStateConfig, RetryConfig } from './queue-state-config';
import { RateLimiter } from './rate-limiter';
import { type QueueEntry, RequestQueue } from './request-queue';
import { Semaphore } from './semaphore';
import { parseSSEStream } from './sse';
import type { FetchFn, HttpRequest, HttpResponse, SSEEvent } from './types';

/** Telemetry body size — null-safe. A body-less request (GET/HEAD/DELETE) has
 *  `body === undefined`; `JSON.stringify(undefined)` is `undefined`, so the naive
 *  `.length` would throw. Returns 0 for no body. */
function bodySizeOf(body: unknown): number {
  return body == null ? 0 : JSON.stringify(body).length;
}

// ─── QueueState ─────────────────────────────────────────────────────────

export class QueueState {
  readonly queueName: string;
  private readonly fetchFn: FetchFn;
  private readonly hooks: HookBus;
  private readonly rateLimiter: RateLimiter;
  private readonly semaphore: Semaphore;
  private readonly queue: RequestQueue;
  private readonly retry: RetryConfig;
  private running = false;
  /** Lifetime HTTP round-trips completed (bumped on each onRequestComplete). */
  private processed = 0;
  /** Greatest depth ever observed (raised on enqueue). */
  private peakDepth = 0;

  constructor(config: QueueStateConfig) {
    this.queueName = config.queueName;
    this.fetchFn = config.fetch;
    this.hooks = config.hooks;
    this.retry = mergeRetry(config.retry);
    this.rateLimiter = new RateLimiter(config.limits);
    this.semaphore = new Semaphore(config.limits.concurrent);
    this.queue = new RequestQueue(config.queue);
  }

  /** Point-in-time numeric state — depth, in-flight, rate-limit pressure. */
  snapshot(): import('./types').QueueSnapshot {
    return {
      queueName: this.queueName,
      depth: this.queue.length,
      inFlight: this.semaphore.inFlight,
      waiting: this.semaphore.waiting,
      rateLimitWaitMs: this.rateLimiter.waitTimeMs(1),
      running: this.running,
      processed: this.processed,
      peakDepth: this.peakDepth,
    };
  }

  /** Submit a request. Returns when the request completes (may wait in queue). */
  async submit(
    req: HttpRequest,
    priority: number = Priority.INTERACTIVE,
    estimatedTokens = 0,
  ): Promise<HttpResponse> {
    const depth = this.queue.length + 1;
    if (depth > this.peakDepth) this.peakDepth = depth;
    this.hooks.emitSync('onEnqueue', {
      provider: req.provider,
      model: req.model,
      queueName: this.queueName,
      priority,
      queueLength: depth,
      estimatedTokens,
      trace: req.trace,
    });

    this.ensureProcessing();
    return this.queue.enqueue(req, priority, estimatedTokens, 0);
  }

  /** Submit a streaming request. Yields SSE events. */
  async *submitStream(
    req: HttpRequest,
    _priority: number = Priority.INTERACTIVE,
    estimatedTokens = 0,
  ): AsyncIterable<SSEEvent> {
    await this.waitForCapacity(estimatedTokens);
    await this.semaphore.acquire();

    const idempotencyKey = crypto.randomUUID();

    const startCtx: import('../bus/hook-map').RequestStartContext = {
      provider: req.provider,
      model: req.model,
      queueName: this.queueName,
      url: req.url,
      method: req.method ?? 'POST',
      bodySize: bodySizeOf(req.body),
      attempt: 0,
      idempotencyKey,
      streaming: true,
      trace: req.trace,
    };
    await this.hooks.emit('onRequestStart', startCtx);
    if (startCtx.abort) {
      this.semaphore.release();
      throw new LLMError('Request aborted by hook', 'invalid_request', req.provider);
    }

    const start = performance.now();
    try {
      const response = await this.executeOnce(req);
      const latencyMs = performance.now() - start;
      const resHeaders = headersToRecord(response.headers);
      this.rateLimiter.updateFromHeaders(resHeaders);

      await this.hooks.emit('onRequestComplete', {
        provider: req.provider,
        model: req.model,
        queueName: this.queueName,
        status: response.status,
        headers: resHeaders,
        latencyMs,
        attempt: 0,
        bodySize: 0,
        streaming: true,
        trace: req.trace,
      });
      this.processed++;

      if (!response.ok) {
        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = null;
        }
        const error = classifyError(req.provider, response.status, errorBody, resHeaders);
        await this.emitErrorHooks(req, error, resHeaders, 0);
        throw error;
      }

      if (!response.body) throw new LLMError('No response body', 'server_error', req.provider);

      let chunkIndex = 0;
      for await (const event of parseSSEStream(response.body)) {
        this.hooks.emitSync('onStreamChunk', {
          provider: req.provider,
          model: req.model,
          queueName: this.queueName,
          chunkIndex: chunkIndex++,
          raw: event,
          trace: req.trace,
        });
        yield event;
      }
    } finally {
      this.semaphore.release();
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private ensureProcessing(): void {
    if (this.running) return;
    this.running = true;
    this.processLoop().catch(() => {
      this.running = false;
    });
  }

  private async processLoop(): Promise<void> {
    while (true) {
      await this.queue.waitForItem();
      const entry = this.queue.dequeue();
      if (!entry) {
        this.running = false;
        return;
      }

      this.hooks.emitSync('onDequeue', {
        provider: entry.request.provider,
        model: entry.request.model,
        queueName: this.queueName,
        waitedMs: performance.now() - entry.enqueuedAt,
        queueLength: this.queue.length,
        trace: entry.request.trace,
      });

      const waitMs = this.rateLimiter.waitTimeMs(entry.estimatedTokens);
      if (waitMs > 0) {
        if (performance.now() + waitMs > entry.deadline) {
          this.hooks.emitSync('onQueueTimeout', {
            provider: entry.request.provider,
            model: entry.request.model,
            queueName: this.queueName,
            waitedMs: performance.now() - entry.enqueuedAt,
            deadline: entry.deadline,
          });
          entry.reject(
            new LLMError(
              `Rate limited, wait ${waitMs}ms would exceed queue timeout`,
              'rate_limit',
              entry.request.provider,
            ),
          );
          continue;
        }
        await sleep(waitMs);
      }

      this.rateLimiter.canProceed(entry.estimatedTokens);
      await this.semaphore.acquire();
      this.executeWithRetry(entry).catch((e) => this.settleOnWorkerCrash(entry, e));
    }
  }

  /** Last-resort safety net: executeWithRetry settles every entry itself, but if
   *  it ever throws from its pre-`try` setup (before releasing the semaphore),
   *  the entry's promise would otherwise NEVER settle — a silent hang. Release
   *  the slot so the queue can't deadlock, surface the bug via the existing error
   *  hook (V1 telemetry), and reject the caller so it fails fast and visibly. */
  private settleOnWorkerCrash(entry: QueueEntry, e: unknown): void {
    this.semaphore.release();
    const error =
      e instanceof LLMError
        ? e
        : new LLMError(
            `Queue worker crashed (would have hung): ${(e as Error)?.message ?? String(e)}`,
            'server_error',
            entry.request.provider,
          );
    // An internal invariant broke — this is the SDK's own bug, NOT a provider
    // error, so it gets its own channel (onInternalError), never onModelError.
    // Best-effort: a faulty subscriber must not crash the process or block the
    // settlement, so the emit is fire-and-forget with its own catch. The entry
    // is rejected regardless.
    void this.hooks
      .emit('onInternalError', {
        source: 'queue',
        error,
        queueName: this.queueName,
        provider: entry.request.provider,
      })
      .catch(() => {});
    entry.reject(error);
  }

  private async executeWithRetry(entry: QueueEntry): Promise<void> {
    const startTime = performance.now();
    const idempotencyKey = crypto.randomUUID();

    const startCtx: import('../bus/hook-map').RequestStartContext = {
      provider: entry.request.provider,
      model: entry.request.model,
      queueName: this.queueName,
      url: entry.request.url,
      method: entry.request.method ?? 'POST',
      bodySize: bodySizeOf(entry.request.body),
      attempt: entry.attempt,
      idempotencyKey,
      streaming: false,
      trace: entry.request.trace,
    };
    await this.hooks.emit('onRequestStart', startCtx);
    if (startCtx.abort) {
      this.semaphore.release();
      entry.reject(
        new LLMError('Request aborted by hook', 'invalid_request', entry.request.provider),
      );
      return;
    }

    try {
      const response = await this.executeOnce(entry.request);
      const latencyMs = performance.now() - startTime;
      const resHeaders = headersToRecord(response.headers);
      this.rateLimiter.updateFromHeaders(resHeaders);
      this.emitRateLimitUpdate(entry.request, resHeaders, 'response_headers');

      await this.hooks.emit('onRequestComplete', {
        provider: entry.request.provider,
        model: entry.request.model,
        queueName: this.queueName,
        status: response.status,
        headers: resHeaders,
        latencyMs,
        attempt: entry.attempt,
        bodySize: 0,
        streaming: false,
        trace: entry.request.trace,
      });
      this.processed++;

      if (response.ok) {
        const body = await parseResponseBody(response, entry.request.responseType ?? 'json');
        this.semaphore.release();
        entry.resolve({ status: response.status, headers: resHeaders, body });
        return;
      }

      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = null;
      }
      const error = classifyError(entry.request.provider, response.status, errorBody, resHeaders);

      if (error.kind === 'rate_limit') {
        if (error.retryAfterMs) this.rateLimiter.pause(error.retryAfterMs);
        this.emitRateLimitUpdate(entry.request, resHeaders, 'rate_limit_error');

        await this.hooks.emit('onRateLimitHit', {
          provider: entry.request.provider,
          model: entry.request.model,
          queueName: this.queueName,
          status: response.status,
          retryAfterMs: error.retryAfterMs ?? null,
          headers: resHeaders,
          remainingRequests: parseIntHeader(resHeaders, 'x-ratelimit-remaining-requests'),
          remainingTokens: parseIntHeader(resHeaders, 'x-ratelimit-remaining-tokens'),
          limitRequests: parseIntHeader(resHeaders, 'x-ratelimit-limit-requests'),
          limitTokens: parseIntHeader(resHeaders, 'x-ratelimit-limit-tokens'),
          trace: entry.request.trace,
        });
      }

      this.semaphore.release();
      this.handleRetry(entry, error, startTime, idempotencyKey);
    } catch (e) {
      this.semaphore.release();

      if (e instanceof LLMError) {
        this.handleRetry(entry, e, startTime, idempotencyKey);
        return;
      }

      const isTimeout = e instanceof DOMException && e.name === 'AbortError';
      const error = new LLMError(
        String(e),
        isTimeout ? 'timeout' : 'network',
        entry.request.provider,
        undefined,
        true,
      );
      this.handleRetry(entry, error, startTime, idempotencyKey);
    }
  }

  private handleRetry(
    entry: QueueEntry,
    error: LLMError,
    startTime: number,
    idempotencyKey: string,
  ): void {
    const kindConfig = this.retry.perKind?.[error.kind];
    const isRetryable = kindConfig?.retryable ?? error.retryable;
    const maxRetries = kindConfig?.maxRetries ?? this.retry.maxRetries;
    const elapsed = performance.now() - startTime;
    const withinBudget = elapsed < this.retry.totalTimeoutMs;
    const willRetry = isRetryable && entry.attempt < maxRetries && withinBudget;

    void this.hooks.emit('onModelError', {
      provider: entry.request.provider,
      model: entry.request.model,
      queueName: this.queueName,
      error,
      headers: {},
      attempt: entry.attempt,
      willRetry,
      trace: entry.request.trace,
    });

    if (willRetry) {
      const backoffMs = this.calculateBackoff(entry.attempt, error, kindConfig);

      this.hooks.emitSync('onRetry', {
        provider: entry.request.provider,
        model: entry.request.model,
        queueName: this.queueName,
        attempt: entry.attempt + 1,
        backoffMs,
        reason: error.kind,
        idempotencyKey,
        trace: entry.request.trace,
      });

      setTimeout(() => {
        this.queue
          .enqueue(entry.request, Priority.RETRY, entry.estimatedTokens, entry.attempt + 1)
          .then(entry.resolve, entry.reject);
        this.ensureProcessing();
      }, backoffMs);
    } else {
      entry.reject(error);
    }
  }

  private calculateBackoff(
    attempt: number,
    error: LLMError,
    kindConfig?: ErrorRetryConfig,
  ): number {
    if (error.retryAfterMs) return error.retryAfterMs;
    if (kindConfig?.fixedBackoffMs) return kindConfig.fixedBackoffMs;

    const { initialMs, maxMs, multiplier, jitter } = this.retry.backoff;
    const base = Math.min(initialMs * multiplier ** attempt, maxMs);
    const j = 1 - (Math.random() * jitter * 2 - jitter);
    return Math.round(base * j);
  }

  private async executeOnce(req: HttpRequest): Promise<Response> {
    const controller = new AbortController();
    const timeout = req.timeout ?? this.retry.attemptTimeoutMs;
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const signal = req.signal ? anySignal(req.signal, controller.signal) : controller.signal;

    try {
      const init: RequestInit = {
        method: req.method ?? 'POST',
        headers: req.headers,
        signal,
      };
      // GET / DELETE requests have no body. Otherwise: pass through raw bytes
      // when rawBody=true (multipart, binary uploads), else JSON.stringify.
      const method = init.method?.toUpperCase();
      if (req.body !== undefined && method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
        init.body = req.rawBody
          ? (req.body as BodyInit)
          : typeof req.body === 'string'
            ? req.body
            : JSON.stringify(req.body);
      }
      return await this.fetchFn(req.url, init);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async waitForCapacity(estimatedTokens: number): Promise<void> {
    const waitMs = this.rateLimiter.waitTimeMs(estimatedTokens);
    if (waitMs > 0) await sleep(waitMs);
    this.rateLimiter.canProceed(estimatedTokens);
  }

  private emitRateLimitUpdate(
    req: HttpRequest,
    headers: Record<string, string>,
    source: 'response_headers' | 'rate_limit_error',
  ): void {
    const rpmRemaining = parseIntHeader(headers, 'x-ratelimit-remaining-requests');
    const tpmRemaining = parseIntHeader(headers, 'x-ratelimit-remaining-tokens');
    if (rpmRemaining !== null || tpmRemaining !== null) {
      this.hooks.emitSync('onRateLimitUpdate', {
        provider: req.provider,
        queueName: this.queueName,
        source,
        rpmRemaining,
        tpmRemaining,
        rpmLimit: parseIntHeader(headers, 'x-ratelimit-limit-requests'),
        tpmLimit: parseIntHeader(headers, 'x-ratelimit-limit-tokens'),
        resetAt: null,
      });
    }
  }

  private async emitErrorHooks(
    req: HttpRequest,
    error: LLMError,
    headers: Record<string, string>,
    attempt: number,
  ): Promise<void> {
    if (error.kind === 'rate_limit') {
      await this.hooks.emit('onRateLimitHit', {
        provider: req.provider,
        model: req.model,
        queueName: this.queueName,
        status: error.status ?? 429,
        retryAfterMs: error.retryAfterMs ?? null,
        headers,
        remainingRequests: parseIntHeader(headers, 'x-ratelimit-remaining-requests'),
        remainingTokens: parseIntHeader(headers, 'x-ratelimit-remaining-tokens'),
        limitRequests: parseIntHeader(headers, 'x-ratelimit-limit-requests'),
        limitTokens: parseIntHeader(headers, 'x-ratelimit-limit-tokens'),
      });
    }
    await this.hooks.emit('onModelError', {
      provider: req.provider,
      model: req.model,
      queueName: this.queueName,
      error,
      headers,
      attempt,
      willRetry: false,
    });
  }
}

