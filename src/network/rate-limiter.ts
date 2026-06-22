/** Token bucket rate limiter for RPM/TPM/RPD tracking. */

import { parseIntHeader } from '../util/http';

export interface TokenBucketConfig {
  /** Max tokens in bucket (e.g. 60 for 60 RPM). */
  capacity: number;
  /** Refill interval in ms. For RPM: 60_000 / capacity. */
  refillIntervalMs: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private capacity: number;
  private refillRate: number; // tokens per ms

  constructor(config: TokenBucketConfig) {
    this.capacity = config.capacity;
    this.tokens = config.capacity;
    this.lastRefill = performance.now();
    this.refillRate = 1 / config.refillIntervalMs;
  }

  /** Try to consume n tokens. Returns true if successful. */
  tryConsume(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** How long to wait (ms) until n tokens are available. 0 if available now. */
  waitTimeMs(n = 1): number {
    this.refill();
    if (this.tokens >= n) return 0;
    const deficit = n - this.tokens;
    return Math.ceil(deficit / this.refillRate);
  }

  /** Force-set tokens remaining (e.g. from rate limit headers). */
  setRemaining(remaining: number): void {
    this.tokens = Math.min(remaining, this.capacity);
    this.lastRefill = performance.now();
  }

  /** Update capacity (e.g. discovered from headers). */
  setCapacity(capacity: number): void {
    this.capacity = capacity;
    this.refillRate = capacity / 60_000; // assume per-minute
    if (this.tokens > capacity) this.tokens = capacity;
  }

  /** Pause until a specific timestamp (e.g. from retry-after/reset headers). */
  drainUntil(resetAt: number): void {
    const now = performance.now();
    if (resetAt > now) {
      this.tokens = 0;
      this.lastRefill = resetAt; // no refill until reset time
    }
  }

  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = performance.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

export interface RateLimiterConfig {
  rpm: number | null;
  tpm: number | null;
  rpd: number | null;
  concurrent: number;
}

/** Composite rate limiter managing RPM + TPM + RPD buckets. */
export class RateLimiter {
  private rpmBucket: TokenBucket | null;
  private tpmBucket: TokenBucket | null;
  private rpdBucket: TokenBucket | null;

  constructor(config: RateLimiterConfig) {
    this.rpmBucket = config.rpm
      ? new TokenBucket({ capacity: config.rpm, refillIntervalMs: 60_000 / config.rpm })
      : null;
    this.tpmBucket = config.tpm
      ? new TokenBucket({ capacity: config.tpm, refillIntervalMs: 60_000 / config.tpm })
      : null;
    this.rpdBucket = config.rpd
      ? new TokenBucket({ capacity: config.rpd, refillIntervalMs: 86_400_000 / config.rpd })
      : null;
  }

  /** Check if a request with estimated tokens can proceed now. */
  canProceed(estimatedTokens = 0): boolean {
    if (this.rpmBucket && !this.rpmBucket.tryConsume(1)) return false;
    if (this.rpdBucket && !this.rpdBucket.tryConsume(1)) return false;
    if (this.tpmBucket && estimatedTokens > 0 && !this.tpmBucket.tryConsume(estimatedTokens))
      return false;
    return true;
  }

  /** How long to wait before a request can proceed (ms). */
  waitTimeMs(estimatedTokens = 0): number {
    let maxWait = 0;
    if (this.rpmBucket) maxWait = Math.max(maxWait, this.rpmBucket.waitTimeMs(1));
    if (this.rpdBucket) maxWait = Math.max(maxWait, this.rpdBucket.waitTimeMs(1));
    if (this.tpmBucket && estimatedTokens > 0)
      maxWait = Math.max(maxWait, this.tpmBucket.waitTimeMs(estimatedTokens));
    return maxWait;
  }

  /** Update state from provider response headers. */
  updateFromHeaders(headers: Record<string, string>): void {
    const remainReq = parseIntHeader(headers, 'x-ratelimit-remaining-requests');
    const limitReq = parseIntHeader(headers, 'x-ratelimit-limit-requests');
    const remainTok = parseIntHeader(headers, 'x-ratelimit-remaining-tokens');
    const limitTok = parseIntHeader(headers, 'x-ratelimit-limit-tokens');

    if (this.rpmBucket) {
      if (limitReq !== null) this.rpmBucket.setCapacity(limitReq);
      if (remainReq !== null) this.rpmBucket.setRemaining(remainReq);
    }
    if (this.tpmBucket) {
      if (limitTok !== null) this.tpmBucket.setCapacity(limitTok);
      if (remainTok !== null) this.tpmBucket.setRemaining(remainTok);
    }
  }

  /** Mark as rate-limited for a duration (from 429 + retry-after). */
  pause(durationMs: number): void {
    const resetAt = performance.now() + durationMs;
    this.rpmBucket?.drainUntil(resetAt);
  }

  get rpmAvailable(): number {
    return this.rpmBucket?.available ?? Number.POSITIVE_INFINITY;
  }
  get tpmAvailable(): number {
    return this.tpmBucket?.available ?? Number.POSITIVE_INFINITY;
  }
}
