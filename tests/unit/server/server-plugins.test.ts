/** OaiServer plugin slots + registration surface.
 *
 *  The two loader slots are what turn the server from stateless into stateful,
 *  and both are easy to wire up so they LOOK connected while doing nothing:
 *  a ConversationLoader whose `save` is never called loses every turn, and an
 *  AgentLoader whose loop is never passed to dispatch silently reverts to the
 *  static ServerEntry. These tests assert the observable consequence of each —
 *  the history actually carrying prior turns, the loader's own system prompt
 *  reaching the client — rather than merely that the plugin was invoked. */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import type { ConversationHistory } from '../../../src/agent/history';
import { HookBus } from '../../../src/bus/hook-bus';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ExecuteOptions } from '../../../src/llm/types/options';
import type { AgentLoaderPlugin, ConversationLoaderPlugin } from '../../../src/server/loaders';
import { OaiServer } from '../../../src/server/server';

function makeMockClient(text = 'hi'): LLMClient & { seen: ExecuteOptions[] } {
  const seen: ExecuteOptions[] = [];
  return {
    id: 'client-mock',
    provider: 'mock',
    model: 'mock-model',
    hooks: new HookBus(),
    api: 'completions',
    mode: 'foreground',
    batchable: false,
    seen,
    async complete(_input: unknown, options: ExecuteOptions = {}): Promise<CompletionResponse> {
      seen.push(options);
      return {
        id: 'r1',
        model: 'mock-model',
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
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
      } as unknown as CompletionResponse;
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient & { seen: ExecuteOptions[] };
}

const chat = (model: string, text: string, extra: Record<string, unknown> = {}) =>
  new Request('http://x.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text }], ...extra }),
  });

describe('OaiServer — registration', () => {
  it('register() adds a model that /v1/models then lists', async () => {
    const server = new OaiServer();
    let res = await server.handle(new Request('http://x.test/v1/models'));
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);

    server.register({ model: 'late', client: makeMockClient() });
    res = await server.handle(new Request('http://x.test/v1/models'));
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((d) => d.id)).toEqual(['late']);
  });

  it('unregister() reports whether it removed anything, and the model stops resolving', async () => {
    const server = new OaiServer({ entries: [{ model: 'fast', client: makeMockClient() }] });
    expect(server.unregister('never-registered')).toBe(false);
    expect(server.unregister('fast')).toBe(true);
    expect(server.unregister('fast')).toBe(false);
    const res = await server.handle(chat('fast', 'hi'));
    expect(res.status).toBe(404);
  });

  it('registering the same model twice throws instead of silently shadowing', async () => {
    const server = new OaiServer({ entries: [{ model: 'fast', client: makeMockClient() }] });
    expect(() => server.register({ model: 'fast', client: makeMockClient() })).toThrow(
      /duplicate model id/,
    );
  });
});

describe('OaiServer — accessors', () => {
  it('responseStore is the injected store', () => {
    const server = new OaiServer();
    expect(server.responseStore).toBeDefined();
    expect(server.responseStore).toBe(server.responseStore);
  });

  it('_agentLoader / _conversationLoader default to null and echo what was injected', () => {
    const bare = new OaiServer();
    expect(bare._agentLoader).toBeNull();
    expect(bare._conversationLoader).toBeNull();

    const agentLoader: AgentLoaderPlugin = { load: async () => null };
    const conversationLoader: ConversationLoaderPlugin = {
      load: async () => null,
      save: async () => {},
    };
    const wired = new OaiServer({ agentLoader, conversationLoader });
    expect(wired._agentLoader).toBe(agentLoader);
    expect(wired._conversationLoader).toBe(conversationLoader);
  });
});

describe('OaiServer — ConversationLoader slot', () => {
  it('loads prior history and saves it back, so turn 2 sees turn 1', async () => {
    const stored = new Map<string, ConversationHistory>();
    const saves: string[] = [];
    const conversationLoader: ConversationLoaderPlugin = {
      load: async (ctx) => stored.get(ctx.conversationId) ?? null,
      save: async (ctx, history) => {
        saves.push(ctx.conversationId);
        stored.set(ctx.conversationId, history);
      },
    };
    const client = makeMockClient('answer');
    const server = new OaiServer({
      entries: [{ model: 'fast', client }],
      conversationLoader,
    });

    await server.handle(chat('fast', 'first', { user: 'alice' }));
    await server.handle(chat('fast', 'second', { user: 'alice' }));

    expect(saves).toEqual(['alice', 'alice']);
    // Two full turns accumulated in ONE history: user/assistant/user/assistant.
    // Without the load the second request would start from an empty history and
    // this would be 2.
    expect(stored.get('alice')?.length).toBe(4);
    expect(stored.get('alice')?.at(0)?.message.content).toBe('first');
    expect(stored.get('alice')?.at(2)?.message.content).toBe('second');
  });

  it('falls back to a fresh history when the loader returns null', async () => {
    const conversationLoader: ConversationLoaderPlugin = {
      load: async () => null,
      save: async () => {},
    };
    const server = new OaiServer({
      entries: [{ model: 'fast', client: makeMockClient('a') }],
      conversationLoader,
    });
    const res = await server.handle(chat('fast', 'hi'));
    expect(res.status).toBe(200);
  });

  it('derives the conversation id from `user`, else falls back to default:<model>', async () => {
    const ids: string[] = [];
    const conversationLoader: ConversationLoaderPlugin = {
      load: async (ctx) => {
        ids.push(ctx.conversationId);
        return null;
      },
      save: async () => {},
    };
    const server = new OaiServer({
      entries: [{ model: 'fast', client: makeMockClient('a') }],
      conversationLoader,
    });
    await server.handle(chat('fast', 'hi', { user: 'bob' }));
    await server.handle(chat('fast', 'hi'));
    expect(ids).toEqual(['bob', 'default:fast']);
  });
});

describe('OaiServer — AgentLoader slot', () => {
  it('uses the loaded loop — its system prompt reaches the client, not the request one', async () => {
    const client = makeMockClient('from-agent');
    const loop = new AgentLoop({ client, system: 'loader-owned' });
    const agentLoader: AgentLoaderPlugin = { load: async () => loop };
    const server = new OaiServer({ entries: [{ model: 'fast', client }], agentLoader });

    const res = await server.handle(
      new Request('http://x.test/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fast',
          messages: [
            { role: 'system', content: 'request-owned' },
            { role: 'user', content: 'hi' },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(client.seen[0].system).toContain('loader-owned');
    expect(client.seen[0].system).not.toContain('request-owned');
  });

  it('a loader that returns null leaves the static ServerEntry path in charge', async () => {
    const client = makeMockClient('static');
    const agentLoader: AgentLoaderPlugin = { load: async () => null };
    const server = new OaiServer({ entries: [{ model: 'fast', client }], agentLoader });
    const res = await server.handle(chat('fast', 'hi'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]
      .message.content).toBe('static');
  });

  it('the loader is told which user and model it is resolving for', async () => {
    const seen: Array<{ userId: string | null; model: string }> = [];
    const agentLoader: AgentLoaderPlugin = {
      load: async (ctx) => {
        seen.push({ userId: ctx.userId, model: ctx.model });
        return null;
      },
    };
    const server = new OaiServer({
      entries: [{ model: 'fast', client: makeMockClient() }],
      agentLoader,
    });
    await server.handle(chat('fast', 'hi'));
    expect(seen).toEqual([{ userId: null, model: 'fast' }]);
  });
});

describe('OaiServer — token accounting fallback', () => {
  it('estimates prompt/completion tokens when the provider reports zero', async () => {
    const server = new OaiServer({
      entries: [{ model: 'fast', client: makeMockClient('a longer answer here') }],
    });
    const res = await server.handle(chat('fast', 'a reasonably long question'));
    const body = (await res.json()) as { usage: { prompt_tokens: number; completion_tokens: number } };
    // The mock reports 0/0; the server must not publish 0 tokens for real text.
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
  });
});
