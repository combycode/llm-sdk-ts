/** What the retry layer must NOT retry.
 *
 *  A retry layer is judged by its refusals. Resending a request that already
 *  succeeded, or one the caller cancelled, is not resilience — it is a second
 *  request the caller never asked for, and for a non-idempotent POST that is the
 *  one outcome this layer exists to prevent. */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { NetworkEngine } from '../../../src/network/engine';
import { LLMError, classifyError } from '../../../src/network/errors';
import type { HttpRequest } from '../../../src/network/types';

const makeRequest = (o?: Partial<HttpRequest>): HttpRequest => ({
  url: 'https://example.com/v1/x',
  headers: {},
  body: { hello: 'world' },
  provider: 'anthropic',
  model: 'claude-3-5',
  ...o,
});

/** Counts attempts, so "did not retry" is measured rather than assumed. */
function countingFetch(handler: (n: number) => Promise<Response>) {
  const state = { calls: 0 };
  const fn = ((_u: string, _i?: RequestInit) => {
    state.calls++;
    return handler(state.calls);
  }) as unknown as typeof globalThis.fetch;
  return { fn, state };
}

describe('unmapped 4xx are client errors, not server errors', () => {
  // The error's own `retryable` was already false — but `perKind.server_error`
  // is retryable and the per-kind rule wins, so the WRONG KIND made them retry.
  for (const status of [404, 405, 409, 422]) {
    it(`${status} classifies as invalid_request`, () => {
      const e = classifyError('anthropic', status, { error: { message: 'no' } }, {});
      expect(e.kind).toBe('invalid_request');
      expect(e.retryable).toBe(false);
    });
  }

  it('leaves 5xx alone', () => {
    const e = classifyError('anthropic', 503, {}, {});
    expect(e.kind).toBe('server_error');
    expect(e.retryable).toBe(true);
  });

  it('a 409 is sent exactly once', async () => {
    const { fn, state } = countingFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: 'conflict' } }), { status: 409 })),
    );
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch: fn });
    await expect(engine.fetch(makeRequest())).rejects.toThrow();
    expect(state.calls).toBe(1);
  });
});

describe('x-should-retry', () => {
  it('is read off the response', () => {
    expect(classifyError('a', 500, {}, { 'x-should-retry': 'false' }).shouldRetry).toBe(false);
    expect(classifyError('a', 500, {}, { 'x-should-retry': 'true' }).shouldRetry).toBe(true);
  });

  it('ignores anything that is not exactly true or false', () => {
    for (const v of ['1', 'yes', '', 'TRUE', 'maybe']) {
      expect(classifyError('a', 500, {}, { 'x-should-retry': v }).shouldRetry).toBeUndefined();
    }
    expect(classifyError('a', 500, {}, {}).shouldRetry).toBeUndefined();
  });

  it('`false` vetoes a retry the status code would have earned', async () => {
    const { fn, state } = countingFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'down' } }), {
          status: 503,
          headers: new Headers({ 'x-should-retry': 'false' }),
        }),
      ),
    );
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch: fn });
    await expect(engine.fetch(makeRequest())).rejects.toThrow();
    expect(state.calls).toBe(1);
  });

  it('a 5xx without the header still retries, so the veto is what changed', async () => {
    const { fn, state } = countingFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503 })),
    );
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch: fn });
    await expect(engine.fetch(makeRequest())).rejects.toThrow();
    expect(state.calls).toBeGreaterThan(1);
  });
});

describe('a response that already succeeded', () => {
  /** The POST landed and the server answered 200. Failing to READ that answer is
   *  our problem; sending the request again is the caller's. */
  it('is never re-sent when its body cannot be parsed', async () => {
    const { fn, state } = countingFetch(() =>
      // 200 with a body that is not the JSON we asked for.
      Promise.resolve(new Response('{"truncated": ', { status: 200 })),
    );
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch: fn });
    await expect(engine.fetch(makeRequest())).rejects.toThrow(/could not be read/i);
    expect(state.calls).toBe(1);
  });

  it('reports the failure as non-retryable', async () => {
    const { fn } = countingFetch(() => Promise.resolve(new Response('{"truncated": ', { status: 200 })));
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch: fn });
    const err = await engine.fetch(makeRequest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).retryable).toBe(false);
  });
});

describe('a request the caller cancelled', () => {
  /** The caller's abort and our attempt timeout are the same AbortError, so the
   *  name alone could not tell them apart: a cancelled request was retried and
   *  then reported as `kind: 'timeout'` — wrong about what happened, and wrong
   *  about whose decision it was. */
  it('is not retried, and surfaces as an AbortError rather than a timeout', async () => {
    const controller = new AbortController();
    const { fn, state } = countingFetch(
      () =>
        new Promise<Response>((_res, rej) => {
          controller.abort();
          rej(new DOMException('The operation was aborted.', 'AbortError'));
        }),
    );
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch: fn });
    const err = await engine
      .fetch(makeRequest({ signal: controller.signal }))
      .catch((e: unknown) => e);
    expect(state.calls).toBe(1);
    expect((err as Error).name).toBe('AbortError');
    expect(err).not.toBeInstanceOf(LLMError);
  });

  it('an abort with no caller signal is still treated as our timeout, and retried', async () => {
    const { fn, state } = countingFetch(() =>
      Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
    const engine = new NetworkEngine({ hooks: new HookBus(), fetch: fn });
    const err = await engine.fetch(makeRequest()).catch((e: unknown) => e);
    expect(state.calls).toBeGreaterThan(1);
    expect((err as LLMError).kind).toBe('timeout');
  });
});
