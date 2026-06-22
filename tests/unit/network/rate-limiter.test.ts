import { describe, expect, it } from 'bun:test';
import { RateLimiter, TokenBucket } from '../../../src/network/rate-limiter';

describe('TokenBucket', () => {
  it('starts full', () => {
    const bucket = new TokenBucket({ capacity: 10, refillIntervalMs: 1000 });
    expect(bucket.available).toBe(10);
  });

  it('tryConsume reduces tokens', () => {
    const bucket = new TokenBucket({ capacity: 10, refillIntervalMs: 1000 });
    expect(bucket.tryConsume(3)).toBe(true);
    expect(bucket.available).toBe(7);
  });

  it('tryConsume rejects when insufficient', () => {
    const bucket = new TokenBucket({ capacity: 5, refillIntervalMs: 1000 });
    expect(bucket.tryConsume(6)).toBe(false);
    expect(bucket.available).toBe(5);
  });

  it('waitTimeMs returns 0 when tokens available', () => {
    const bucket = new TokenBucket({ capacity: 10, refillIntervalMs: 1000 });
    expect(bucket.waitTimeMs(5)).toBe(0);
  });

  it('waitTimeMs returns positive when empty', () => {
    const bucket = new TokenBucket({ capacity: 10, refillIntervalMs: 100 });
    bucket.tryConsume(10);
    const wait = bucket.waitTimeMs(1);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(100);
  });

  it('setRemaining overrides token count', () => {
    const bucket = new TokenBucket({ capacity: 100, refillIntervalMs: 1000 });
    bucket.setRemaining(5);
    expect(bucket.available).toBe(5);
  });

  it('setRemaining caps at capacity', () => {
    const bucket = new TokenBucket({ capacity: 10, refillIntervalMs: 1000 });
    bucket.setRemaining(999);
    expect(bucket.available).toBe(10);
  });

  it('setCapacity updates capacity', () => {
    const bucket = new TokenBucket({ capacity: 10, refillIntervalMs: 1000 });
    bucket.setCapacity(5);
    expect(bucket.available).toBe(5);
  });
});

describe('RateLimiter', () => {
  it('canProceed returns true when under limits', () => {
    const limiter = new RateLimiter({ rpm: 60, tpm: null, rpd: null, concurrent: 10 });
    expect(limiter.canProceed()).toBe(true);
  });

  it('canProceed returns false after exhausting RPM', () => {
    const limiter = new RateLimiter({ rpm: 2, tpm: null, rpd: null, concurrent: 10 });
    limiter.canProceed();
    limiter.canProceed();
    expect(limiter.canProceed()).toBe(false);
  });

  it('waitTimeMs returns 0 when capacity available', () => {
    const limiter = new RateLimiter({ rpm: 60, tpm: null, rpd: null, concurrent: 10 });
    expect(limiter.waitTimeMs()).toBe(0);
  });

  it('updateFromHeaders updates remaining', () => {
    const limiter = new RateLimiter({ rpm: 60, tpm: 100_000, rpd: null, concurrent: 10 });
    limiter.updateFromHeaders({
      'x-ratelimit-remaining-requests': '5',
      'x-ratelimit-remaining-tokens': '50000',
    });
    expect(limiter.rpmAvailable).toBe(5);
    expect(limiter.tpmAvailable).toBe(50000);
  });

  it('pause drains the RPM bucket', () => {
    const limiter = new RateLimiter({ rpm: 60, tpm: null, rpd: null, concurrent: 10 });
    limiter.pause(5000);
    expect(limiter.rpmAvailable).toBe(0);
    expect(limiter.waitTimeMs()).toBeGreaterThan(0);
  });

  it('null limits mean unlimited', () => {
    const limiter = new RateLimiter({ rpm: null, tpm: null, rpd: null, concurrent: 10 });
    for (let i = 0; i < 100; i++) {
      expect(limiter.canProceed()).toBe(true);
    }
  });
});
