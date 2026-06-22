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
  perKind?: Partial<Record<ErrorKind, ErrorRetryConfig>>;
}

export interface BackoffConfig {
  initialMs: number;
  maxMs: number;
  multiplier: number;
  jitter: number;
}

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
  retry?: Partial<RetryConfig>;
  queue?: Partial<QueueConfig>;
}

export const Priority = {
  RETRY: 0,
  INTERACTIVE: 1,
  BACKGROUND: 2,
  LOW: 3,
} as const;

export function mergeRetry(overrides?: Partial<RetryConfig>): RetryConfig {
  return {
    ...DEFAULT_RETRY,
    ...overrides,
    backoff: { ...DEFAULT_RETRY.backoff, ...overrides?.backoff },
    perKind: { ...DEFAULT_RETRY.perKind, ...overrides?.perKind },
  };
}
