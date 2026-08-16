/** An unpriced model must not look like a free one.
 *
 *  `computeCost` returns a zero total tagged `source: 'unknown'` when the catalog has no
 *  entry for the model — honest per entry, but nothing aggregated it: `runningTotal`
 *  summed it as 0 and `CostSummary` had no field for it. So a report read "$0.00" when it
 *  meant "I could not price this", and a budget built on it silently never triggered.
 *
 *  Found the hard way: a benchmark used `anthropic/claude-haiku-4-5`, which reaches the
 *  API but is not a catalog key, and reported $0.00000 per task across a full live run.
 *  It looked like the cheapest arm in the table rather than a broken measurement.
 */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import type { CompletionContext, WarningContext } from '../../../../src/bus/hook-map';
import { CostCollector } from '../../../../src/plugins/cost-collector/collector';
import { ModelCatalog } from '../../../../src/plugins/model-catalog/catalog';

function ctx(provider: string, model: string, inputTokens = 100): CompletionContext {
  return {
    provider,
    model,
    response: {
      id: 'r',
      model,
      content: [],
      finishReason: 'stop',
      usage: {
        inputTokens,
        outputTokens: 10,
        totalTokens: inputTokens + 10,
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
    request: { estimatedInputTokens: inputTokens, inputChars: 0, messageCount: 1, hasTools: false },
    ctx: {},
  } as CompletionContext;
}

function priced(): ModelCatalog {
  const catalog = new ModelCatalog();
  catalog.set('anthropic', 'claude-priced', { pricing: { inputPerMTok: 1, outputPerMTok: 5 } });
  return catalog;
}

describe('unpriced models are reported, not silently zeroed', () => {
  it('warns once per model, naming it', () => {
    const hooks = new HookBus();
    const warnings: WarningContext[] = [];
    hooks.on('onWarning', (w) => {
      warnings.push({ ...w });
    });
    new CostCollector({ hooks, catalog: priced() });

    hooks.emitSync('onCompletion', ctx('anthropic', 'claude-haiku-4-5'));
    hooks.emitSync('onCompletion', ctx('anthropic', 'claude-haiku-4-5'));
    hooks.emitSync('onCompletion', ctx('anthropic', 'another-missing'));

    // Once per model: an unpriced model is a configuration fact, not a per-call event,
    // and repeating it every request trains the reader to ignore it.
    expect(warnings.length).toBe(2);
    expect(warnings[0].code).toBe('unpriced_model');
    expect(warnings[0].source).toBe('cost');
    expect(warnings[0].message).toContain('claude-haiku-4-5');
    expect(warnings[1].message).toContain('another-missing');
  });

  it('says nothing when every model is priced', () => {
    const hooks = new HookBus();
    const warnings: WarningContext[] = [];
    hooks.on('onWarning', (w) => {
      warnings.push({ ...w });
    });
    new CostCollector({ hooks, catalog: priced() });

    hooks.emitSync('onCompletion', ctx('anthropic', 'claude-priced'));
    expect(warnings.length).toBe(0);
  });

  it('counts unpriced entries in the summary and names the models', () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: priced() });

    hooks.emitSync('onCompletion', ctx('anthropic', 'claude-priced'));
    hooks.emitSync('onCompletion', ctx('anthropic', 'claude-haiku-4-5'));
    hooks.emitSync('onCompletion', ctx('anthropic', 'claude-haiku-4-5'));

    const s = collector.total();
    expect(s.entries).toBe(3);
    expect(s.unpriced).toBe(2);
    expect(s.unpricedModels).toEqual(['anthropic/claude-haiku-4-5']);
    // The priced call still contributes; the total is real, it is just incomplete —
    // which is exactly what `unpriced` exists to say.
    expect(s.total).toBeGreaterThan(0);
  });

  it('reports zero unpriced when everything resolved, so the field is not noise', () => {
    const hooks = new HookBus();
    const collector = new CostCollector({ hooks, catalog: priced() });
    hooks.emitSync('onCompletion', ctx('anthropic', 'claude-priced'));

    const s = collector.total();
    expect(s.unpriced).toBe(0);
    expect(s.unpricedModels).toEqual([]);
  });
});
