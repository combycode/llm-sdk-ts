/** createLLM + createAgent + createServer integration tests. */

import { describe, expect, it } from 'bun:test';
import { createAgent } from '../../../src/helpers/agent';
import { coreRegistry, createEngine } from '../../../src/helpers/engine';
import { createLLM } from '../../../src/helpers/llm';
import { createServer } from '../../../src/helpers/server';
import type { ProviderAdapter, ProviderHttpRequest } from '../../../src/llm/types/provider';
import type { NormalizedRequest } from '../../../src/llm/types/request';
import type { CompletionResponse } from '../../../src/llm/types/response';

function makeMockAdapter(): ProviderAdapter {
  return {
    name: 'anthropic' as const,
    buildRequest(_req: NormalizedRequest): ProviderHttpRequest {
      return { body: { ok: 1 } };
    },
    parseResponse(_raw: unknown, latencyMs: number): CompletionResponse {
      return {
        id: 'r',
        model: 'mock',
        content: [{ type: 'text', text: 'helper-ok' }],
        finishReason: 'stop',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        text: 'helper-ok',
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs,
        raw: null,
      };
    },
    parseStreamEvent: () => [],
    authHeaders: () => ({ 'x-api-key': 'mock' }),
    baseURL: () => 'https://mock.test',
    completionPath: () => '/m',
  };
}

describe('createLLM', () => {
  it('builds an LLMClient using the engine fetch', () => {
    coreRegistry.clear();
    const engine = createEngine();
    const llm = createLLM({
      provider: 'anthropic',
      model: 'm',
      apiKey: 'k',
      adapter: makeMockAdapter(),
      engine,
    });
    expect(llm.model).toBe('m');
    expect(llm.provider).toBe('anthropic');
    expect(llm.hooks).toBe(engine.hooks);
    coreRegistry.clear();
  });

  it('falls back to coreRegistry default when no engine passed', () => {
    coreRegistry.clear();
    const llm = createLLM({
      provider: 'anthropic',
      model: 'm',
      apiKey: 'k',
      adapter: makeMockAdapter(),
    });
    expect(coreRegistry.has()).toBe(true);
    // hooks should be the default engine's hooks
    expect(llm.hooks).toBe(coreRegistry.get().hooks);
    coreRegistry.clear();
  });
});

describe('createAgent', () => {
  it('builds an AgentLoop from explicit client', () => {
    coreRegistry.clear();
    const engine = createEngine();
    const llm = createLLM({
      provider: 'anthropic',
      model: 'm',
      apiKey: 'k',
      adapter: makeMockAdapter(),
      engine,
    });
    const agent = createAgent({ client: llm, engine });
    expect(agent.client).toBe(llm);
    expect(agent.hooks).toBe(engine.hooks);
    coreRegistry.clear();
  });

  it('builds an AgentLoop from inline provider/model/apiKey (auto-creates LLM)', () => {
    coreRegistry.clear();
    const agent = createAgent({
      provider: 'anthropic',
      model: 'm',
      apiKey: 'k',
      clientOptions: { adapter: makeMockAdapter() },
    });
    expect(agent.client).toBeDefined();
    coreRegistry.clear();
  });

  it('throws when neither client nor model provided', () => {
    coreRegistry.clear();
    expect(() => createAgent({})).toThrow(/client.*model/);
    coreRegistry.clear();
  });
});

describe('createServer', () => {
  it('builds an OaiServer with engine hooks', () => {
    coreRegistry.clear();
    const engine = createEngine();
    const server = createServer({ engine });
    expect(server.hooks).toBe(engine.hooks);
    coreRegistry.clear();
  });

  it('uses engine persistence for ResponseStore by default', async () => {
    coreRegistry.clear();
    const engine = createEngine({ persistence: { type: 'memory' } });
    const server = createServer({ engine });
    expect(server.responseStore).toBeDefined();
    coreRegistry.clear();
  });
});
