/** ClientResolver + the direct-HTTP fallback transport.
 *
 *  Behaviour pinned here (this file doubles as the spec for a port):
 *   - resolve() splits "provider/model", looks the key up per provider, and
 *     pools the client so the same provider is never built twice.
 *   - A missing key is a THROW naming the provider AND listing the providers
 *     that were configured (empty → "none"), because the whole point of the
 *     message is telling the caller what they could have used instead.
 *   - Providers present in the key map but set to a falsy value do not count
 *     as configured — neither for availableProviders() nor for the error list.
 *   - Without an explicit `fetch`, the resolver hands the client a direct
 *     globalThis.fetch transport: method defaults to POST, object bodies are
 *     JSON-stringified, string bodies pass through untouched, `signal` is
 *     forwarded only when present, response headers are flattened to a plain
 *     record, and a non-JSON response body degrades to null instead of throwing.
 *
 *  No network: globalThis.fetch is swapped for a recorder and restored. */

import { describe, expect, it } from 'bun:test';
import { ClientResolver } from '../../../src/helpers/client-resolver';
import { HookBus } from '../../../src/bus/hook-bus';
import { LLMClient } from '../../../src/llm/client';
import { ModelCatalog } from '../../../src/catalog/catalog';
import type { EngineFetch, HttpRequest, HttpResponse } from '../../../src/network/types';
import type { ProviderAdapter } from '../../../src/llm/types/provider';

// ─── Stub adapter (ClientResolver supplies no adapter of its own) ─────────────

function stubAdapter(name = 'anthropic'): ProviderAdapter {
  return {
    name,
    buildRequest: () => ({ url: 'https://stub.invalid/v1', method: 'POST', headers: {}, body: {} }),
    parseResponse: () => ({}),
    parseStreamEvent: () => [],
    createStreamParser() {
      return () => [];
    },
    authHeaders: () => ({}),
    baseURL: () => 'https://stub.invalid',
    completionPath: () => '/v1',
  } as unknown as ProviderAdapter;
}

function resolverOpts(extra: Record<string, unknown> = {}) {
  return {
    apiKeys: { anthropic: 'k-anthropic', openai: 'k-openai' },
    hooks: new HookBus(),
    clientOptions: { adapter: stubAdapter() },
    ...extra,
  } as ConstructorParameters<typeof ClientResolver>[0];
}

/** The transport the resolver injected into the client it built. Read from the
 *  client because `directFetch` is module-private by design. */
function injectedFetch(client: LLMClient): EngineFetch {
  return (client as unknown as { fetchFn: EngineFetch }).fetchFn;
}

// ─── resolve() ────────────────────────────────────────────────────────────────

describe('ClientResolver — resolve()', () => {
  it('splits "provider/model" and returns both alongside the client', () => {
    const r = new ClientResolver(resolverOpts());
    const got = r.resolve('anthropic/claude-haiku-4-5');
    expect(got.provider).toBe('anthropic');
    expect(got.model).toBe('claude-haiku-4-5');
    expect(got.client).toBeInstanceOf(LLMClient);
    expect(got.client.model).toBe('claude-haiku-4-5');
  });

  it('picks the key belonging to the requested provider, not the first one', () => {
    const r = new ClientResolver(resolverOpts());
    const got = r.resolve('openai/gpt-5-nano');
    expect((got.client as unknown as { apiKey: string }).apiKey).toBe('k-openai');
  });

  it('pools per provider: two models of one provider share a client instance', () => {
    const r = new ClientResolver(resolverOpts());
    const a = r.resolve('anthropic/claude-haiku-4-5');
    const b = r.resolve('anthropic/claude-opus-4-5');
    expect(a.client).toBe(b.client);
    expect(r.size).toBe(1);
  });

  it('gives a model its own client when the catalog marks it dedicated', () => {
    const catalog = new ModelCatalog();
    catalog.set('anthropic', 'solo', { pricing: {}, requiresDedicatedClient: true });
    const r = new ClientResolver(resolverOpts({ catalog }));
    const solo = r.resolve('anthropic/solo');
    const shared = r.resolve('anthropic/claude-haiku-4-5');
    expect(solo.client).not.toBe(shared.client);
    expect(r.size).toBe(2);
  });

  it('throws for a provider with no key, naming it and listing configured ones', () => {
    const r = new ClientResolver(resolverOpts());
    expect(() => r.resolve('google/gemini-3-flash')).toThrow(
      /no API key for provider "google".*Configured providers: \[anthropic, openai\]/s,
    );
  });

  it('reports "none" when every configured key is empty', () => {
    const r = new ClientResolver(
      resolverOpts({ apiKeys: { anthropic: '', openai: undefined } }),
    );
    expect(() => r.resolve('anthropic/claude-haiku-4-5')).toThrow(/Configured providers: \[none\]/);
  });

  it('does not build a client when the key is missing (pool stays empty)', () => {
    const r = new ClientResolver(resolverOpts());
    expect(() => r.resolve('google/gemini-3-flash')).toThrow();
    expect(r.size).toBe(0);
  });

  it('forwards clientOptions and the configured fetchStream onto the client', () => {
    const fetchFn: EngineFetch = async () => ({ status: 200, headers: {}, body: {} });
    async function* fetchStream() {}
    const r = new ClientResolver(
      resolverOpts({
        fetch: fetchFn,
        fetchStream,
        clientOptions: { adapter: stubAdapter(), api: 'completions' },
      }),
    );
    const { client } = r.resolve('anthropic/claude-haiku-4-5');
    expect(client.api).toBe('completions');
    expect(injectedFetch(client)).toBe(fetchFn);
    expect((client as unknown as { fetchStreamFn: unknown }).fetchStreamFn).toBe(fetchStream);
  });
});

// ─── availableProviders / size / destroy ──────────────────────────────────────

describe('ClientResolver — introspection and teardown', () => {
  it('availableProviders lists only providers with a truthy key', () => {
    const r = new ClientResolver(
      resolverOpts({ apiKeys: { anthropic: 'k', openai: '', google: undefined } }),
    );
    expect(r.availableProviders()).toEqual(['anthropic']);
  });

  it('size starts at 0 and grows one per pooled provider', () => {
    const r = new ClientResolver(resolverOpts());
    expect(r.size).toBe(0);
    r.resolve('anthropic/claude-haiku-4-5');
    expect(r.size).toBe(1);
    r.resolve('openai/gpt-5-nano');
    expect(r.size).toBe(2);
  });

  it('destroy() empties the pool and a later resolve builds a fresh client', async () => {
    const r = new ClientResolver(resolverOpts());
    const before = r.resolve('anthropic/claude-haiku-4-5').client;
    await r.destroy();
    expect(r.size).toBe(0);
    const after = r.resolve('anthropic/claude-haiku-4-5').client;
    expect(after).not.toBe(before);
  });

  it('destroy() fires onClientDestroy for each pooled client', async () => {
    const hooks = new HookBus();
    const destroyed: string[] = [];
    hooks.on('onClientDestroy', (ctx) => {
      destroyed.push((ctx as { clientId: string }).clientId);
    });
    const r = new ClientResolver(resolverOpts({ hooks }));
    const a = r.resolve('anthropic/claude-haiku-4-5').client;
    const b = r.resolve('openai/gpt-5-nano').client;
    await r.destroy();
    expect(destroyed.sort()).toEqual([a.id, b.id].sort());
  });
});

// ─── the zero-config direct-HTTP fallback ─────────────────────────────────────

describe('ClientResolver — direct fetch fallback (no engine.fetch given)', () => {
  /** Swap globalThis.fetch, run the transport, always restore. */
  async function withStubbedGlobalFetch(
    impl: (url: string, init: RequestInit) => Response,
    run: (call: EngineFetch) => Promise<void>,
    resolver = new ClientResolver(resolverOpts()),
  ): Promise<Array<{ url: string; init: RequestInit }>> {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return impl(url, init);
    }) as unknown as typeof globalThis.fetch;
    try {
      await run(injectedFetch(resolver.resolve('anthropic/claude-haiku-4-5').client));
    } finally {
      globalThis.fetch = original;
    }
    return seen;
  }

  it('POSTs to the request url, JSON-stringifying an object body', async () => {
    const seen = await withStubbedGlobalFetch(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      async (call) => {
        const res = await call({
          url: 'https://example.invalid/v1/x',
          headers: { 'x-api-key': 'k' },
          body: { hello: 'world' },
        } as unknown as HttpRequest);
        expect(res).toEqual({ status: 200, headers: expect.any(Object), body: { ok: true } } as unknown as HttpResponse);
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://example.invalid/v1/x');
    expect(seen[0].init.method).toBe('POST');
    expect(seen[0].init.headers).toEqual({ 'x-api-key': 'k' });
    expect(seen[0].init.body).toBe('{"hello":"world"}');
  });

  it('honours an explicit method and leaves a string body untouched', async () => {
    const seen = await withStubbedGlobalFetch(
      () => new Response('{}', { status: 200 }),
      async (call) => {
        await call({
          url: 'https://example.invalid/v1/y',
          method: 'GET',
          headers: {},
          body: 'raw-string-body',
        } as unknown as HttpRequest);
      },
    );
    expect(seen[0].init.method).toBe('GET');
    expect(seen[0].init.body).toBe('raw-string-body');
  });

  it('forwards an AbortSignal when the request carries one, and omits it otherwise', async () => {
    const ctrl = new AbortController();
    const withSignal = await withStubbedGlobalFetch(
      () => new Response('{}', { status: 200 }),
      async (call) => {
        await call({
          url: 'https://example.invalid/v1/z',
          headers: {},
          body: {},
          signal: ctrl.signal,
        } as HttpRequest);
      },
    );
    expect(withSignal[0].init.signal).toBe(ctrl.signal);

    const withoutSignal = await withStubbedGlobalFetch(
      () => new Response('{}', { status: 200 }),
      async (call) => {
        await call({ url: 'https://example.invalid/v1/z', headers: {}, body: {} } as HttpRequest);
      },
    );
    expect('signal' in withoutSignal[0].init).toBe(false);
  });

  it('flattens response headers into a plain record and preserves the status', async () => {
    let out: HttpResponse | undefined;
    await withStubbedGlobalFetch(
      () =>
        new Response(JSON.stringify({ n: 1 }), {
          status: 429,
          headers: { 'retry-after': '3', 'x-request-id': 'abc' },
        }),
      async (call) => {
        out = await call({ url: 'https://example.invalid/', headers: {}, body: {} } as HttpRequest);
      },
    );
    expect(out?.status).toBe(429);
    expect(out?.headers['retry-after']).toBe('3');
    expect(out?.headers['x-request-id']).toBe('abc');
    expect(Object.getPrototypeOf(out?.headers as object)).toBe(Object.prototype);
  });

  it('returns body:null instead of throwing when the response is not JSON', async () => {
    let out: HttpResponse | undefined;
    await withStubbedGlobalFetch(
      () => new Response('<html>gateway timeout</html>', { status: 504 }),
      async (call) => {
        out = await call({ url: 'https://example.invalid/', headers: {}, body: {} } as HttpRequest);
      },
    );
    expect(out?.status).toBe(504);
    expect(out?.body).toBeNull();
  });
});
