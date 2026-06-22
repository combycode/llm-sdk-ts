/** route() — client-side fallback (V2) + openrouter passthrough (V1), through a
 *  real engine with a stubbed FetchFn (so error classification + retry policy
 *  behave as in production). */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import type { EngineHandle } from '../../../src/helpers/engine';
import { route } from '../../../src/helpers/route';
import { classifyError } from '../../../src/network/errors';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';
import type { EngineFetch } from '../../../src/network/types';

type Handler = (url: string, body: Record<string, unknown>) => { status: number; body: unknown };

/** Minimal fake engine. Its fetch mimics engine.fetch's contract: resolve only on
 *  2xx, otherwise throw a classified LLMError (as the real queue does). */
function engineWith(handler: Handler): EngineHandle {
  const fetch: EngineFetch = async (req) => {
    const { status, body } = handler(req.url, (req.body as Record<string, unknown>) ?? {});
    if (status >= 400) throw classifyError(req.provider, status, body, {});
    return { status, headers: {}, body };
  };
  return {
    apiKeys: { anthropic: 'k', openrouter: 'k' },
    fetch,
    fetchStream: () => (async function* () {})(),
    hooks: new HookBus(),
    catalog: new ModelCatalog(),
  } as unknown as EngineHandle;
}

const anthropicOk = (model: unknown) => ({
  id: 'x',
  model,
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
});
const notFound = (m: string) => ({
  status: 400,
  body: { error: { message: `model ${m} does not exist` } },
});

describe('route() — V2 client-side fallback', () => {
  it('falls over to the next model on a retryable error', async () => {
    const engine = engineWith((_url, body) =>
      body.model === 'bad' ? notFound('bad') : { status: 200, body: anthropicOk(body.model) },
    );
    const res = await route({
      models: ['anthropic/bad', 'anthropic/good'],
      engine,
      prompt: 'hi',
      maxTokens: 8,
    });
    expect(res.servedBy).toBe('anthropic/good');
    expect(res.text).toBe('ok');
    expect(res.attempts).toHaveLength(2);
    expect(res.attempts[0].kind).toBe('model_not_found');
  });

  it('fails fast on a non-retryable error (auth)', async () => {
    const engine = engineWith(() => ({ status: 401, body: { error: { message: 'bad key' } } }));
    await expect(
      route({ models: ['anthropic/a', 'anthropic/b'], engine, prompt: 'hi' }),
    ).rejects.toThrow(/bad key/);
  });

  it('throws an aggregate error when every model fails (retryably)', async () => {
    const engine = engineWith((_u, b) => notFound(String(b.model)));
    await expect(
      route({ models: ['anthropic/a', 'anthropic/b'], engine, prompt: 'hi' }),
    ).rejects.toThrow(/all 2 model/);
  });
});

describe('route() — V1 openrouter passthrough', () => {
  it('sends one request with a bare-id models array; servedBy = response.model', async () => {
    let captured: Record<string, unknown> | undefined;
    const engine = engineWith((url, body) => {
      if (url.includes('openrouter')) captured = body;
      return {
        status: 200,
        body: {
          id: 'x',
          model: 'openai/gpt-x',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      };
    });
    const res = await route({
      models: ['openrouter/openai/gpt-x', 'openrouter/google/gem'],
      engine,
      prompt: 'hi',
      maxTokens: 8,
    });
    expect(captured?.models).toEqual(['openai/gpt-x', 'google/gem']);
    expect(res.servedBy).toBe('openai/gpt-x');
    expect(res.attempts).toHaveLength(1); // single request, not sequential
  });
});
