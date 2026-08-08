/** `Retry-After` parsing and the honour cap.
 *
 *  A server can ask us to wait an arbitrarily long time. Without a cap, `Retry-After: 86400` parked
 *  a request — and, on the rate-limit path, the WHOLE limiter — for a day, which is indistinguishable
 *  from a hang. The cap is config (`RetryConfig.maxRetryAfterMs`, default 120s), and a value above
 *  it is treated as a refusal: fail fast instead of waiting. */

import { describe, expect, it } from 'bun:test';
import { classifyError } from '../../../src/network/errors';
import { DEFAULT_RETRY } from '../../../src/network/queue-state-config';
import { HookBus } from '../../../src/bus/hook-bus';
import { NetworkEngine } from '../../../src/network/engine';
import type { HttpRequest } from '../../../src/network/types';

const h = (headers: Record<string, string>) => headers;
const err = (headers: Record<string, string>) => classifyError('openai', 429, null, headers);

// ─── parsing ──────────────────────────────────────────────────────────────────

describe('Retry-After parsing', () => {
  it('reads delay-seconds', () => {
    expect(err(h({ 'retry-after': '30' })).retryAfterMs).toBe(30_000);
  });

  it('prefers the millisecond header when present', () => {
    expect(err(h({ 'retry-after-ms': '1500', 'retry-after': '30' })).retryAfterMs).toBe(1500);
  });

  it('parses the HTTP-date form, which used to be silently ignored', () => {
    const at = new Date(Date.now() + 45_000).toUTCString();
    const ms = err(h({ 'retry-after': at })).retryAfterMs;
    expect(ms).toBeGreaterThan(40_000);
    expect(ms).toBeLessThanOrEqual(46_000);
  });

  it('discards a past HTTP-date rather than returning a negative delay', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(err(h({ 'retry-after': past })).retryAfterMs).toBeUndefined();
  });

  it('discards malformed values instead of yielding NaN', () => {
    // setTimeout(fn, NaN) fires immediately — a bad header must never become a retry storm.
    expect(err(h({ 'retry-after': 'soon' })).retryAfterMs).toBeUndefined();
    expect(err(h({ 'retry-after-ms': 'lots' })).retryAfterMs).toBeUndefined();
    expect(err(h({ 'retry-after': '-5' })).retryAfterMs).toBeUndefined();
  });

  it('falls back to the seconds header when the ms header is junk', () => {
    expect(err(h({ 'retry-after-ms': 'junk', 'retry-after': '2' })).retryAfterMs).toBe(2000);
  });

  it('is absent when no header is sent', () => {
    expect(err(h({})).retryAfterMs).toBeUndefined();
  });
});

// ─── the cap ──────────────────────────────────────────────────────────────────

describe('honour cap', () => {
  it('defaults to 120s', () => {
    expect(DEFAULT_RETRY.maxRetryAfterMs).toBe(120_000);
  });

  it('a day-long Retry-After parses, so the CAP is what must reject it', () => {
    // Parsing stays faithful to the server; the decision to not wait is ours.
    expect(err(h({ 'retry-after': '86400' })).retryAfterMs).toBe(86_400_000);
    expect(err(h({ 'retry-after': '86400' })).retryAfterMs).toBeGreaterThan(
      DEFAULT_RETRY.maxRetryAfterMs,
    );
  });

  it('a normal Retry-After stays under the cap', () => {
    expect(err(h({ 'retry-after': '30' })).retryAfterMs).toBeLessThanOrEqual(
      DEFAULT_RETRY.maxRetryAfterMs,
    );
  });
});

// ─── the behaviour that actually matters: does the request park, or fail? ─────

function stubFetch(status: number, headers: Record<string, string>): typeof globalThis.fetch {
  return ((): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify({ error: 'slow down' }), { status, headers: new Headers(headers) }),
    )) as unknown as typeof globalThis.fetch;
}

const request = (): HttpRequest => ({
  url: 'https://example.com/v1/x',
  headers: {},
  body: { hello: 'world' },
  provider: 'anthropic',
  model: 'claude-3-5',
});

describe('an over-cap Retry-After fails fast instead of parking', () => {
  it('rejects promptly and never schedules a retry', async () => {
    const hooks = new HookBus();
    let retries = 0;
    hooks.on('onRetry', () => {
      retries++;
    });

    const engine = new NetworkEngine({
      hooks,
      fetch: stubFetch(429, { 'retry-after': '86400' }), // a full day
    });

    const started = performance.now();
    await expect(engine.fetch(request())).rejects.toBeDefined();
    const elapsed = performance.now() - started;

    // Before the cap this parked for 24h (the test would simply time out).
    expect(elapsed).toBeLessThan(5_000);
    expect(retries).toBe(0);
  });

  it('still retries when the Retry-After is within the cap', async () => {
    const hooks = new HookBus();
    let retries = 0;
    hooks.on('onRetry', () => {
      retries++;
    });

    const engine = new NetworkEngine({
      hooks,
      fetch: stubFetch(429, { 'retry-after-ms': '5' }),
      // rate_limit has its own perKind maxRetries (5 by default) which wins over the top-level
      // value — pin both so this asserts the cap, not the retry budget.
      queues: {
        'anthropic/claude-3-5': {
          retry: { maxRetries: 1, perKind: { rate_limit: { retryable: true, maxRetries: 1 } } },
        },
      },
    });

    await expect(engine.fetch(request())).rejects.toBeDefined();
    // Proves the fail-fast rule is specific to over-cap values, not a blanket "never retry 429".
    expect(retries).toBe(1);
  });
});
