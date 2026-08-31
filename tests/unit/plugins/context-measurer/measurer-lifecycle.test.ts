/** ContextMeasurer — construction choices, warm-up, and teardown.
 *
 *  `destroy()` is the one that bites: the measurer subscribes to a shared
 *  HookBus, so a measurer that does not unsubscribe keeps measuring for a
 *  conversation that is over, on a bus that outlives it.
 */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../../src/catalog/catalog';
import { MemoryPersistence } from '../../../../src/plugins/persistence/memory';
import { ContextMeasurer } from '../../../../src/plugins/context-measurer/measurer';
import { HybridTokenCounter } from '../../../../src/plugins/context-measurer/counter/hybrid';
import { HeuristicCounter } from '../../../../src/plugins/context-measurer/counter/heuristic';
import { PersistenceCalibrationStore } from '../../../../src/plugins/context-measurer/calibration/store';
import type { CalibrationEntry, CalibrationStore } from '../../../../src/plugins/context-measurer/types';
import type { ContentClass, TokenCounter } from '../../../../src/agent/types';
import type { ContextMeasureContext } from '../../../../src/bus/hook-map';

function catalog(): ModelCatalog {
  const c = new ModelCatalog();
  c.set('test', 'tiny', {
    pricing: { inputPerMTok: 1, outputPerMTok: 1 },
    contextWindow: 1000,
    tokenizer: { strategy: 'heuristic', charsPerTokenDefault: 4, countApiAvailable: false },
  });
  return c;
}

class SeedableStore implements CalibrationStore {
  entries = new Map<string, CalibrationEntry>();
  async get(
    provider: string,
    model: string,
    contentClass?: ContentClass,
  ): Promise<CalibrationEntry | null> {
    return this.entries.get(`${provider}/${model}:${contentClass ?? ''}`) ?? null;
  }
  async update(
    entry: Omit<CalibrationEntry, 'lastUpdated' | 'confidence'>,
  ): Promise<CalibrationEntry> {
    return { ...entry, confidence: 1, lastUpdated: 0 };
  }
  async list(): Promise<CalibrationEntry[]> {
    return [...this.entries.values()];
  }
  async reset(): Promise<void> {
    this.entries.clear();
  }
  seed(e: CalibrationEntry): void {
    this.entries.set(`${e.provider}/${e.model}:${e.contentClass ?? ''}`, e);
  }
}

describe('ContextMeasurer — calibration store selection', () => {
  it('an explicit store wins over persistence', () => {
    const explicit = new SeedableStore();
    const m = new ContextMeasurer({
      hooks: new HookBus(),
      catalog: catalog(),
      calibrationStore: explicit,
      persistence: new MemoryPersistence(),
    });
    expect(m.calibrationStore).toBe(explicit);
    m.destroy();
  });

  it('persistence alone builds a PersistenceCalibrationStore', () => {
    const m = new ContextMeasurer({
      hooks: new HookBus(),
      catalog: catalog(),
      persistence: new MemoryPersistence(),
    });
    expect(m.calibrationStore).toBeInstanceOf(PersistenceCalibrationStore);
    m.destroy();
  });

  it('neither means no calibration at all — nothing is even asked to learn', async () => {
    const hooks = new HookBus();
    const learned: unknown[] = [];
    const counter: TokenCounter = {
      estimate: (t: string) => Math.ceil(t.length / 4),
      estimateMessage: () => 1,
      measure: async () => 1,
      measureMessage: async () => 1,
      learn: (input) => {
        learned.push(input);
      },
    };
    const m = new ContextMeasurer({ hooks, catalog: catalog(), counter });
    expect(m.calibrationStore).toBeNull();

    await hooks.emit('onCompletion', {
      provider: 'test',
      model: 'tiny',
      response: { usage: { inputTokens: 100 } },
      request: { inputChars: 400 },
    } as never);

    // With nowhere to record a ratio, learning is skipped at the source rather
    // than pushed down to be dropped later.
    expect(learned).toEqual([]);
    m.destroy();
  });

  it('with a store, a completion IS handed to the counter to learn from', async () => {
    const hooks = new HookBus();
    const learned: Array<Record<string, unknown>> = [];
    const counter: TokenCounter = {
      estimate: (t: string) => Math.ceil(t.length / 4),
      estimateMessage: () => 1,
      measure: async () => 1,
      measureMessage: async () => 1,
      learn: (input) => {
        learned.push(input as unknown as Record<string, unknown>);
      },
    };
    const m = new ContextMeasurer({
      hooks,
      catalog: catalog(),
      counter,
      calibrationStore: new SeedableStore(),
    });

    await hooks.emit('onCompletion', {
      provider: 'test',
      model: 'tiny',
      response: { usage: { inputTokens: 100 } },
      request: { inputChars: 400 },
    } as never);

    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({
      provider: 'test',
      model: 'tiny',
      bytesSent: 400,
      actualTokens: 100,
    });
    m.destroy();
  });

  it('thresholds merge over the defaults rather than replacing them', () => {
    const m = new ContextMeasurer({
      hooks: new HookBus(),
      catalog: catalog(),
      thresholds: { warn: 0.6 },
    });
    expect(m.thresholds).toEqual({ warn: 0.6, exact: 0.9 });
    m.destroy();
  });

  it('builds a HybridTokenCounter by default, and accepts an explicit one', () => {
    const auto = new ContextMeasurer({ hooks: new HookBus(), catalog: catalog() });
    expect(auto.counter).toBeInstanceOf(HybridTokenCounter);
    auto.destroy();

    const own = new HeuristicCounter(catalog());
    const explicit = new ContextMeasurer({ hooks: new HookBus(), catalog: catalog(), counter: own });
    expect(explicit.counter).toBe(own);
    explicit.destroy();
  });
});

describe('ContextMeasurer — warmCache', () => {
  it('warms the hybrid counter it built, so the first estimate already uses learned rates', async () => {
    const store = new SeedableStore();
    store.seed({
      provider: 'test',
      model: 'tiny',
      contentClass: undefined,
      charsPerToken: 8,
      samples: 20,
      confidence: 1,
      lastUpdated: 0,
    });
    const m = new ContextMeasurer({
      hooks: new HookBus(),
      catalog: catalog(),
      calibrationStore: store,
    });

    const ctx = { provider: 'test', model: 'tiny' };
    expect(m.counter.estimate('x'.repeat(40), ctx)).toBe(10); // catalog default: 4
    await m.warmCache();
    expect(m.counter.estimate('x'.repeat(40), ctx)).toBe(5); // learned: 8
    m.destroy();
  });

  it('a counter that has no warmCache at all is left alone rather than called', async () => {
    // TokenCounter does not require warmCache; calling it unconditionally is a
    // TypeError for every consumer who supplied their own counter.
    const own: TokenCounter = {
      estimate: () => 1,
      estimateMessage: () => 1,
      measure: async () => 1,
      measureMessage: async () => 1,
      learn: () => {},
    };
    const m = new ContextMeasurer({ hooks: new HookBus(), catalog: catalog(), counter: own });

    await m.warmCache();

    expect(m.counter).toBe(own);
    m.destroy();
  });
});

describe('ContextMeasurer — destroy', () => {
  it('an onMessageResolve reaches the measurer, and its abort decision comes back on the context', async () => {
    const hooks = new HookBus();
    const m = new ContextMeasurer({ hooks, catalog: catalog() });
    const measured: ContextMeasureContext[] = [];
    hooks.on('onContextMeasure', (ctx) => {
      measured.push(ctx);
      ctx.abort = true;
      ctx.abortReason = 'window exceeded';
    });

    const resolveCtx: { abort?: boolean; abortReason?: string } = {
      provider: 'test',
      model: 'tiny',
      messages: [{ role: 'user', content: 'hello' }],
    } as never;
    await hooks.emit('onMessageResolve', resolveCtx as never);

    expect(measured).toHaveLength(1);
    expect(resolveCtx.abort).toBe(true);
    // Without the reason the caller can report THAT the request was stopped but
    // never WHY, which is the only part a user can act on.
    expect(resolveCtx.abortReason).toBe('window exceeded');
    m.destroy();
  });

  it('unsubscribes from every hook it wired', async () => {
    const hooks = new HookBus();
    const m = new ContextMeasurer({ hooks, catalog: catalog() });
    expect(hooks.handlerCount).toBe(2);

    const seen: ContextMeasureContext[] = [];
    hooks.on('onContextMeasure', (ctx) => {
      seen.push(ctx);
    });

    m.destroy();

    await hooks.emit('onMessageResolve', {
      provider: 'test',
      model: 'tiny',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(seen).toHaveLength(0);
    // Only the listener this test added remains.
    expect(hooks.handlerCount).toBe(1);
  });

  it('destroy is idempotent', () => {
    const hooks = new HookBus();
    const m = new ContextMeasurer({ hooks, catalog: catalog() });
    m.destroy();
    m.destroy();
    expect(hooks.handlerCount).toBe(0);
  });

  it('a measurement in flight before destroy still reports its abort decision', async () => {
    const hooks = new HookBus();
    const m = new ContextMeasurer({ hooks, catalog: catalog() });
    hooks.on('onContextMeasure', (ctx) => {
      ctx.abort = true;
      ctx.abortReason = 'over budget';
    });

    const result = await m.measureAndEmit('test', 'tiny', [{ role: 'user', content: 'hi' }]);

    expect(result.abort).toBe(true);
    expect(result.abortReason).toBe('over budget');
    m.destroy();
  });
});
