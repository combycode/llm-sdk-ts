/** LLMClient unit tests with a mock provider adapter + stub fetch.
 *  Validates: input normalization, hook emission, model+system fixed at
 *  construction, fetch injection, ctx propagation, custom cacheKeyFn. */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { LLMClient } from '../../../src/llm/client';
import { InvalidFinalOutputError } from '../../../src/llm/output-errors';
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
    createStreamParser() {
      return () => [];
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

describe('LLMClient — structuredComplete (typed error + repair)', () => {
  /** Fetch that returns a queue of bodies (one per call), last repeats. */
  function makeQueuedFetch(texts: string[]): { fetch: EngineFetch; count: () => number } {
    let i = 0;
    return {
      count: () => i,
      fetch: async () => {
        const text = texts[Math.min(i, texts.length - 1)];
        i++;
        return Promise.resolve({ status: 200, headers: {}, body: { text } }) as Promise<HttpResponse>;
      },
    };
  }
  const mk = (fetch: EngineFetch) =>
    new LLMClient({ provider: 'anthropic', model: 'claude-3', apiKey: 'k', adapter: makeMockAdapter(), fetch });
  const SCHEMA = { type: 'object', properties: { n: { type: 'number' } } };

  it('parses valid JSON output', async () => {
    const client = mk(makeQueuedFetch(['{"n":1}']).fetch);
    expect(await client.structuredComplete<{ n: number }>('go', SCHEMA)).toEqual({ n: 1 });
  });

  it('throws InvalidFinalOutputError (with rawText) on unparseable output, no repair', async () => {
    const client = mk(makeQueuedFetch(['not json']).fetch);
    try {
      await client.structuredComplete('go', SCHEMA);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidFinalOutputError);
      expect((e as InvalidFinalOutputError).reason).toBe('invalid_final_output');
      expect((e as InvalidFinalOutputError).rawText).toBe('not json');
    }
  });

  it('repairAttempts retries and succeeds when a later attempt is valid', async () => {
    const qf = makeQueuedFetch(['oops', '{"n":7}']);
    const client = mk(qf.fetch);
    const out = await client.structuredComplete<{ n: number }>('go', SCHEMA, { structured: { schema: SCHEMA, repairAttempts: 1 } });
    expect(out).toEqual({ n: 7 });
    expect(qf.count()).toBe(2); // original + 1 repair
  });

  it('throws after repairs are exhausted', async () => {
    const qf = makeQueuedFetch(['bad', 'still bad', 'nope']);
    const client = mk(qf.fetch);
    await expect(
      client.structuredComplete('go', SCHEMA, { structured: { schema: SCHEMA, repairAttempts: 1 } }),
    ).rejects.toBeInstanceOf(InvalidFinalOutputError);
    expect(qf.count()).toBe(2); // original + 1 repair, then gives up
  });
});

// ─── assistantMessage / file retrieval / system extraction ────────────────

const mkClient = (over: Record<string, unknown> = {}) =>
  new LLMClient({
    provider: 'anthropic',
    model: 'claude-3',
    apiKey: 'sk-test',
    adapter: makeMockAdapter(),
    fetch: makeStubFetch({ text: 'hi' }).fetch,
    ...over,
  } as never);

describe('LLMClient — assistantMessage provenance', () => {
  const response = (over: Partial<CompletionResponse> = {}): CompletionResponse =>
    ({
      id: 'resp_abc',
      model: 'claude-3',
      content: [{ type: 'text', text: 'answer' }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      text: 'answer',
      toolCalls: [],
      thinking: null,
      media: [],
      latencyMs: 1,
      raw: null,
      ...over,
    }) as CompletionResponse;

  it('stamps role, content, id and the origin provider/model', () => {
    const m = mkClient().assistantMessage(response());
    expect(m.role).toBe('assistant');
    expect(m.content).toEqual([{ type: 'text', text: 'answer' }]);
    expect(m.id).toBe('resp_abc');
    expect(m.origin).toMatchObject({ provider: 'anthropic', model: 'claude-3' });
    expect(m.createdAt).toBeGreaterThan(0);
  });

  it('a STATELESS api carries no serverStateId — resending it would be a 400', () => {
    // api defaults to `messages` for anthropic.
    expect((mkClient().assistantMessage(response()).origin as { serverStateId?: string }).serverStateId)
      .toBeUndefined();
  });

  it('a STATEFUL api (responses) carries the response id as serverStateId', () => {
    const m = mkClient({ provider: 'openai', api: 'responses' }).assistantMessage(response());
    expect((m.origin as { serverStateId?: string }).serverStateId).toBe('resp_abc');
  });

  it('a stateful response with NO id gets a generated message id and no serverStateId', () => {
    const m = mkClient({ provider: 'openai', api: 'responses' }).assistantMessage(response({ id: '' }));
    expect(m.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((m.origin as { serverStateId?: string }).serverStateId).toBeUndefined();
  });
});

describe('LLMClient — file retrieval delegation', () => {
  it('retrieveFile fetches through THIS client provider, key and baseURL', async () => {
    const seen: HttpRequest[] = [];
    const fetch: EngineFetch = async (req) => {
      seen.push(req);
      return { status: 200, headers: { 'content-type': 'image/png' }, body: new Uint8Array([1, 2]).buffer } as HttpResponse;
    };
    const client = mkClient({ fetch });
    const file = await client.retrieveFile({ id: 'file_1' } as never);
    expect(seen[0].headers['x-api-key']).toBe('sk-test');
    expect(seen[0].url).toContain('/v1/files/file_1/content');
    expect(file.mimeType).toBe('image/png');
    expect(file.size).toBe(2);
  });

  it('streamFile uses the same context and returns a stream', async () => {
    const seen: HttpRequest[] = [];
    const fetch: EngineFetch = async (req) => {
      seen.push(req);
      return {
        status: 200,
        headers: { 'content-type': 'text/csv', 'content-length': '3' },
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]));
            c.close();
          },
        }),
      } as unknown as HttpResponse;
    };
    const s = await mkClient({ fetch }).streamFile({ id: 'file_2' } as never);
    expect(seen[0].headers['x-api-key']).toBe('sk-test');
    expect(seen[0].responseType).toBe('stream');
    expect(s.mimeType).toBe('text/csv');
    expect(s.size).toBe(3);
    expect(s.stream).toBeInstanceOf(ReadableStream);
  });
});

describe('LLMClient — system extraction from message content parts', () => {
  it('a system message given as CONTENT PARTS is flattened into the system text', async () => {
    const adapter = makeMockAdapter();
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      adapter,
      fetch: makeStubFetch({ text: 'ok' }).fetch,
    } as never);
    await client.complete([
      { role: 'system', content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] },
      { role: 'user', content: 'hi' },
    ] as Message[]);
    expect(adapter.lastRequest?.system).toBe('line one\nline two');
    // The system message must not also reach the adapter as a message.
    expect(adapter.lastRequest?.messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('a system message whose parts hold no text contributes nothing', async () => {
    const adapter = makeMockAdapter();
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      adapter,
      fetch: makeStubFetch({ text: 'ok' }).fetch,
    } as never);
    await client.complete([
      { role: 'system', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] },
      { role: 'user', content: 'hi' },
    ] as Message[]);
    expect(adapter.lastRequest?.system).toBeUndefined();
  });
});

describe('LLMClient — adapter is mandatory', () => {
  it('neither adapter nor fetch is caught at construction', () => {
    expect(
      () => new LLMClient({ provider: 'anthropic', model: 'claude-3', apiKey: 'k' } as never),
    ).toThrow('LLMClient: adapter (or factory) is required');
  });

  it('a fetch WITHOUT an adapter is caught by the resolver, naming both accepted forms', () => {
    // The constructor guard only fires when BOTH are absent, so this pair reaches
    // resolveAdapter — which has to say that a factory is acceptable too, or the
    // caller reads the message as "adapters are required" and gives up.
    expect(
      () =>
        new LLMClient({
          provider: 'anthropic',
          model: 'claude-3',
          apiKey: 'k',
          fetch: makeStubFetch({}).fetch,
        } as never),
    ).toThrow('LLMClient: adapter or AdapterFactory must be supplied');
  });

  it('an AdapterFactory is called with provider, key, api and baseURL', () => {
    const seen: unknown[][] = [];
    new LLMClient({
      provider: 'anthropic',
      model: 'claude-3',
      apiKey: 'k',
      baseURL: 'https://custom',
      adapter: (...args: unknown[]) => {
        seen.push(args);
        return makeMockAdapter();
      },
      fetch: makeStubFetch({}).fetch,
    } as never);
    expect(seen[0]).toEqual(['anthropic', 'k', 'messages', 'https://custom']);
  });
});
