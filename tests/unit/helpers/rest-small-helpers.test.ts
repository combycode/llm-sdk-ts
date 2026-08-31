/** Remaining helper gaps: listModels, createLLM key/adapter resolution, embed's
 *  adapter table, chain/parallel LLM steps, the Estimator hook subscription,
 *  the calibration store's read side, and two select() filter forms.
 *
 *  Each block states the contract a port has to reproduce; none of them touches
 *  the network. */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../src/catalog/catalog';
import { listModels } from '../../../src/helpers/models';
import { createLLM } from '../../../src/helpers/llm';
import { embed } from '../../../src/helpers/embed';
import { chain } from '../../../src/helpers/chain';
import { parallel } from '../../../src/helpers/parallel';
import { Estimator, observationFromCompletion } from '../../../src/helpers/estimator';
import {
  OutputCalibrationStore,
  calibrationKey,
  inputBucketLabel,
} from '../../../src/helpers/calibration-store';
import { MemoryPersistence } from '../../../src/plugins/persistence/memory';
import { selectModels } from '../../../src/helpers/select-model';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { XAIAdapter } from '../../../src/llm/providers/xai/completions';
import { XAIResponsesAdapter } from '../../../src/llm/providers/xai/responses';
import type { EngineHandle } from '../../../src/helpers/engine';
import type { EngineFetch, HttpRequest, HttpResponse } from '../../../src/network/types';
import type { CompletionContext } from '../../../src/bus/hook-map';
import type { ProviderAdapter } from '../../../src/llm/types/provider';

// ─── Shared engine stub ───────────────────────────────────────────────────────

function stubEngine(
  opts: {
    apiKeys?: Record<string, string>;
    catalog?: ModelCatalog;
    fetch?: EngineFetch;
    hooks?: HookBus;
  } = {},
): EngineHandle {
  return {
    apiKeys: opts.apiKeys ?? { anthropic: 'k', openai: 'k', google: 'k', xai: 'k', openrouter: 'k' },
    catalog: opts.catalog ?? new ModelCatalog(),
    hooks: opts.hooks ?? new HookBus(),
    fetch: opts.fetch ?? (async () => ({ status: 200, headers: {}, body: {} })),
    fetchStream: async function* () {},
    sessionId: 'sess_small',
    destroy: () => {},
  } as unknown as EngineHandle;
}

/** Which adapter class a client ended up with. */
function adapterOf(client: { destroy(): void }): ProviderAdapter {
  return (client as unknown as { adapter: ProviderAdapter }).adapter;
}

// ─── listModels ───────────────────────────────────────────────────────────────

describe('listModels()', () => {
  it('returns the engine catalog contents', () => {
    const catalog = new ModelCatalog();
    catalog.set('anthropic', 'claude-haiku-4-5', { pricing: { inputPerMTok: 0.25 } });
    catalog.set('openai', 'gpt-5-nano', { pricing: { inputPerMTok: 0.05 } });
    const models = listModels({ engine: stubEngine({ catalog }) });
    expect(models.map((m) => m.model).sort()).toEqual(['claude-haiku-4-5', 'gpt-5-nano']);
  });

  it('narrows to one provider when asked', () => {
    const catalog = new ModelCatalog();
    catalog.set('anthropic', 'claude-haiku-4-5', { pricing: {} });
    catalog.set('openai', 'gpt-5-nano', { pricing: {} });
    const models = listModels({ provider: 'openai', engine: stubEngine({ catalog }) });
    expect(models.map((m) => m.model)).toEqual(['gpt-5-nano']);
  });

  it('returns an empty list for an empty catalog rather than throwing', () => {
    expect(listModels({ engine: stubEngine({ catalog: new ModelCatalog() }) })).toEqual([]);
  });
});

// ─── createLLM ────────────────────────────────────────────────────────────────

describe('createLLM() — key resolution', () => {
  it('throws when neither opts.apiKey nor engine.apiKeys has the provider', () => {
    expect(() =>
      createLLM({ model: 'anthropic/claude-haiku-4-5', engine: stubEngine({ apiKeys: {} }) }),
    ).toThrow(
      /createLLM: no API key for provider "anthropic"\. Pass apiKey directly or set engine\.apiKeys\["anthropic"\] via createEngine\./,
    );
  });

  it('a direct apiKey works with an engine that has none', () => {
    const client = createLLM({
      model: 'anthropic/claude-haiku-4-5',
      apiKey: 'direct',
      engine: stubEngine({ apiKeys: {} }),
    });
    expect((client as unknown as { apiKey: string }).apiKey).toBe('direct');
    client.destroy();
  });
});

describe('createLLM() — default adapter per provider', () => {
  it('anthropic gets the Messages adapter', () => {
    const client = createLLM({ model: 'anthropic/claude-haiku-4-5', engine: stubEngine() });
    expect(adapterOf(client)).toBeInstanceOf(AnthropicAdapter);
    client.destroy();
  });

  it('xai picks the chat adapter by default and the responses adapter when pinned', () => {
    const chat = createLLM({ model: 'xai/grok-4', api: 'completions', engine: stubEngine() });
    expect(adapterOf(chat)).toBeInstanceOf(XAIAdapter);
    chat.destroy();

    const responses = createLLM({ model: 'xai/grok-4', api: 'responses', engine: stubEngine() });
    expect(adapterOf(responses)).toBeInstanceOf(XAIResponsesAdapter);
    responses.destroy();
  });

  it('an unknown provider fails with a message naming it', () => {
    expect(() =>
      createLLM({
        model: 'qwen/qwen3',
        apiKey: 'k',
        engine: stubEngine({ apiKeys: { qwen: 'k' } as Record<string, string> }),
      }),
    ).toThrow(/createLLM: no default adapter for provider 'qwen'/);
  });
});

// ─── embed adapter table ──────────────────────────────────────────────────────

describe('embed() — auto-built provider adapter', () => {
  function capturing(body: unknown): { fetch: EngineFetch; urls: string[] } {
    const urls: string[] = [];
    const fetch: EngineFetch = async (req: HttpRequest): Promise<HttpResponse> => {
      urls.push(req.url);
      return { status: 200, headers: {}, body };
    };
    return { fetch, urls };
  }

  it('openai → api.openai.com/v1/embeddings', async () => {
    const cap = capturing({ data: [{ embedding: [1, 2] }], model: 'm', usage: { prompt_tokens: 3 } });
    const res = await embed({
      model: 'openai/text-embedding-3-small',
      input: 'hi',
      engine: stubEngine({ fetch: cap.fetch }),
    });
    expect(cap.urls[0]).toBe('https://api.openai.com/v1/embeddings');
    expect(res.embeddings).toEqual([[1, 2]]);
  });

  it('openrouter → openrouter.ai/api/v1/embeddings (OpenAI-compatible)', async () => {
    const cap = capturing({ data: [{ embedding: [0.5] }], model: 'm' });
    const res = await embed({
      model: 'openrouter/text-embedding-3-small',
      input: 'hi',
      engine: stubEngine({ fetch: cap.fetch }),
    });
    expect(cap.urls[0]).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(res.embeddings).toEqual([[0.5]]);
  });

  it('google → generativelanguage embedContent, one call per input', async () => {
    const cap = capturing({ embedding: { values: [0.1, 0.2, 0.3] } });
    const res = await embed({
      model: 'google/gemini-embedding-001',
      input: ['a', 'b'],
      engine: stubEngine({ fetch: cap.fetch }),
    });
    expect(cap.urls).toHaveLength(2);
    expect(cap.urls[0]).toContain('generativelanguage.googleapis.com');
    expect(cap.urls[0]).toContain('embedContent');
    expect(res.dimensions).toBe(3);
  });

  it('a provider with no embeddings endpoint is refused, listing the ones that work', async () => {
    await expect(
      embed({ model: 'anthropic/whatever', input: 'hi', engine: stubEngine() }),
    ).rejects.toThrow(
      /embed: no embedding adapter for provider "anthropic" \(supported: openai, openrouter, google\)\./,
    );
  });
});

// ─── chain / parallel LLM steps ───────────────────────────────────────────────

/** An engine whose completions echo the request's last user text, so a step's
 *  output is traceable back to the prompt that produced it. */
function echoEngine(): EngineHandle {
  const fetch: EngineFetch = async (req): Promise<HttpResponse> => {
    const body = req.body as { messages: Array<{ content: unknown }> };
    const last = body.messages[body.messages.length - 1].content;
    const text = typeof last === 'string' ? last : (last as Array<{ text: string }>)[0].text;
    return {
      status: 200,
      headers: {},
      body: {
        id: 'msg_x',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: `<${text}>` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
  };
  return stubEngine({ fetch });
}

const LLM_STEP = { model: 'anthropic/claude-haiku-4-5' } as const;

describe('chain() — LLM steps', () => {
  it('feeds each step’s reply into the next step’s prompt builder', async () => {
    const engine = echoEngine();
    const run = chain([
      { ...LLM_STEP, engine, prompt: (input) => `A:${input}` },
      { ...LLM_STEP, engine, prompt: (input) => `B:${input}` },
    ]);
    expect(await run('seed')).toBe('<B:<A:seed>>');
  });

  it('reports the step name from the config through onStep', async () => {
    const engine = echoEngine();
    const seen: Array<{ index: number; name?: string; output: string }> = [];
    const run = chain(
      [
        { ...LLM_STEP, engine, name: 'summarise', prompt: (i) => i },
        async (i: string) => `${i}!`,
      ],
      { onStep: (info) => seen.push(info) },
    );
    await run('x');
    expect(seen[0]).toEqual({ index: 0, name: 'summarise', output: '<x>' });
    // A plain function step has no name.
    expect(seen[1]).toEqual({ index: 1, name: undefined, output: '<x>!' });
  });

  it('does not forward `name` to the completion call as a request field', async () => {
    let sent: Record<string, unknown> = {};
    const engine = stubEngine({
      fetch: async (req) => {
        sent = req.body as Record<string, unknown>;
        return {
          status: 200,
          headers: {},
          body: {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude-haiku-4-5',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
      },
    });
    await chain([{ ...LLM_STEP, engine, name: 'step-one', prompt: () => 'p' }])('x');
    expect(sent.name).toBeUndefined();
  });
});

describe('parallel() — LLM steps', () => {
  it('runs every step against the SAME input and returns outputs in step order', async () => {
    const engine = echoEngine();
    const run = parallel([
      { ...LLM_STEP, engine, prompt: (input) => `A:${input}` },
      async (input: string) => `fn:${input}`,
      { ...LLM_STEP, engine, prompt: (input) => `C:${input}` },
    ]);
    expect(await run('seed')).toEqual(['<A:seed>', 'fn:seed', '<C:seed>']);
  });

  it('passes the config name through onStep', async () => {
    const engine = echoEngine();
    const seen: Array<{ index: number; name?: string; output: string }> = [];
    await parallel([{ ...LLM_STEP, engine, name: 'draft', prompt: (i) => i }], {
      onStep: (info) => seen.push(info),
    })('x');
    expect(seen).toEqual([{ index: 0, name: 'draft', output: '<x>' }]);
  });
});

// ─── Estimator hook subscription ──────────────────────────────────────────────

function completionCtx(over: Partial<{ inputTokens: number; outputTokens: number; estimated: number }> = {}) {
  return {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    response: {
      usage: {
        inputTokens: over.inputTokens ?? 1200,
        outputTokens: over.outputTokens ?? 300,
      },
    },
    request: { estimatedInputTokens: over.estimated ?? 999 },
    ctx: {},
  } as unknown as CompletionContext;
}

describe('Estimator.subscribeToHooks()', () => {
  it('records an observation for each completion on the bus', async () => {
    const hooks = new HookBus();
    const estimator = new Estimator({ calibration: { store: 'memory' } });
    const unsub = estimator.subscribeToHooks(hooks);

    // Same input-size bucket as the tiny prompt below, or the lookup misses.
    hooks.emitSync('onCompletion', completionCtx({ inputTokens: 100, outputTokens: 300 }));
    await new Promise((r) => setTimeout(r, 10));

    const est = await estimator.estimate(
      { model: 'anthropic/claude-haiku-4-5', prompt: 'x' },
      { engine: stubEngine({ catalog: catalogWithHaiku() }) },
    );
    expect(est.assumptions.some((a) => a.includes('calibrated: expected from 1 samples'))).toBe(true);
    expect(est.estOutputTokens).toBe(300);
    unsub();
  });

  it('the returned unsubscribe detaches the handler', () => {
    const hooks = new HookBus();
    const estimator = new Estimator({ calibration: { store: 'memory' } });
    const unsub = estimator.subscribeToHooks(hooks);
    expect(typeof unsub).toBe('function');
    unsub();
    // No listener left, so emitting must not reach the estimator at all.
    expect(() => hooks.emitSync('onCompletion', completionCtx())).not.toThrow();
  });
});

function catalogWithHaiku(): ModelCatalog {
  const cat = new ModelCatalog();
  cat.set('anthropic', 'claude-haiku-4-5', {
    pricing: { inputPerMTok: 0.25, outputPerMTok: 1.25 },
    maxOutput: 4096,
  });
  return cat;
}

describe('observationFromCompletion()', () => {
  it('maps provider/model and both token counts straight across', () => {
    expect(observationFromCompletion(completionCtx())).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      inputTokens: 1200,
      outputTokens: 300,
    });
  });

  it('falls back to the ESTIMATED input tokens when the provider reported zero', () => {
    // Providers that omit input token counts must not poison the input bucket
    // with a 0 — the estimate we made is the best number available.
    expect(observationFromCompletion(completionCtx({ inputTokens: 0, estimated: 777 })).inputTokens)
      .toBe(777);
  });
});

// ─── Calibration store read side ──────────────────────────────────────────────

describe('OutputCalibrationStore — p90 and listKeys', () => {
  it('p90 returns the midpoint of the bin holding the 90th percentile', async () => {
    const store = new OutputCalibrationStore(new MemoryPersistence());
    // 10 observations: eight in bin 0 (<256), two in bin 3 (768-1023). The 90th
    // percentile (target 9) falls in bin 3, whose midpoint is 3.5 * 256.
    for (let i = 0; i < 8; i++) {
      await store.record({ provider: 'p', model: 'm', inputTokens: 100, outputTokens: 10 });
    }
    await store.record({ provider: 'p', model: 'm', inputTokens: 100, outputTokens: 800 });
    await store.record({ provider: 'p', model: 'm', inputTokens: 100, outputTokens: 900 });

    const entry = (await store.get('p', 'm', 100))!;
    expect(entry.count).toBe(10);
    expect(store.p90(entry)).toBe(3.5 * 256);
  });

  it('p90 of an empty histogram is 0, not NaN', () => {
    const store = new OutputCalibrationStore(new MemoryPersistence());
    expect(store.p90({ histogram: new Array(32).fill(0) } as never)).toBe(0);
  });

  it('listKeys returns the full namespaced keys that were written', async () => {
    const store = new OutputCalibrationStore(new MemoryPersistence());
    await store.record({ provider: 'anthropic', model: 'haiku', inputTokens: 100, outputTokens: 50 });
    await store.record({ provider: 'openai', model: 'nano', inputTokens: 100_000, outputTokens: 50 });

    expect((await store.listKeys()).sort()).toEqual(
      [
        calibrationKey('anthropic', 'haiku', inputBucketLabel(100)),
        calibrationKey('openai', 'nano', inputBucketLabel(100_000)),
      ].sort(),
    );
  });

  it('listKeys is empty before anything is recorded', async () => {
    expect(await new OutputCalibrationStore(new MemoryPersistence()).listKeys()).toEqual([]);
  });
});

// ─── select() filter forms ────────────────────────────────────────────────────

describe('selectModels() — filter edge forms', () => {
  function engineWithDefaults(): EngineHandle {
    const catalog = new ModelCatalog();
    catalog.loadProviderDefaults();
    return { catalog, apiKeys: { anthropic: 'k', openai: 'k', google: 'k', xai: 'k' } } as unknown as EngineHandle;
  }

  it('a bare numeric context value means "at least that many tokens"', () => {
    const engine = engineWithDefaults();
    const picked = selectModels('type:chat; context:100k', { engine });
    expect(picked.length).toBeGreaterThan(0);
    for (const m of picked) expect(m.contextWindow!).toBeGreaterThanOrEqual(100_000);
    // And it really is a filter: a huge floor must exclude more than a small one.
    expect(selectModels('type:chat; context:5M', { engine }).length).toBeLessThan(picked.length);
  });

  it('an unrecognised price word matches nothing rather than everything', () => {
    const engine = engineWithDefaults();
    expect(selectModels('type:chat', { engine }).length).toBeGreaterThan(0);
    expect(selectModels('type:chat; price:bargain', { engine })).toEqual([]);
  });
});
