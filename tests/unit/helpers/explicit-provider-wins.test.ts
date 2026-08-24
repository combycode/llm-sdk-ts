/** An explicitly passed provider decides where the request goes — and where the
 *  API key goes with it.
 *
 *  `resolveModel` used to read the model's `vendor/` prefix FIRST and fall back to
 *  the explicit `provider` only for a bare id. Every OpenRouter model id is
 *  `vendor/model`, so the most ordinary OpenRouter call there is —
 *
 *      createLLM({ provider: 'openrouter', model: 'openai/gpt-5.4-nano' })
 *
 *  — resolved to the provider `openai` and sent the **OpenRouter key to
 *  api.openai.com**, which answered "Incorrect API key provided: sk-or-v1…".
 *  That is a credential handed to the wrong company, not a routing inconvenience.
 *
 *  A vendor outside our five failed differently and no better: the prefix was cast
 *  to a `ProviderName`, so `qwen/qwen3` produced a provider literally named
 *  `qwen` and died later as "no default adapter for provider 'qwen'".
 *
 *  Found by the response corpus: it was the only target that could not record.
 */
import { describe, expect, it } from 'bun:test';
import { resolveModel } from '../../../src/helpers/client-resolver';
import { createEngine, createLLM } from '../../../src/index';

describe('resolveModel — an explicit provider wins', () => {
  it('keeps openrouter when the model is vendor-prefixed', () => {
    expect(resolveModel('openai/gpt-5.4-nano', 'openrouter', 'test')).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-5.4-nano',
    });
  });

  it('keeps a vendor our five do not contain', () => {
    expect(resolveModel('qwen/qwen3-max', 'openrouter', 'test')).toEqual({
      provider: 'openrouter',
      model: 'qwen/qwen3-max',
    });
  });

  it('strips a redundant leading provider segment', () => {
    // The catalog's own slug form for OpenRouter models.
    expect(resolveModel('openrouter/openai/gpt-5.4-nano', 'openrouter', 'test')).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-5.4-nano',
    });
    expect(resolveModel('openai/gpt-5.4-nano', 'openai', 'test')).toEqual({
      provider: 'openai',
      model: 'gpt-5.4-nano',
    });
  });

  it('still reads the prefix when no provider is given', () => {
    expect(resolveModel('anthropic/claude-haiku-4.5', undefined, 'test')).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4.5',
    });
  });

  it('still parses an unknown prefix when no provider is given', () => {
    // Deliberately permissive: `estimate()` prices models catalogued under a
    // provider nobody can CALL (a private deployment, a fixture), so rejecting
    // an unknown prefix here would break costing a model you never send. It
    // fails where it matters instead — in the adapter factory, when something
    // actually tries to build a client for it.
    expect(resolveModel('qwen/qwen3-max', undefined, 'test')).toEqual({
      provider: 'qwen' as never,
      model: 'qwen3-max',
    });
  });

  it('still requires a provider for a bare model', () => {
    expect(() => resolveModel('gpt-5.4-nano', undefined, 'test')).toThrow(/requires a provider/);
  });
});

describe('the key follows the provider that was asked for', () => {
  it('sends an openrouter client to openrouter.ai, not to the vendor in the model id', async () => {
    // Captured at the transport, not off the bus: the bus deliberately never
    // carries headers, and the header is where the credential is. This is the
    // exact evidence the leak needed — who received the key.
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const fetchSpy = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      seenUrl = String(url);
      seenHeaders = init?.headers ?? {};
      return new Response(JSON.stringify({ id: 'x', model: 'm', choices: [], usage: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const engine = createEngine({ registerAsDefault: false, fetch: fetchSpy });
    const llm = createLLM({
      engine,
      provider: 'openrouter',
      model: 'openai/gpt-5.4-nano',
      apiKey: 'sk-or-v1-test-key',
    } as never);

    await llm.complete('hi', { maxTokens: 4 }).catch(() => undefined);

    expect(seenUrl).toContain('openrouter.ai');
    expect(seenUrl).not.toContain('api.openai.com');

    // Whichever header the provider uses, the key must have gone to OpenRouter and
    // nowhere else. Before the fix this same assertion held a real OpenRouter
    // credential in a request addressed to api.openai.com.
    const carrying = Object.values(seenHeaders).filter((v) => String(v).includes('sk-or-v1-test-key'));
    expect(carrying.length).toBeGreaterThan(0);

    await engine.destroy();
  });
});
