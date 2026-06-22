/** LLMClient unit tests with a mock provider adapter + stub fetch.
 *  Validates: input normalization, hook emission, model+system fixed at
 *  construction, fetch injection, ctx propagation, custom cacheKeyFn. */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { LLMClient } from '../../../src/llm/client';
import type { Message } from '../../../src/llm/types/messages';
import type { ProviderAdapter, ProviderHttpRequest } from '../../../src/llm/types/provider';
import type { NormalizedRequest } from '../../../src/llm/types/request';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { EngineFetch, HttpRequest, HttpResponse } from '../../../src/network/types';

// ─── Mock adapter ───────────────────────────────────────────────────────

function makeMockAdapter(provider = 'mock'): ProviderAdapter & {
  lastRequest: NormalizedRequest | null;
} {
  const adapter = {
    name: provider as ProviderAdapter['name'],
    lastRequest: null as NormalizedRequest | null,
    buildRequest(req: NormalizedRequest): ProviderHttpRequest {
      this.lastRequest = req;
      return {
        body: { model: req.model, messages: req.messages, system: req.system },
      };
    },
    parseResponse(raw: unknown, latencyMs: number): CompletionResponse {
      const body = raw as { text?: string };
      return {
        id: 'r1',
        model: 'mock-model',
        content: [{ type: 'text', text: body.text ?? '' }],
        finishReason: 'stop',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        text: body.text ?? '',
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs,
        raw,
      };
    },
    parseStreamEvent() {
      return [];
    },
    authHeaders() {
      return { 'x-api-key': 'mock-key' };
    },
    baseURL() {
      return 'https://mock.test';
    },
    completionPath() {
      return '/v1/complete';
    },
  } satisfies ProviderAdapter & { lastRequest: NormalizedRequest | null };
  return adapter;
}

function makeStubFetch(body: unknown): {
  fetch: EngineFetch;
  calls: Array<{ req: HttpRequest; opts: unknown }>;
} {
  const calls: Array<{ req: HttpRequest; opts: unknown }> = [];
  return {
    calls,
    fetch: async (req: HttpRequest, opts) => {
      calls.push({ req, opts });
      return Promise.resolve({ status: 200, headers: {}, body }) as Promise<HttpResponse>;
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('LLMClient — construction', () => {
  it('throws on missing required fields', () => {
    expect(() => new LLMClient({} as never)).toThrow();
  });

  it('emits onClientCreate', () => {
    const hooks = new HookBus();
    let create: { clientId?: string; provider?: string; model?: string } = {};
    hooks.on('onClientCreate', (ctx) => {
      create = ctx;
    });

    const adapter = makeMockAdapter();
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      hooks,
      adapter,
      fetch: stub.fetch,
    });

    expect(create.clientId).toBe(client.id);
    expect(create.provider).toBe('anthropic');
    expect(create.model).toBe('claude-3');
  });

  it('exposes id, provider, model, system as readonly', () => {
    const stub = makeStubFetch({});
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      system: 'be helpful',
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
    });
    expect(client.provider).toBe('anthropic');
    expect(client.model).toBe('claude-3');
    expect(client.system).toBe('be helpful');
    expect(client.id).toMatch(/^[0-9a-f-]+$/);
  });

  it('emits onClientDestroy on destroy()', () => {
    const hooks = new HookBus();
    let destroyed = false;
    hooks.on('onClientDestroy', () => {
      destroyed = true;
    });
    const stub = makeStubFetch({});
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      hooks,
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
    });
    client.destroy();
    expect(destroyed).toBe(true);
  });
});

describe('LLMClient.complete — input normalization', () => {
  it('string → wraps as user message', async () => {
    const adapter = makeMockAdapter();
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      adapter,
      fetch: stub.fetch,
    });
    await client.complete('hello');
    expect(adapter.lastRequest?.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('ContentPart[] → wraps as user message with parts', async () => {
    const adapter = makeMockAdapter();
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      adapter,
      fetch: stub.fetch,
    });
    await client.complete([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
    expect(adapter.lastRequest?.messages.length).toBe(1);
    const msg = adapter.lastRequest?.messages[0];
    expect(msg?.role).toBe('user');
    expect(Array.isArray(msg?.content)).toBe(true);
  });

  it('Message[] → used directly (replace semantics)', async () => {
    const adapter = makeMockAdapter();
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      adapter,
      fetch: stub.fetch,
    });
    const msgs: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    await client.complete(msgs);
    expect(adapter.lastRequest?.messages).toEqual(msgs);
  });
});

describe('LLMClient.complete — system + model fixed at construction', () => {
  it('system from ctor is passed to adapter on every call', async () => {
    const adapter = makeMockAdapter();
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      system: 'fixed system prompt',
      adapter,
      fetch: stub.fetch,
    });
    await client.complete('a');
    expect(adapter.lastRequest?.system).toBe('fixed system prompt');
    await client.complete('b');
    expect(adapter.lastRequest?.system).toBe('fixed system prompt');
  });

  it('model from ctor is passed to adapter on every call', async () => {
    const adapter = makeMockAdapter();
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'fixed-model',
      apiKey: 'k',
      adapter,
      fetch: stub.fetch,
    });
    await client.complete('a');
    expect(adapter.lastRequest?.model).toBe('fixed-model');
  });
});

describe('LLMClient.complete — hooks pipeline', () => {
  it('emits onMessageResolve, onBeforeSubmit, onCompletion in order', async () => {
    const hooks = new HookBus();
    const order: string[] = [];
    hooks.on('onMessageResolve', () => {
      order.push('resolve');
    });
    hooks.on('onBeforeSubmit', () => {
      order.push('submit');
    });
    hooks.on('onCompletion', () => {
      order.push('completion');
    });

    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      hooks,
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
    });
    await client.complete('hello');
    expect(order).toEqual(['resolve', 'submit', 'completion']);
  });

  it('threads sessionId + mints requestId/callId onto the request ctx', async () => {
    const hooks = new HookBus();
    let ctx: { sessionId?: string; requestId?: string; callId?: string } | undefined;
    hooks.on('onCompletion', (c) => {
      ctx = c.ctx;
    });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      sessionId: 'sess_test',
      hooks,
      adapter: makeMockAdapter(),
      fetch: makeStubFetch({ text: 'hi' }).fetch,
    });
    await client.complete('hello');
    expect(ctx?.sessionId).toBe('sess_test');
    expect(ctx?.requestId).toMatch(/^req_/);
    expect(ctx?.callId).toMatch(/^call_/);
  });

  it('a standalone client mints its own sessionId', () => {
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      hooks: new HookBus(),
      adapter: makeMockAdapter(),
      fetch: makeStubFetch({ text: 'hi' }).fetch,
    });
    expect(client.sessionId).toMatch(/^sess_/);
  });

  it('onMessageResolve handler can mutate messages in-place', async () => {
    const adapter = makeMockAdapter();
    const hooks = new HookBus();
    hooks.on('onMessageResolve', (ctx) => {
      ctx.messages.push({ role: 'system', content: 'INJECTED' });
    });
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      hooks,
      adapter,
      fetch: stub.fetch,
    });
    await client.complete('hello');
    const msgs = adapter.lastRequest?.messages ?? [];
    expect(msgs.some((m) => m.content === 'INJECTED')).toBe(true);
  });

  it('onMessageResolve abort stops the request', async () => {
    const hooks = new HookBus();
    hooks.on('onMessageResolve', (ctx) => {
      ctx.abort = true;
      ctx.abortReason = 'too long';
    });
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      hooks,
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
    });
    await expect(client.complete('hello')).rejects.toThrow('too long');
    expect(stub.calls.length).toBe(0);
  });

  it('onBeforeSubmit interception short-circuits HTTP', async () => {
    const hooks = new HookBus();
    hooks.on('onBeforeSubmit', (ctx) => {
      ctx.intercepted = true;
      ctx.resultPromise = Promise.resolve({ text: 'cached!' });
    });
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      hooks,
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
    });
    const res = await client.complete('hello');
    expect(res.text).toBe('cached!');
    expect(stub.calls.length).toBe(0);
  });
});

describe('LLMClient.complete — RequestContext + routing', () => {
  it('passes queueName to fetch options (default $provider/$model)', async () => {
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
    });
    await client.complete('hello');
    expect((stub.calls[0].opts as { queueName?: string }).queueName).toBe('anthropic/claude-3');
  });

  it('queueName from config overrides default', async () => {
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      queueName: 'shared/cheap',
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
    });
    await client.complete('hello');
    expect((stub.calls[0].opts as { queueName?: string }).queueName).toBe('shared/cheap');
  });

  it('cacheKeyFn computes cacheKey from normalized request', async () => {
    const stub = makeStubFetch({ text: 'hi' });
    let observed: string | undefined;
    const hooks = new HookBus();
    hooks.on('onBeforeSubmit', (ctx) => {
      observed = ctx.ctx.cacheKey;
    });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      hooks,
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
      cacheKeyFn: (req) => `custom:${req.messages.length}`,
    });
    await client.complete('hello');
    expect(observed).toBe('custom:1');
  });

  it('options.ctx.cacheKey overrides cacheKeyFn', async () => {
    const stub = makeStubFetch({ text: 'hi' });
    let observed: string | undefined;
    const hooks = new HookBus();
    hooks.on('onBeforeSubmit', (ctx) => {
      observed = ctx.ctx.cacheKey;
    });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      hooks,
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
      cacheKeyFn: () => 'from-fn',
    });
    await client.complete('hello', { ctx: { cacheKey: 'override' } });
    expect(observed).toBe('override');
  });

  it('callId is minted per call', async () => {
    const stub = makeStubFetch({ text: 'hi' });
    const seen: string[] = [];
    const hooks = new HookBus();
    hooks.on('onBeforeSubmit', (ctx) => {
      if (ctx.ctx.callId) seen.push(ctx.ctx.callId);
    });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      hooks,
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
    });
    await client.complete('a');
    await client.complete('b');
    expect(seen.length).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('LLMClient.complete — fetch options propagation', () => {
  it('priority defaults to interactive in foreground mode', async () => {
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
    });
    await client.complete('hello');
    expect((stub.calls[0].opts as { priority?: number }).priority).toBe(1);
  });

  it('priority shifts to background in background mode', async () => {
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      mode: 'background',
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
    });
    await client.complete('hello');
    expect((stub.calls[0].opts as { priority?: number }).priority).toBe(2);
  });
});

describe('LLMClient.complete — adapter URL composition', () => {
  it('GET full URL = baseURL + completionPath', async () => {
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
    });
    await client.complete('hello');
    expect(stub.calls[0].req.url).toBe('https://mock.test/v1/complete');
  });

  it('adapter authHeaders are merged into request headers', async () => {
    const stub = makeStubFetch({ text: 'hi' });
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
    });
    await client.complete('hello');
    expect(stub.calls[0].req.headers).toMatchObject({ 'x-api-key': 'mock-key' });
  });
});

describe('LLMClient.stream — error when no fetchStream provided', () => {
  it('throws if stream() called without fetchStream config', async () => {
    const stub = makeStubFetch({});
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      adapter: makeMockAdapter(),
      fetch: stub.fetch,
    });
    const iter = client.stream('hi');
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(
      'no fetchStream function configured',
    );
  });
});
