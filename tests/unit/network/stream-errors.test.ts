/** Streaming error reporting + the queue worker's crash recovery.
 *
 *  A failed STREAM takes a different code path from a failed request: the body
 *  is read as JSON, classified, and reported through `onRateLimitHit` /
 *  `onModelError` before the error is thrown to the consumer. The rate-limit
 *  payload reads four `x-ratelimit-*` headers by name — the exact shape of bug
 *  where a wrong key silently yields `null` and every dashboard shows "unknown
 *  remaining" forever. Each field is asserted against a header here. */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { NetworkEngine } from '../../../src/network/engine';
import type { HttpRequest } from '../../../src/network/types';

const req = (over?: Partial<HttpRequest>): HttpRequest => ({
  url: 'https://example.com/v1/x',
  headers: {},
  body: { hello: 'world' },
  provider: 'anthropic',
  model: 'claude-3-5',
  ...over,
});

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return ((_url: string, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: new Headers(headers) }),
    )) as unknown as typeof globalThis.fetch;
}

const drain = async (it: AsyncIterable<unknown>) => {
  for await (const _ of it) {
    /* consume */
  }
};

const RL_HEADERS = {
  'x-ratelimit-remaining-requests': '3',
  'x-ratelimit-remaining-tokens': '4000',
  'x-ratelimit-limit-requests': '60',
  'x-ratelimit-limit-tokens': '90000',
};

describe('fetchStream — error reporting', () => {
  it('a 429 emits onRateLimitHit with every x-ratelimit-* header parsed as a number', async () => {
    const hooks = new HookBus();
    let hit: Record<string, unknown> | null = null;
    hooks.on('onRateLimitHit', (c) => {
      hit = c as unknown as Record<string, unknown>;
    });
    const engine = new NetworkEngine({
      hooks,
      fetch: stubFetch(429, { error: { message: 'slow down' } }, RL_HEADERS),
    });
    await expect(drain(engine.fetchStream(req()))).rejects.toBeDefined();

    expect(hit).not.toBeNull();
    expect(hit).toMatchObject({
      provider: 'anthropic',
      model: 'claude-3-5',
      queueName: 'anthropic/claude-3-5',
      status: 429,
      remainingRequests: 3,
      remainingTokens: 4000,
      limitRequests: 60,
      limitTokens: 90000,
    });
  });

  it('missing rate-limit headers become null, not undefined or NaN', async () => {
    const hooks = new HookBus();
    let hit: Record<string, unknown> | null = null;
    hooks.on('onRateLimitHit', (c) => {
      hit = c as unknown as Record<string, unknown>;
    });
    const engine = new NetworkEngine({ hooks, fetch: stubFetch(429, { error: 'x' }) });
    await expect(drain(engine.fetchStream(req()))).rejects.toBeDefined();
    expect(hit).toMatchObject({
      remainingRequests: null,
      remainingTokens: null,
      limitRequests: null,
      limitTokens: null,
    });
  });

  it('a non-rate-limit failure emits onModelError but NOT onRateLimitHit', async () => {
    const hooks = new HookBus();
    let rateLimitFired = false;
    let kind = '';
    let attempt = -1;
    hooks.on('onRateLimitHit', () => {
      rateLimitFired = true;
    });
    hooks.on('onModelError', (c) => {
      kind = c.error.kind;
      attempt = c.attempt;
    });
    const engine = new NetworkEngine({
      hooks,
      fetch: stubFetch(401, { error: { message: 'bad key' } }),
    });
    await expect(drain(engine.fetchStream(req()))).rejects.toThrow('bad key');
    expect(rateLimitFired).toBe(false);
    expect(kind).toBe('auth');
    // A stream is never retried, so the reported attempt is always the first.
    expect(attempt).toBe(0);
  });

  it('onModelError still fires for a rate limit (both hooks, in that order)', async () => {
    const hooks = new HookBus();
    const order: string[] = [];
    hooks.on('onRateLimitHit', () => {
      order.push('rate');
    });
    hooks.on('onModelError', () => {
      order.push('model');
    });
    const engine = new NetworkEngine({ hooks, fetch: stubFetch(429, { error: 'x' }) });
    await expect(drain(engine.fetchStream(req()))).rejects.toBeDefined();
    expect(order).toEqual(['rate', 'model']);
  });

  it('a non-JSON error body does not mask the status classification', async () => {
    const hooks = new HookBus();
    let kind = '';
    hooks.on('onModelError', (c) => {
      kind = c.error.kind;
    });
    const engine = new NetworkEngine({
      hooks,
      fetch: (() =>
        Promise.resolve(new Response('<html>502</html>', { status: 502 }))) as unknown as typeof globalThis.fetch,
    });
    await expect(drain(engine.fetchStream(req()))).rejects.toBeDefined();
    expect(kind).toBe('server_error');
  });

  it('a stream that returns 200 with no body is an explicit error, not a silent empty stream', async () => {
    const engine = new NetworkEngine({
      hooks: new HookBus(),
      fetch: (() =>
        Promise.resolve(new Response(null, { status: 204 }))) as unknown as typeof globalThis.fetch,
    });
    await expect(drain(engine.fetchStream(req()))).rejects.toThrow('No response body');
  });

  it('a hook that aborts onRequestStart stops the stream before any fetch', async () => {
    const hooks = new HookBus();
    let fetched = false;
    hooks.on('onRequestStart', (ctx) => {
      ctx.abort = true;
    });
    const engine = new NetworkEngine({
      hooks,
      fetch: (() => {
        fetched = true;
        return Promise.resolve(new Response('data: x\n\n', { status: 200 }));
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(drain(engine.fetchStream(req()))).rejects.toThrow('Request aborted by hook');
    expect(fetched).toBe(false);
  });

  it('a successful stream releases its concurrency slot (a second stream still runs)', async () => {
    const engine = new NetworkEngine({
      hooks: new HookBus(),
      fetch: (() =>
        Promise.resolve(new Response('data: one\n\n', { status: 200 }))) as unknown as typeof globalThis.fetch,
      queues: {
        'anthropic/claude-3-5': { limits: { rpm: null, tpm: null, rpd: null, concurrent: 1 } },
      },
    });
    await drain(engine.fetchStream(req()));
    await drain(engine.fetchStream(req()));
    expect(engine.getQueueState('anthropic/claude-3-5')?.snapshot().inFlight).toBe(0);
  });
});

describe('queue worker — recovery from a crashing sync hook', () => {
  it('a throwing onDequeue handler stops the loop, and the NEXT submit restarts it', async () => {
    const hooks = new HookBus();
    let boom = true;
    hooks.on('onDequeue', () => {
      if (boom) throw new Error('subscriber blew up');
    });
    const engine = new NetworkEngine({ hooks, fetch: stubFetch(200, { ok: true }) });

    // The first request is lost: emitSync is not guarded, so processLoop rejects
    // and its promise never settles. What must NOT happen is the queue staying
    // marked "running" forever — that would wedge every later request too.
    void engine.fetch(req()).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(engine.getQueueState('anthropic/claude-3-5')?.snapshot().running).toBe(false);

    boom = false;
    const res = await engine.fetch(req());
    expect(res.status).toBe(200);
  });
});
