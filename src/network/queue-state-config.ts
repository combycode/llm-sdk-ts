/** QueueState configuration: retry policy, queue priorities, and defaults. */

import type { HookBus } from '../bus/hook-bus';
import type { ErrorKind } from './errors';
import type { RateLimiterConfig } from './rate-limiter';
import type { QueueConfig } from './request-queue';
import type { FetchFn } from './types';

export interface RetryConfig {
  maxRetries: number;
  totalTimeoutMs: number;
  attemptTimeoutMs: number;
  backoff: BackoffConfig;
  /** Longest `Retry-After` we are willing to honour. A server asking us to wait longer than this
   *  does not get waited for: the request fails fast instead of parking in the queue, and the rate
   *  limiter is not paused for that long either. Without a cap, a single `Retry-After: 86400`
   *  silently holds a request — and the whole limiter — for a day. */
  maxRetryAfterMs: number;
  perKind?: Partial<Record<ErrorKind, ErrorRetryConfig>>;
}

export interface BackoffConfig {
  initialMs: number;
  maxMs: number;
  multiplier: number;
  jitter: number;
}

/** A retry policy stated as a partial override of another one.
 *
 *  `Partial<RetryConfig>` only makes the TOP-level keys optional, so it still demands a complete
 *  `backoff` object — which makes "override one knob, keep the rest" inexpressible even though the
 *  merge has always supported it. Engine-level and queue-level overrides take this instead. */
export type RetryPolicyOverride = Omit<Partial<RetryConfig>, 'backoff'> & {
  backoff?: Partial<BackoffConfig>;
};

export interface ErrorRetryConfig {
  retryable?: boolean;
  maxRetries?: number;
  fixedBackoffMs?: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 2,
  totalTimeoutMs: 120_000,
  attemptTimeoutMs: 600_000,
  backoff: { initialMs: 500, maxMs: 8_000, multiplier: 2, jitter: 0.25 },
  maxRetryAfterMs: 120_000,
  perKind: {
    rate_limit: { retryable: true, maxRetries: 5 },
    server_error: { retryable: true, maxRetries: 2 },
    timeout: { retryable: true, maxRetries: 2 },
    network: { retryable: true, maxRetries: 2 },
    context_overflow: { retryable: false },
    auth: { retryable: false },
    invalid_request: { retryable: false },
    model_not_found: { retryable: false },
    quota_exceeded: { retryable: false },
    content_filter: { retryable: false },
    unsupported: { retryable: false },
  },
};

export interface QueueStateConfig {
  /** Routing identifier this queue is registered under. Carried in hook payloads. */
  queueName: string;
  fetch: FetchFn;
  hooks: HookBus;
  limits: RateLimiterConfig;
  retry?: RetryPolicyOverride;
  queue?: Partial<QueueConfig>;
}

export const Priority = {
  RETRY: 0,
  INTERACTIVE: 1,
  BACKGROUND: 2,
  LOW: 3,
} as const;

export function mergeRetry(overrides?: RetryPolicyOverride): RetryConfig {
  return {
    ...DEFAULT_RETRY,
    ...overrides,
    backoff: { ...DEFAULT_RETRY.backoff, ...overrides?.backoff },
    perKind: { ...DEFAULT_RETRY.perKind, ...overrides?.perKind },
  };
}
