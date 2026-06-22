/** Tests for NetworkEngine: multi-queue routing + lazy queue creation +
 *  hook propagation + retry / rate-limit behavior. Uses an injected stub fetch. */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { NetworkEngine } from '../../../src/network/engine';
import type { HttpRequest } from '../../../src/network/types';

function makeRequest(overrides?: Partial<HttpRequest>): HttpRequest {
  return {
    url: 'https://example.com/v1/x',
    headers: {},
    body: { hello: 'world' },
    provider: 'anthropic',
    model: 'claude-3-5',
    ...overrides,
  };
}

function makeStubFetch(
  status: number,
  body: unknown,
  options?: { headers?: Record<string, string> },
): typeof globalThis.fetch {
  const fn = ((_url: string, _init?: RequestInit): Promise<Response> => {
    const headers = new Headers(options?.headers);
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers }));
  }) as unknown as typeof globalThis.fetch;
  return fn;
}

describe('NetworkEngine — basic fetch', () => {
  it('returns parsed JSON body on 200', async () => {
    const engine = new NetworkEngine({
      hooks: new HookBus(),
      fetch: makeStubFetch(200, { ok: true }),
    });
    const res = await engine.fetch(makeRequest());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('emits onEnqueue / onRequestStart / onRequestComplete', async () => {
    const hooks = new HookBus();
    const events: string[] = [];
    hooks.on('onEnqueue', () => {
      events.push('enqueue');
    });
    hooks.on('onRequestStart', () => {
      events.push('start');
    });
    hooks.on('onRequestComplete', () => {
      events.push('complete');
    });

    const engine = new NetworkEngine({ hooks, fetch: makeStubFetch(200, { ok: true }) });
    await engine.fetch(makeRequest());
    expect(events).toContain('enqueue');
    expect(events).toContain('start');
    expect(events).toContain('complete');
  });

  it('hook payloads carry queueName, provider, model from the request', async () => {
    const hooks = new HookBus();
    let captured: { queueName?: string; provider?: string; model?: string } = {};
    hooks.on('onRequestStart', (ctx) => {
      captured = { queueName: ctx.queueName, provider: ctx.provider, model: ctx.model };
    });

    const engine = new NetworkEngine({ hooks, fetch: makeStubFetch(200, {}) });
    await engine.fetch(makeRequest({ provider: 'openai', model: 'gpt-4o' }));

    expect(captured.queueName).toBe('openai/gpt-4o');
    expect(captured.provider).toBe('openai');
    expect(captured.model).toBe('gpt-4o');
  });
});

describe('NetworkEngine — multi-queue isolation', () => {
  it('different queueNames create different QueueStates', async () => {
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch: makeStubFetch(200, {}) });
    await engine.fetch(makeRequest({ provider: 'p1', model: 'm1' }));
    await engine.fetch(makeRequest({ provider: 'p2', model: 'm2' }));
    expect(engine.queueNames().sort()).toEqual(['p1/m1', 'p2/m2']);
  });

  it('same queueName re-uses one QueueState', async () => {
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch: makeStubFetch(200, {}) });
    await engine.fetch(makeRequest({ provider: 'p1', model: 'm1' }));
    const before = engine.getQueueState('p1/m1');
    await engine.fetch(makeRequest({ provider: 'p1', model: 'm1' }));
    const after = engine.getQueueState('p1/m1');
    expect(before).toBe(after);
  });

  it('echoes req.trace onto network events (e2e correlation)', async () => {
    const hooks = new HookBus();
    const seen: Record<string, unknown> = {};
    hooks.on('onEnqueue', (c) => {
      seen.enqueue = c.trace;
    });
    hooks.on('onRequestStart', (c) => {
      seen.start = c.trace;
    });
    hooks.on('onRequestComplete', (c) => {
      seen.complete = c.trace;
    });
    const engine = new NetworkEngine({ hooks, fetch: makeStubFetch(200, {}) });
    const trace = { sessionId: 'sess_x', requestId: 'req_y', callId: 'call_z' };
    await engine.fetch(makeRequest({ provider: 'p1', model: 'm1', trace }));
    expect(seen.enqueue).toEqual(trace);
    expect(seen.start).toEqual(trace);
    expect(seen.complete).toEqual(trace);
  });

  it('snapshot() reports numeric state per queue (depth/inFlight/rateLimit)', async () => {
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch: makeStubFetch(200, {}) });
    await engine.fetch(makeRequest({ provider: 'p1', model: 'm1' }));
    const snap = engine.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].queueName).toBe('p1/m1');
    // after a completed request the queue is idle
    expect(snap[0]).toMatchObject({ depth: 0, inFlight: 0, waiting: 0 });
    expect(typeof snap[0].rateLimitWaitMs).toBe('number');
  });

  it('FetchOptions.queueName overrides default formula', async () => {
    const hooks = new HookBus();
    const seen: string[] = [];
    hooks.on('onRequestStart', (ctx) => {
      seen.push(ctx.queueName);
    });

    const engine = new NetworkEngine({ hooks, fetch: makeStubFetch(200, {}) });
    await engine.fetch(makeRequest(), { queueName: 'shared/cheap' });
    expect(seen).toEqual(['shared/cheap']);
    expect(engine.queueNames()).toEqual(['shared/cheap']);
  });

  it('ctx.queueName falls back when queueName option not given', async () => {
    const hooks = new HookBus();
    const seen: string[] = [];
    hooks.on('onRequestStart', (ctx) => {
      seen.push(ctx.queueName);
    });

    const engine = new NetworkEngine({ hooks, fetch: makeStubFetch(200, {}) });
    await engine.fetch(makeRequest(), { ctx: { queueName: 'from-ctx' } });
    expect(seen).toEqual(['from-ctx']);
  });

  it('explicit queueName beats ctx.queueName', async () => {
    const hooks = new HookBus();
    const seen: string[] = [];
    hooks.on('onRequestStart', (ctx) => {
      seen.push(ctx.queueName);
    });

    const engine = new NetworkEngine({ hooks, fetch: makeStubFetch(200, {}) });
    await engine.fetch(makeRequest(), {
      queueName: 'explicit',
      ctx: { queueName: 'from-ctx' },
    });
    expect(seen).toEqual(['explicit']);
  });
});

describe('NetworkEngine — configureQueue + lazy creation', () => {
  it('configureQueue applies before first use', async () => {
    const hooks = new HookBus();
    const engine = new NetworkEngine({ hooks, fetch: makeStubFetch(200, {}) });
    engine.configureQueue('p/m', { limits: { rpm: 5, tpm: null, rpd: null, concurrent: 2 } });

    await engine.fetch(makeRequest({ provider: 'p', model: 'm' }));
    expect(engine.hasQueue('p/m')).toBe(true);
  });

  it('configureQueue throws after queue created', async () => {
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch: makeStubFetch(200, {}) });
    await engine.fetch(makeRequest({ provider: 'p', model: 'm' }));
    expect(() =>
      engine.configureQueue('p/m', { limits: { rpm: 5, tpm: null, rpd: null, concurrent: 1 } }),
    ).toThrow();
  });

  it('dropQueue allows reconfiguration', async () => {
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch: makeStubFetch(200, {}) });
    await engine.fetch(makeRequest({ provider: 'p', model: 'm' }));
    engine.dropQueue('p/m');
    expect(() =>
      engine.configureQueue('p/m', { limits: { rpm: 5, tpm: null, rpd: null, concurrent: 1 } }),
    ).not.toThrow();
  });

  it('destroy clears all queues', async () => {
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch: makeStubFetch(200, {}) });
    await engine.fetch(makeRequest({ provider: 'a', model: 'a' }));
    await engine.fetch(makeRequest({ provider: 'b', model: 'b' }));
    expect(engine.queueNames().length).toBe(2);
    engine.destroy();
    expect(engine.queueNames().length).toBe(0);
  });
});

describe('NetworkEngine — error mapping + retry', () => {
  it('non-retryable error rejects the fetch', async () => {
    const fetch = makeStubFetch(401, { error: { message: 'bad key' } });
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch });
    await expect(engine.fetch(makeRequest())).rejects.toThrow('bad key');
  });

  it('emits onModelError on failure', async () => {
    const hooks = new HookBus();
    let kind = '';
    hooks.on('onModelError', (ctx) => {
      kind = ctx.error.kind;
    });
    const engine = new NetworkEngine({ hooks, fetch: makeStubFetch(401, { error: 'auth bad' }) });
    await expect(engine.fetch(makeRequest())).rejects.toBeDefined();
    expect(kind).toBe('auth');
  });

  it('on 429 emits onRateLimitHit', async () => {
    const hooks = new HookBus();
    let hit = false;
    hooks.on('onRateLimitHit', () => {
      hit = true;
    });
    const engine = new NetworkEngine({
      hooks,
      fetch: makeStubFetch(429, { error: 'rate limited' }),
      // Reduce retry burden so the test finishes fast.
      queues: {
        'anthropic/claude-3-5': {
          retry: { maxRetries: 0, perKind: { rate_limit: { retryable: false } } },
        },
      },
    });
    await expect(engine.fetch(makeRequest())).rejects.toBeDefined();
    expect(hit).toBe(true);
  });
});

describe('NetworkEngine — body-less GET (regression: bodySize crash)', () => {
  // A model-less metadata GET (e.g. listModelsLive) has body===undefined. The
  // telemetry `bodySize` computation used to JSON.stringify(undefined).length and
  // throw OUTSIDE the worker try — silently swallowed → the fetch hung forever.
  it('resolves a GET with no body (does not hang or crash on bodySize)', async () => {
    const engine = new NetworkEngine({
      hooks: new HookBus(),
      fetch: makeStubFetch(200, { data: [{ id: 'gpt-4o' }] }),
    });
    const res = await engine.fetch(makeRequest({ method: 'GET', body: undefined, model: '' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [{ id: 'gpt-4o' }] });
  });

  it('onRequestStart reports bodySize 0 for a body-less request', async () => {
    const hooks = new HookBus();
    let bodySize = -1;
    hooks.on('onRequestStart', (ctx) => {
      bodySize = ctx.bodySize;
    });
    const engine = new NetworkEngine({ hooks, fetch: makeStubFetch(200, {}) });
    await engine.fetch(makeRequest({ method: 'GET', body: undefined }));
    expect(bodySize).toBe(0);
  });
});

describe('NetworkEngine — worker safety net (regression: silent hang)', () => {
  // If executeWithRetry throws from its pre-`try` setup (here: a throwing
  // onRequestStart hook, emitted before the try), the entry's promise used to
  // never settle — a deadlock. The worker .catch must now reject the caller and
  // surface the bug via onModelError, never hang.
  it('rejects the fetch when a pre-try hook throws (no hang)', async () => {
    const hooks = new HookBus();
    hooks.on('onRequestStart', () => {
      throw new Error('boom in onRequestStart');
    });
    const engine = new NetworkEngine({ hooks, fetch: makeStubFetch(200, {}) });
    await expect(engine.fetch(makeRequest())).rejects.toThrow(/would have hung|boom/);
  });

  it('emits onInternalError (NOT onModelError) when the worker crashes pre-try', async () => {
    const hooks = new HookBus();
    let internalSource = '';
    let internalErrorKind = '';
    let modelErrorFired = false;
    hooks.on('onRequestStart', () => {
      throw new Error('boom');
    });
    hooks.on('onInternalError', (ctx) => {
      internalSource = ctx.source;
      internalErrorKind = ctx.error.kind;
    });
    hooks.on('onModelError', () => {
      modelErrorFired = true;
    });
    const engine = new NetworkEngine({ hooks, fetch: makeStubFetch(200, {}) });
    await expect(engine.fetch(makeRequest())).rejects.toBeDefined();
    // An engine bug must surface on the internal channel, never be misattributed
    // to the provider via onModelError.
    expect(internalSource).toBe('queue');
    expect(internalErrorKind).toBe('server_error');
    expect(modelErrorFired).toBe(false);
  });

  it('does not leak the semaphore slot after a pre-try crash', async () => {
    // First call crashes pre-try; if the slot leaked, a second call would hang.
    const hooks = new HookBus();
    let throwNext = true;
    hooks.on('onRequestStart', () => {
      if (throwNext) {
        throwNext = false;
        throw new Error('boom once');
      }
    });
    const engine = new NetworkEngine({
      hooks,
      fetch: makeStubFetch(200, { ok: true }),
      queues: {
        'anthropic/claude-3-5': { limits: { rpm: null, tpm: null, rpd: null, concurrent: 1 } },
      },
    });
    await expect(engine.fetch(makeRequest())).rejects.toBeDefined();
    // Slot must have been released — this second call should resolve, not hang.
    const res = await engine.fetch(makeRequest());
    expect(res.status).toBe(200);
  });
});

describe('NetworkEngine — fetch returns error body classified', () => {
  it('classifies 400 with model-not-found message', async () => {
    const fetch = makeStubFetch(400, {
      error: { message: 'model gpt-99 does not exist' },
    });
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch });
    try {
      await engine.fetch(makeRequest({ model: 'gpt-99' }));
      expect.unreachable();
    } catch (err) {
      // LLMError exposes `kind`.
      const e = err as { kind?: string };
      expect(e.kind).toBe('model_not_found');
    }
  });
});
