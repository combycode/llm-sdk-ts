import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import type { CompletionContext } from '../../../../src/bus/hook-map';
import { CostCollector } from '../../../../src/plugins/cost-collector/collector';
import { ModelCatalog } from '../../../../src/plugins/model-catalog/catalog';

function makeCompletionCtx(opts: {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  raw?: unknown;
}): CompletionContext {
  return {
    provider: opts.provider,
    model: opts.model,
    response: {
      id: 'r',
      model: opts.model,
      content: [],
      finishReason: 'stop',
      usage: {
        inputTokens: opts.inputTokens ?? 0,
        outputTokens: opts.outputTokens ?? 0,
        totalTokens: (opts.inputTokens ?? 0) + (opts.outputTokens ?? 0),
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        audioInputTokens: opts.audioInputTokens,
        audioOutputTokens: opts.audioOutputTokens,
      },
      text: '',
      toolCalls: [],
      thinking: null,
      media: [],
      latencyMs: 1,
      raw: opts.raw ?? null,
    },
    request: {
      estimatedInputTokens: opts.inputTokens ?? 0,
      inputChars: 0,
      messageCount: 1,
      hasTools: false,
    },
    ctx: {},
  };
}

describe('CostCollector', () => {
  it('subscribes to onCompletion and writes ledger entry on emit', async () => {
    const hooks = new HookBus();
    const catalog = new ModelCatalog();
    catalog.set('anthropic', 'claude-x', {
      pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    });
    const collector = new CostCollector({ hooks, catalog });

    await hooks.emit(
      'onCompletion',
      makeCompletionCtx({
        provider: 'anthropic',
        model: 'claude-x',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      }),
    );

    expect(collector.entryCount).toBe(1);
    const total = collector.total();
    // 1M input * 5 + 500k output * 25 / 1M = 5 + 12.5 = 17.5
    expect(total.total).toBeCloseTo(17.5, 5);
  });

  it('prices audio tokens at the audio rate (realtime models)', async () => {
    const hooks = new HookBus();
    const catalog = new ModelCatalog();
    catalog.set('openai', 'gpt-realtime', {
      pricing: {
        inputPerMTok: 4,
        outputPerMTok: 24,
        audioInputPerMTok: 32,
        audioOutputPerMTok: 64,
      },
    });
    const collector = new CostCollector({ hooks, catalog });
    await hooks.emit(
      'onCompletion',
      makeCompletionCtx({
        provider: 'openai',
        model: 'gpt-realtime',
        inputTokens: 1_000_000, // text in @ $4
        outputTokens: 1_000_000, // text out @ $24
        audioInputTokens: 1_000_000, // audio in @ $32
        audioOutputTokens: 1_000_000, // audio out @ $64
      }),
    );
    // 4 + 24 + 32 + 64 = 124
    expect(collector.total().total).toBeCloseTo(124, 5);
  });

  it('emits onCostEntry when an entry is recorded', async () => {
    const hooks = new HookBus();
    const fired: unknown[] = [];
    hooks.on('onCostEntry', (c) => {
      fired.push(c);
    });
    const catalog = new ModelCatalog();
    catalog.set('anthropic', 'claude-x', { pricing: { inputPerMTok: 1, outputPerMTok: 1 } });
    new CostCollector({ hooks, catalog });

    await hooks.emit(
      'onCompletion',
      makeCompletionCtx({
        provider: 'anthropic',
        model: 'claude-x',
        inputTokens: 100,
        outputTokens: 50,
      }),
    );

    expect(fired.length).toBe(1);
  });

  it('uses provider-reported cost (openrouter) when available', async () => {
    const hooks = new HookBus();
    const catalog = new ModelCatalog();
    const collector = new CostCollector({ hooks, catalog });

    await hooks.emit(
      'onCompletion',
      makeCompletionCtx({
        provider: 'openrouter',
        model: 'meta/llama',
        inputTokens: 100,
        outputTokens: 50,
        raw: { usage: { cost: 0.0042 } },
      }),
    );

    expect(collector.runningTotal).toBeCloseTo(0.0042, 5);
    expect(collector.entries()[0].cost.source).toBe('provider');
  });

  it('budget warnings fire at thresholds', async () => {
    const hooks = new HookBus();
    const warnings: unknown[] = [];
    hooks.on('onBudgetWarning', (c) => {
      warnings.push(c);
    });
    const catalog = new ModelCatalog();
    catalog.set('p', 'm', { pricing: { inputPerMTok: 1_000_000, outputPerMTok: 0 } });
    const collector = new CostCollector({ hooks, catalog });
    collector.addBudget({
      id: 'b1',
      limit: 10,
      scope: { provider: 'p' },
      thresholds: [0.5, 0.9],
      action: 'warn',
    });

    // Each call: 6 input tokens * (1_000_000 / 1_000_000) = $6
    await hooks.emit(
      'onCompletion',
      makeCompletionCtx({ provider: 'p', model: 'm', inputTokens: 6 }),
    );
    expect(warnings.length).toBe(1); // 50% threshold

    await hooks.emit(
      'onCompletion',
      makeCompletionCtx({ provider: 'p', model: 'm', inputTokens: 4 }),
    );
    expect(warnings.length).toBe(2); // 90% (and ~100%)
  });

  it('destroy unsubscribes', async () => {
    const hooks = new HookBus();
    const catalog = new ModelCatalog();
    catalog.set('p', 'm', { pricing: { inputPerMTok: 1 } });
    const collector = new CostCollector({ hooks, catalog });
    collector.destroy();
    await hooks.emit(
      'onCompletion',
      makeCompletionCtx({ provider: 'p', model: 'm', inputTokens: 1000000 }),
    );
    expect(collector.entryCount).toBe(0);
  });
});

describe('CostCollector — media', () => {
  function emitMedia(
    hooks: HookBus,
    ctx: Partial<import('../../../../src/bus/hook-map').MediaGeneratedContext> & {
      provider: string;
      mediaType: 'image' | 'audio' | 'video';
      count: number;
    },
  ) {
    return hooks.emit('onMediaGenerated', {
      parts: [],
      stored: true,
      source: 'media_output',
      ...ctx,
    });
  }

  it('prices per-unit video by resolution', async () => {
    const hooks = new HookBus();
    const catalog = new ModelCatalog();
    catalog.set('google', 'veo-3', {
      pricing: { perSecond: 0.4, perUnit: { '720p': 0.1, '1080p': 0.12 } },
    });
    const collector = new CostCollector({ hooks, catalog });
    await emitMedia(hooks, {
      provider: 'google',
      model: 'veo-3',
      mediaType: 'video',
      count: 1,
      durationSeconds: 8,
      resolution: '1080p',
    });
    expect(collector.total().total).toBeCloseTo(0.96, 6);
  });

  it('prices token-priced image (gpt-image) from reported usage', async () => {
    const hooks = new HookBus();
    const catalog = new ModelCatalog();
    catalog.set('openai', 'gpt-image-1', { pricing: { inputPerMTok: 8, outputPerMTok: 32 } });
    const collector = new CostCollector({ hooks, catalog });
    await emitMedia(hooks, {
      provider: 'openai',
      model: 'gpt-image-1',
      mediaType: 'image',
      count: 1,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    });
    expect(collector.total().total).toBeCloseTo(0.008 + 0.016, 6);
    expect(collector.entries()[0].tokens.output).toBe(500);
  });

  it('prices per-image when no usage is reported', async () => {
    const hooks = new HookBus();
    const catalog = new ModelCatalog();
    catalog.set('google', 'imagen-4', { pricing: { perImage: 0.04 } });
    const collector = new CostCollector({ hooks, catalog });
    await emitMedia(hooks, { provider: 'google', model: 'imagen-4', mediaType: 'image', count: 3 });
    expect(collector.total().total).toBeCloseTo(0.12, 6);
  });

  it('unknown model media → 0 unknown', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: new ModelCatalog() });
    await emitMedia(hooks, { provider: 'who', model: 'what', mediaType: 'image', count: 1 });
    expect(collector.total().total).toBe(0);
    expect(collector.entries()[0].cost.source).toBe('unknown');
  });

  it('xAI provider-reported media cost (cost_in_usd_ticks) wins over catalog', async () => {
    const hooks = new HookBus();
    const catalog = new ModelCatalog();
    catalog.set('xai', 'grok-imagine-image', { pricing: { perImage: 999 } }); // would be wrong
    const collector = new CostCollector({ hooks, catalog });
    await emitMedia(hooks, {
      provider: 'xai',
      model: 'grok-imagine-image',
      mediaType: 'image',
      count: 1,
      providerEvidence: { usage: { cost_in_usd_ticks: 200_000_000 } },
    });
    expect(collector.total().total).toBeCloseTo(0.02, 6); // ticks / 1e10
    expect(collector.entries()[0].cost.source).toBe('provider');
  });

  it('embeddings emit onCompletion → cost-collector accounts for token usage', async () => {
    // Verify that emitting onCompletion with embedding usage is picked up by cost-collector.
    // This mirrors what embed() now does after a successful embed call with usage.
    const hooks = new HookBus();
    const catalog = new ModelCatalog();
    catalog.set('openai', 'text-embedding-3-small', { pricing: { inputPerMTok: 0.02 } });
    const collector = new CostCollector({ hooks, catalog });

    // Emit an onCompletion the same way embed() does when usage is returned.
    hooks.emitSync('onCompletion', makeCompletionCtx({
      provider: 'openai',
      model: 'text-embedding-3-small',
      inputTokens: 1_000_000,
      outputTokens: 0,
    }));

    expect(collector.entryCount).toBe(1);
    // 1M input tokens * $0.02/MTok = $0.02
    expect(collector.total().total).toBeCloseTo(0.02, 6);
  });
});
