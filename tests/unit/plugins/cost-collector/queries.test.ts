/** CostCollector — the ledger's read side, and media pricing.
 *
 *  A cost report is only useful if it is honest about what it could not price.
 *  Two failures this file exists to prevent:
 *
 *    - media reported at $0.00 because the unit-priced path was never taken,
 *      which reads exactly like a free call;
 *    - a grouped report (by model, by tag) that quietly loses entries, so the
 *      parts stop summing to the whole.
 */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import { CostCollector } from '../../../../src/plugins/cost-collector/collector';
import { ModelCatalog } from '../../../../src/catalog/catalog';
import type {
  BudgetExceededContext,
  BudgetWarningContext,
  CompletionContext,
  CostEntry,
} from '../../../../src/bus/hook-map';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function completion(opts: {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  requestId?: string;
  conversationId?: string;
}): CompletionContext {
  const input = opts.inputTokens ?? 0;
  const output = opts.outputTokens ?? 0;
  return {
    provider: opts.provider,
    model: opts.model,
    response: {
      id: 'r',
      model: opts.model,
      content: [],
      finishReason: 'stop',
      usage: {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      text: '',
      toolCalls: [],
      thinking: null,
      media: [],
      latencyMs: 1,
      raw: null,
    },
    request: {
      estimatedInputTokens: input,
      inputChars: 0,
      messageCount: 1,
      hasTools: false,
    },
    ctx: { requestId: opts.requestId, conversationId: opts.conversationId },
  } as CompletionContext;
}

function pricedCatalog(): ModelCatalog {
  const c = new ModelCatalog();
  // $1 per MTok in, $10 per MTok out.
  c.set('openai', 'gpt-a', { pricing: { inputPerMTok: 1, outputPerMTok: 10 } });
  c.set('openai', 'gpt-b', { pricing: { inputPerMTok: 2, outputPerMTok: 20 } });
  c.set('anthropic', 'claude-a', { pricing: { inputPerMTok: 4, outputPerMTok: 40 } });
  return c;
}

/** Three entries: two openai models and one anthropic, with distinct totals. */
async function seeded(): Promise<{ hooks: HookBus; collector: CostCollector }> {
  const hooks = new HookBus();
  const collector = new CostCollector({
    hooks,
    catalog: pricedCatalog(),
    sessionId: 'sess-1',
    defaultTags: { env: 'test' },
  });
  await hooks.emit(
    'onCompletion',
    completion({ provider: 'openai', model: 'gpt-a', inputTokens: 1_000_000, requestId: 'run-1' }),
  );
  await hooks.emit(
    'onCompletion',
    completion({ provider: 'openai', model: 'gpt-b', inputTokens: 1_000_000, requestId: 'run-2' }),
  );
  await hooks.emit(
    'onCompletion',
    completion({
      provider: 'anthropic',
      model: 'claude-a',
      inputTokens: 1_000_000,
      requestId: 'run-2',
    }),
  );
  return { hooks, collector };
}

// ─── Grouped reports ─────────────────────────────────────────────────────────

describe('CostCollector — grouped reports', () => {
  it('byProvider sums per provider and the parts add up to the whole', async () => {
    const { collector } = await seeded();
    const byProvider = collector.byProvider();

    expect(Object.keys(byProvider).sort()).toEqual(['anthropic', 'openai']);
    expect(byProvider.openai.total).toBeCloseTo(3, 6); // 1 + 2
    expect(byProvider.openai.entries).toBe(2);
    expect(byProvider.anthropic.total).toBeCloseTo(4, 6);
    expect(byProvider.openai.total + byProvider.anthropic.total).toBeCloseTo(
      collector.total().total,
      6,
    );
    collector.destroy();
  });

  it('byModel keys on provider/model so two providers cannot collide', async () => {
    const { collector } = await seeded();
    const byModel = collector.byModel();

    expect(Object.keys(byModel).sort()).toEqual([
      'anthropic/claude-a',
      'openai/gpt-a',
      'openai/gpt-b',
    ]);
    expect(byModel['openai/gpt-a'].total).toBeCloseTo(1, 6);
    expect(byModel['anthropic/claude-a'].tokens.input).toBe(1_000_000);
    collector.destroy();
  });

  it('byTag groups on a tag value, with a named bucket for entries that lack it', async () => {
    const { hooks, collector } = await seeded();
    collector.setTag('team', 'platform');
    await hooks.emit(
      'onCompletion',
      completion({ provider: 'openai', model: 'gpt-a', inputTokens: 1_000_000 }),
    );

    const byTeam = collector.byTag('team');

    // The three seeded entries predate setTag, so they land in '(none)'.
    expect(Object.keys(byTeam).sort()).toEqual(['(none)', 'platform']);
    expect(byTeam['(none)'].entries).toBe(3);
    expect(byTeam.platform.entries).toBe(1);
    expect(byTeam.platform.total).toBeCloseTo(1, 6);
    collector.destroy();
  });

  it('byTag over a tag every entry shares yields one bucket', async () => {
    const { collector } = await seeded();
    const byEnv = collector.byTag('env');
    expect(Object.keys(byEnv)).toEqual(['test']);
    expect(byEnv.test.entries).toBe(3);
    collector.destroy();
  });

  it('every grouped report honours the same filter as total()', async () => {
    const { collector } = await seeded();
    const filter = { runId: 'run-2' };

    expect(collector.entries(filter)).toHaveLength(2);
    expect(Object.keys(collector.byProvider(filter)).sort()).toEqual(['anthropic', 'openai']);
    expect(collector.byProvider(filter).openai.entries).toBe(1);
    expect(Object.keys(collector.byModel(filter)).sort()).toEqual([
      'anthropic/claude-a',
      'openai/gpt-b',
    ]);
    expect(collector.byTag('env', filter).test.entries).toBe(2);
    expect(collector.total(filter).total).toBeCloseTo(6, 6);
    collector.destroy();
  });

  it('grouped reports over an empty ledger are empty objects, not throws', () => {
    const collector = new CostCollector({ hooks: new HookBus(), catalog: pricedCatalog() });
    expect(collector.byProvider()).toEqual({});
    expect(collector.byModel()).toEqual({});
    expect(collector.byTag('anything')).toEqual({});
    expect(collector.entryCount).toBe(0);
    expect(collector.runningTotal).toBe(0);
    collector.destroy();
  });
});

// ─── Accessors ───────────────────────────────────────────────────────────────

describe('CostCollector — accessors', () => {
  it('runningTotal tracks the ledger as entries land', async () => {
    const { collector } = await seeded();
    expect(collector.runningTotal).toBeCloseTo(7, 6);
    expect(collector.runningTotal).toBeCloseTo(collector.total().total, 6);
    expect(collector.entryCount).toBe(3);
    collector.destroy();
  });

  it('modelCatalog exposes the catalog it prices against', () => {
    const catalog = pricedCatalog();
    const collector = new CostCollector({ hooks: new HookBus(), catalog });
    expect(collector.modelCatalog).toBe(catalog);
    collector.destroy();
  });

  it('setTag applies to entries recorded after it, not retroactively', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: pricedCatalog() });
    await hooks.emit('onCompletion', completion({ provider: 'openai', model: 'gpt-a' }));
    collector.setTag('phase', 'two');
    await hooks.emit('onCompletion', completion({ provider: 'openai', model: 'gpt-a' }));

    const tags = collector.entries().map((e) => e.tags.phase);
    expect(tags).toEqual([undefined, 'two']);
    collector.destroy();
  });

  it('entries() without a filter hands back the ledger itself, entries() with one a copy', async () => {
    const { collector } = await seeded();
    expect(collector.entries()).toHaveLength(3);
    expect(collector.entries({ provider: 'openai' })).toHaveLength(2);
    collector.destroy();
  });
});

// ─── Export / import ─────────────────────────────────────────────────────────

describe('CostCollector — export and import', () => {
  it('export() is a snapshot: mutating it does not touch the ledger', async () => {
    const { collector } = await seeded();
    const exported = collector.export();

    expect(exported).toHaveLength(3);
    exported.length = 0;
    expect(collector.entryCount).toBe(3);
    collector.destroy();
  });

  it('import() appends entries AND folds their cost into the running total', async () => {
    const { collector } = await seeded();
    const target = new CostCollector({ hooks: new HookBus(), catalog: pricedCatalog() });

    target.import(collector.export());

    expect(target.entryCount).toBe(3);
    expect(target.runningTotal).toBeCloseTo(7, 6);
    expect(target.total().total).toBeCloseTo(7, 6);
    expect(target.byModel()['openai/gpt-b'].total).toBeCloseTo(2, 6);
    collector.destroy();
    target.destroy();
  });

  it('import() adds to what is already there rather than replacing it', async () => {
    const { collector } = await seeded();
    collector.import(collector.export());
    expect(collector.entryCount).toBe(6);
    expect(collector.runningTotal).toBeCloseTo(14, 6);
    collector.destroy();
  });

  it('importing nothing changes nothing', async () => {
    const { collector } = await seeded();
    collector.import([]);
    expect(collector.entryCount).toBe(3);
    expect(collector.runningTotal).toBeCloseTo(7, 6);
    collector.destroy();
  });
});

// ─── Budgets ─────────────────────────────────────────────────────────────────

describe('CostCollector — budgets', () => {
  it('removeBudget stops it firing, including thresholds it had not reached yet', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: pricedCatalog() });
    const warnings: BudgetWarningContext[] = [];
    hooks.on('onBudgetWarning', (c) => {
      warnings.push(c);
    });

    collector.addBudget({ id: 'b1', scope: {}, limit: 10, thresholds: [0.5, 0.9], action: 'warn' });
    await hooks.emit(
      'onCompletion',
      completion({ provider: 'openai', model: 'gpt-a', inputTokens: 6_000_000 }),
    );
    expect(warnings.map((w) => w.threshold)).toEqual([0.5]);

    collector.removeBudget('b1');
    // Spend past the 90% mark, which had NOT yet triggered. A budget that was
    // removed must not fire, not even for a threshold it had never reached.
    await hooks.emit(
      'onCompletion',
      completion({ provider: 'openai', model: 'gpt-a', inputTokens: 4_000_000 }),
    );
    expect(warnings.map((w) => w.threshold)).toEqual([0.5]);

    // Re-adding starts from a clean slate: both marks fire again.
    collector.addBudget({ id: 'b1', scope: {}, limit: 10, thresholds: [0.5, 0.9], action: 'warn' });
    await hooks.emit('onCompletion', completion({ provider: 'openai', model: 'gpt-a' }));
    expect(warnings.map((w) => w.threshold)).toEqual([0.5, 0.5, 0.9]);
    collector.destroy();
  });

  it('a removed budget is gone from the list, not merely muted', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: pricedCatalog() });
    const warnings: BudgetWarningContext[] = [];
    hooks.on('onBudgetWarning', (c) => {
      warnings.push(c);
    });

    collector.addBudget({ id: 'b1', scope: {}, limit: 10, thresholds: [0.5], action: 'warn' });
    await hooks.emit(
      'onCompletion',
      completion({ provider: 'openai', model: 'gpt-a', inputTokens: 2_000_000 }),
    );
    expect(warnings).toHaveLength(0); // $2 of a $10 budget

    collector.removeBudget('b1');
    // Same id, a far larger limit. If the OLD budget were still in the list it
    // would breach its 50% mark ($5) on the spend below and warn.
    collector.addBudget({ id: 'b1', scope: {}, limit: 100, thresholds: [0.5], action: 'warn' });
    await hooks.emit(
      'onCompletion',
      completion({ provider: 'openai', model: 'gpt-a', inputTokens: 6_000_000 }),
    );

    expect(warnings).toHaveLength(0); // $8 is nowhere near 50% of $100
    collector.destroy();
  });

  it('removing a budget that was never added is harmless', () => {
    const collector = new CostCollector({ hooks: new HookBus(), catalog: pricedCatalog() });
    expect(() => collector.removeBudget('nope')).not.toThrow();
    collector.destroy();
  });

  it('a watched agent is stopped when a stop-action budget is breached', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: pricedCatalog() });
    let stopped = 0;
    const agent = {
      stop() {
        stopped++;
      },
    };
    collector.watchAgent(agent);
    collector.addBudget({ id: 'hard', scope: {}, limit: 2, thresholds: [], action: 'stop' });

    const breaches: BudgetExceededContext[] = [];
    hooks.on('onBudgetExceeded', (c) => {
      breaches.push(c);
    });

    await hooks.emit(
      'onCompletion',
      completion({ provider: 'openai', model: 'gpt-a', inputTokens: 3_000_000 }),
    );

    expect(breaches).toHaveLength(1);
    expect(breaches[0].overage).toBeCloseTo(1, 6);
    expect(stopped).toBe(1);

    // The breach fires once, so the agent is not stopped again and again.
    await hooks.emit('onCompletion', completion({ provider: 'openai', model: 'gpt-a' }));
    expect(stopped).toBe(1);
    collector.destroy();
  });

  it('a budget without the stop action leaves watched agents running', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: pricedCatalog() });
    let stopped = 0;
    collector.watchAgent({
      stop() {
        stopped++;
      },
    });
    collector.addBudget({ id: 'soft', scope: {}, limit: 1, thresholds: [], action: 'warn' });

    await hooks.emit(
      'onCompletion',
      completion({ provider: 'openai', model: 'gpt-a', inputTokens: 3_000_000 }),
    );
    expect(stopped).toBe(0);
    collector.destroy();
  });

  it('a scoped budget ignores spend outside its scope', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: pricedCatalog() });
    const breaches: BudgetExceededContext[] = [];
    hooks.on('onBudgetExceeded', (c) => {
      breaches.push(c);
    });
    collector.addBudget({ id: 'anthropic-only', scope: { provider: 'anthropic' }, limit: 3, thresholds: [], action: 'warn' });

    await hooks.emit(
      'onCompletion',
      completion({ provider: 'openai', model: 'gpt-a', inputTokens: 10_000_000 }),
    );
    expect(breaches).toHaveLength(0);

    await hooks.emit(
      'onCompletion',
      completion({ provider: 'anthropic', model: 'claude-a', inputTokens: 1_000_000 }),
    );
    expect(breaches).toHaveLength(1);
    expect(breaches[0].current).toBeCloseTo(4, 6);
    collector.destroy();
  });

  it('an out-of-scope entry does not re-evaluate a scoped budget', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: pricedCatalog() });
    const breaches: BudgetExceededContext[] = [];
    hooks.on('onBudgetExceeded', (c) => {
      breaches.push(c);
    });

    // $4 of anthropic spend BEFORE the budget exists.
    await hooks.emit(
      'onCompletion',
      completion({ provider: 'anthropic', model: 'claude-a', inputTokens: 1_000_000 }),
    );
    collector.addBudget({
      id: 'anthropic-only',
      scope: { provider: 'anthropic' },
      limit: 3,
      thresholds: [],
      action: 'warn',
    });

    // An openai call now. It is outside the budget's scope, so the budget is
    // not re-evaluated — a budget fires on ITS OWN spend moving, never on
    // someone else's traffic happening to arrive.
    await hooks.emit(
      'onCompletion',
      completion({ provider: 'openai', model: 'gpt-a', inputTokens: 1_000_000 }),
    );
    expect(breaches).toHaveLength(0);

    // The next anthropic call does move it, and then it fires.
    await hooks.emit('onCompletion', completion({ provider: 'anthropic', model: 'claude-a' }));
    expect(breaches).toHaveLength(1);
    collector.destroy();
  });
});

// ─── Media pricing ───────────────────────────────────────────────────────────

describe('CostCollector — generated media must not report as free', () => {
  function mediaCatalog(): ModelCatalog {
    const c = new ModelCatalog();
    c.set('openai', 'dall-e', { pricing: { perImage: 0.04 } });
    c.set('openai', 'dall-e-hd', { pricing: { perImage: 0.04, perUnit: { '1024x1792': 0.12 } } });
    c.set('google', 'veo', { pricing: { perSecond: 0.5 } });
    c.set('openai', 'tts-1', { pricing: { perMChars: 15 } });
    c.set('openai', 'gpt-image', { pricing: { inputPerMTok: 5, outputPerMTok: 40 } });
    return c;
  }

  function emitMedia(hooks: HookBus, extra: Record<string, unknown>): Promise<void> {
    return hooks.emit('onMediaGenerated', {
      parts: [],
      stored: true,
      source: 'inline',
      ...extra,
    } as never);
  }

  it('images are priced per image, not at zero', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: mediaCatalog() });

    await emitMedia(hooks, { provider: 'openai', model: 'dall-e', mediaType: 'image', count: 3 });

    const entry = collector.entries()[0];
    expect(entry.cost.total).toBeCloseTo(0.12, 6);
    expect(entry.cost.source).toBe('calculated');
    expect(entry.tags.type).toBe('media');
    expect(entry.tags.mediaType).toBe('image');
    expect(collector.runningTotal).toBeCloseTo(0.12, 6);
    collector.destroy();
  });

  it('a per-resolution rate overrides the flat per-image rate', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: mediaCatalog() });

    await emitMedia(hooks, {
      provider: 'openai',
      model: 'dall-e-hd',
      mediaType: 'image',
      count: 2,
      resolution: '1024x1792',
    });

    expect(collector.entries()[0].cost.total).toBeCloseTo(0.24, 6);
    collector.destroy();
  });

  it('video is priced by generated seconds', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: mediaCatalog() });

    await emitMedia(hooks, {
      provider: 'google',
      model: 'veo',
      mediaType: 'video',
      count: 1,
      durationSeconds: 8,
    });

    expect(collector.entries()[0].cost.total).toBeCloseTo(4, 6);
    collector.destroy();
  });

  it('TTS is priced by input characters', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: mediaCatalog() });

    await emitMedia(hooks, {
      provider: 'openai',
      model: 'tts-1',
      mediaType: 'audio',
      count: 1,
      textInput: 'x'.repeat(1_000_000),
    });

    expect(collector.entries()[0].cost.total).toBeCloseTo(15, 6);
    collector.destroy();
  });

  it('token-priced media uses the reported usage, and records those tokens', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: mediaCatalog() });

    await emitMedia(hooks, {
      provider: 'openai',
      model: 'gpt-image',
      mediaType: 'image',
      count: 1,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
    });

    const entry = collector.entries()[0];
    expect(entry.cost.total).toBeCloseTo(45, 6); // 5 in + 40 out
    expect(entry.tokens.input).toBe(1_000_000);
    expect(entry.tokens.audioInput).toBe(0);
    collector.destroy();
  });

  it('an unpriced media model is flagged unpriced and warned about once', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: mediaCatalog() });
    const warnings: string[] = [];
    hooks.on('onWarning', (c) => {
      if (c.code === 'unpriced_model') warnings.push(c.message);
    });

    await emitMedia(hooks, {
      provider: 'openai',
      model: 'mystery-model',
      mediaType: 'image',
      count: 1,
    });
    await emitMedia(hooks, {
      provider: 'openai',
      model: 'mystery-model',
      mediaType: 'image',
      count: 1,
    });

    // $0.00 is reported, but never as if it were free.
    expect(collector.total().total).toBe(0);
    expect(collector.total().unpriced).toBe(2);
    expect(collector.total().unpricedModels).toEqual(['openai/mystery-model']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not the same as free');
    collector.destroy();
  });

  it('media with no type or no count is not a cost event at all', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: mediaCatalog() });

    await emitMedia(hooks, { provider: 'openai', model: 'dall-e', count: 2 });
    await emitMedia(hooks, { provider: 'openai', model: 'dall-e', mediaType: 'image' });
    await emitMedia(hooks, { provider: 'openai', model: 'dall-e', mediaType: 'image', count: 0 });

    expect(collector.entryCount).toBe(0);
    collector.destroy();
  });

  it('an unnamed media model is labelled provider/mediaType so the ledger stays readable', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: mediaCatalog() });

    await emitMedia(hooks, { provider: 'openai', mediaType: 'image', count: 1 });

    expect(collector.entries()[0].model).toBe('openai/image');
    collector.destroy();
  });

  it('a provider-reported cost beats every catalog rate', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: mediaCatalog() });

    await emitMedia(hooks, {
      provider: 'openrouter',
      model: 'dall-e',
      mediaType: 'image',
      count: 100,
      providerEvidence: { usage: { cost: 0.007 } },
    });

    const entry = collector.entries()[0];
    expect(entry.cost.total).toBeCloseTo(0.007, 6);
    expect(entry.cost.source).toBe('provider');
    collector.destroy();
  });

  it('media entries reach the onCostEntry hook with the running total', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: mediaCatalog() });
    const seen: Array<{ entry: CostEntry; runningTotal: number }> = [];
    hooks.on('onCostEntry', (c) => {
      seen.push(c);
    });

    await emitMedia(hooks, { provider: 'openai', model: 'dall-e', mediaType: 'image', count: 1 });
    await emitMedia(hooks, { provider: 'openai', model: 'dall-e', mediaType: 'image', count: 1 });

    expect(seen).toHaveLength(2);
    expect(seen[1].runningTotal).toBeCloseTo(0.08, 6);
    collector.destroy();
  });

  it('media spend counts against a budget like any other spend', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: mediaCatalog() });
    const breaches: BudgetExceededContext[] = [];
    hooks.on('onBudgetExceeded', (c) => {
      breaches.push(c);
    });
    collector.addBudget({ id: 'img', scope: { type: 'media' }, limit: 0.05, thresholds: [], action: 'warn' });

    await emitMedia(hooks, { provider: 'openai', model: 'dall-e', mediaType: 'image', count: 2 });

    expect(breaches).toHaveLength(1);
    collector.destroy();
  });
});

// ─── Teardown ────────────────────────────────────────────────────────────────

describe('CostCollector — destroy', () => {
  it('unsubscribes from both completion and media hooks', async () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: pricedCatalog() });
    expect(hooks.handlerCount).toBe(2);

    collector.destroy();
    expect(hooks.handlerCount).toBe(0);

    await hooks.emit('onCompletion', completion({ provider: 'openai', model: 'gpt-a' }));
    expect(collector.entryCount).toBe(0);
  });

  it('destroy is idempotent', () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: pricedCatalog() });
    collector.destroy();
    collector.destroy();
    expect(hooks.handlerCount).toBe(0);
  });
});
