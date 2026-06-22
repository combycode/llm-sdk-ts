/** OaiServer integration test using `server.handle(request)` directly
 *  (avoids binding a TCP port). */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ExecuteOptions } from '../../../src/llm/types/options';
import { BearerKeyAuth } from '../../../src/server/auth';
import { OaiServer } from '../../../src/server/server';

function makeMockClient(text: string): LLMClient {
  return {
    id: 'client-mock',
    provider: 'mock' as const,
    model: 'mock-model',
    system: undefined,
    hooks: new HookBus(),
    api: 'completions' as const,
    mode: 'foreground' as const,
    batchable: false,
    async complete(_input: unknown, _options: ExecuteOptions = {}): Promise<CompletionResponse> {
      return {
        id: 'r1',
        model: 'mock-model',
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          totalTokens: 8,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        text,
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      } as CompletionResponse;
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
}

describe('OaiServer — routing', () => {
  it('GET /health returns 200', async () => {
    const server = new OaiServer();
    const res = await server.handle(new Request('http://x.test/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /v1/models lists registered entries', async () => {
    const server = new OaiServer({
      entries: [{ model: 'fast', client: makeMockClient('') }],
    });
    const res = await server.handle(new Request('http://x.test/v1/models'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe('list');
    expect(body.data.map((d) => d.id)).toEqual(['fast']);
  });

  it('unknown route returns 404', async () => {
    const server = new OaiServer();
    const res = await server.handle(new Request('http://x.test/v1/nope'));
    expect(res.status).toBe(404);
  });

  it('OPTIONS responds 204 with CORS headers', async () => {
    const server = new OaiServer();
    const res = await server.handle(
      new Request('http://x.test/v1/chat/completions', { method: 'OPTIONS' }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('OaiServer — chat completions', () => {
  it('runs request and returns OAI-shaped response', async () => {
    const server = new OaiServer({
      entries: [{ model: 'fast', client: makeMockClient('Hi there!') }],
    });
    const req = new Request('http://x.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'fast',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await server.handle(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('Hi there!');
  });

  it('returns 404 for unknown model', async () => {
    const server = new OaiServer({});
    const req = new Request('http://x.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const res = await server.handle(req);
    expect(res.status).toBe(404);
  });

  it('returns 400 on malformed body', async () => {
    const server = new OaiServer();
    const req = new Request('http://x.test/v1/chat/completions', {
      method: 'POST',
      body: 'not json',
    });
    const res = await server.handle(req);
    expect(res.status).toBe(400);
  });
});

describe('OaiServer — auth', () => {
  it('rejects request without bearer when auth attached', async () => {
    const server = new OaiServer({
      auth: new BearerKeyAuth({ keys: { 'sk-x': 'u' } }),
      entries: [{ model: 'fast', client: makeMockClient('hi') }],
    });
    const res = await server.handle(new Request('http://x.test/health'));
    expect(res.status).toBe(401);
  });

  it('emits onAuthFail on bad key', async () => {
    const fails: unknown[] = [];
    const hooks = new HookBus();
    hooks.on('onAuthFail', (ctx) => {
      fails.push(ctx);
    });
    const server = new OaiServer({
      hooks,
      auth: new BearerKeyAuth({ keys: { 'sk-x': 'u' } }),
    });
    await server.handle(
      new Request('http://x.test/health', { headers: { authorization: 'Bearer wrong' } }),
    );
    expect(fails.length).toBe(1);
  });

  it('accepts known bearer key', async () => {
    const server = new OaiServer({
      auth: new BearerKeyAuth({ keys: { 'sk-good': 'alice' } }),
      entries: [{ model: 'fast', client: makeMockClient('hi') }],
    });
    const res = await server.handle(
      new Request('http://x.test/v1/models', {
        headers: { authorization: 'Bearer sk-good' },
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe('OaiServer — server hooks', () => {
  it('emits onServerRequest and onServerResponse', async () => {
    const hooks = new HookBus();
    const reqs: unknown[] = [];
    const resps: unknown[] = [];
    hooks.on('onServerRequest', (c) => {
      reqs.push(c);
    });
    hooks.on('onServerResponse', (c) => {
      resps.push(c);
    });
    const server = new OaiServer({ hooks });
    await server.handle(new Request('http://x.test/health'));
    expect(reqs.length).toBe(1);
    expect(resps.length).toBe(1);
  });
});
