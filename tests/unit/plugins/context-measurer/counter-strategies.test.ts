/** HybridTokenCounter routing + HeuristicCounter calibration.
 *
 *  The hybrid counter is the one place where "exact" silently becomes
 *  "estimated". That downgrade is allowed for exactly ONE reason — the optional
 *  `tiktoken` peer is not installed — and must be loud once and never again.
 *  Any other failure has to surface, because answering with an estimate when an
 *  exact count was asked for and was possible is how a wrong number gets
 *  believed.
 */

import { describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../../src/catalog/catalog';
import { HybridTokenCounter } from '../../../../src/plugins/context-measurer/counter/hybrid';
import { HeuristicCounter } from '../../../../src/plugins/context-measurer/counter/heuristic';
import { TiktokenCounter, tiktokenUnavailableError } from '../../../../src/plugins/context-measurer/counter/tiktoken';
import { CountApiCounter } from '../../../../src/plugins/context-measurer/counter/count-api';
import type { CalibrationEntry, CalibrationStore } from '../../../../src/plugins/context-measurer/types';
import type { ContentClass } from '../../../../src/agent/types';
import type { EngineFetch } from '../../../../src/network/types';
import type { TokenCounter } from '../../../../src/agent/types';
import type { Message } from '../../../../src/llm/types/messages';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function catalogWith(strategy: 'tiktoken' | 'count_api' | 'heuristic', charsPerToken = 4): ModelCatalog {
  const c = new ModelCatalog();
  c.set('acme', 'm1', {
    pricing: {},
    contextWindow: 1000,
    tokenizer: { strategy, charsPerTokenDefault: charsPerToken, countApiAvailable: true },
  } as never);
  return c;
}

class RecordingStore implements CalibrationStore {
  updates: Array<Omit<CalibrationEntry, 'lastUpdated' | 'confidence'>> = [];
  entries = new Map<string, CalibrationEntry>();
  rejectUpdates = false;

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
    this.updates.push(entry);
    if (this.rejectUpdates) throw new Error('store is down');
    const stored: CalibrationEntry = { ...entry, confidence: 1, lastUpdated: 0 };
    this.entries.set(`${entry.provider}/${entry.model}:${entry.contentClass ?? ''}`, stored);
    return stored;
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

const noopFetch: EngineFetch = (async () => ({ status: 200, headers: {}, body: {} })) as EngineFetch;

// ─── Routing ─────────────────────────────────────────────────────────────────

describe('HybridTokenCounter — strategy routing', () => {
  it('no context, no model or no catalog all route to the heuristic', () => {
    const hybrid = new HybridTokenCounter({ catalog: catalogWith('tiktoken') });
    expect(hybrid.strategyNameFor()).toBe('heuristic');
    expect(hybrid.strategyNameFor({ provider: 'acme' })).toBe('heuristic');
    expect(hybrid.strategyNameFor({ model: 'm1' })).toBe('heuristic');
    expect(new HybridTokenCounter({}).strategyNameFor({ provider: 'acme', model: 'm1' })).toBe(
      'heuristic',
    );
  });

  it('reports the catalogued strategy for a known model', () => {
    expect(
      new HybridTokenCounter({ catalog: catalogWith('tiktoken') }).strategyNameFor({
        provider: 'acme',
        model: 'm1',
      }),
    ).toBe('tiktoken');
    expect(
      new HybridTokenCounter({ catalog: catalogWith('count_api') }).strategyNameFor({
        provider: 'acme',
        model: 'm1',
      }),
    ).toBe('count_api');
  });

  it('an uncatalogued model, and an unrecognised strategy name, both read as heuristic', () => {
    const c = new ModelCatalog();
    c.set('acme', 'weird', {
      pricing: {},
      tokenizer: { strategy: 'sentencepiece', charsPerTokenDefault: 4, countApiAvailable: false },
    } as never);
    const hybrid = new HybridTokenCounter({ catalog: c });
    expect(hybrid.strategyNameFor({ provider: 'acme', model: 'weird' })).toBe('heuristic');
    expect(hybrid.strategyNameFor({ provider: 'acme', model: 'never-heard-of-it' })).toBe(
      'heuristic',
    );
    // ...and that name is what actually RUNS, not merely what is reported.
    // (Reading the number alone cannot tell heuristic from count-api-with-no-
    // adapters, because the latter falls through to a heuristic of its own.)
    const routed = (
      hybrid as unknown as { strategyFor(ctx: unknown): TokenCounter; heuristic: TokenCounter }
    );
    expect(routed.strategyFor({ provider: 'acme', model: 'weird' })).toBe(routed.heuristic);
    expect(routed.strategyFor({ provider: 'acme', model: 'never-heard-of-it' })).toBe(
      routed.heuristic,
    );
    expect(hybrid.estimate('x'.repeat(40), { provider: 'acme', model: 'weird' })).toBe(10);
  });

  it('the tiktoken counter is built lazily, on first use, and then reused', async () => {
    const hybrid = new HybridTokenCounter({ catalog: catalogWith('tiktoken') });
    const peek = hybrid as unknown as { _tiktoken?: TiktokenCounter };
    expect(peek._tiktoken).toBeUndefined();

    await hybrid.measure('hello world', { provider: 'acme', model: 'm1' });
    const first = peek._tiktoken;
    expect(first).toBeInstanceOf(TiktokenCounter);

    await hybrid.measure('again', { provider: 'acme', model: 'm1' });
    expect(peek._tiktoken).toBe(first);
  });

  it('a count_api model routes to the CountApiCounter', () => {
    const hybrid = new HybridTokenCounter({ catalog: catalogWith('count_api') });
    const routed = (
      hybrid as unknown as { strategyFor(ctx: unknown): TokenCounter }
    ).strategyFor({ provider: 'acme', model: 'm1' });
    expect(routed).toBeInstanceOf(CountApiCounter);
  });

  it('estimate / estimateMessage route through the same choice', () => {
    const hybrid = new HybridTokenCounter({ catalog: catalogWith('heuristic', 5) });
    const ctx = { provider: 'acme', model: 'm1' };
    expect(hybrid.estimate('x'.repeat(50), ctx)).toBe(10);
    expect(hybrid.estimateMessage({ role: 'user', content: 'x'.repeat(50) }, ctx)).toBe(10);
  });
});

// ─── The count-API keys need a fetch ─────────────────────────────────────────

describe('HybridTokenCounter — count API wiring', () => {
  it('warns out loud when count keys arrive WITHOUT an engine fetch', () => {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };
    try {
      new HybridTokenCounter({
        catalog: catalogWith('count_api'),
        countApiKeys: { anthropic: 'k' },
      });
    } finally {
      console.warn = original;
    }
    // A silent downgrade from exact to estimated is invisible in the only place
    // it shows: the number.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('countApiKeys were given without `fetch`');
    expect(warnings[0]).toContain('falls back to the heuristic');
  });

  it('says nothing when there are no count keys at all', () => {
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };
    try {
      new HybridTokenCounter({ catalog: catalogWith('count_api') });
      new HybridTokenCounter({ catalog: catalogWith('count_api'), countApiKeys: {} });
    } finally {
      console.warn = original;
    }
    expect(warnings).toEqual([]);
  });

  it('builds each provider adapter only when both its key and the fetch are present', () => {
    const original = console.warn;
    console.warn = () => {};
    let counter: HybridTokenCounter;
    try {
      counter = new HybridTokenCounter({
        catalog: catalogWith('count_api'),
        countApiKeys: { anthropic: 'a', google: 'g', xai: 'x' },
        fetch: noopFetch,
      });
    } finally {
      console.warn = original;
    }
    const api = (
      counter as unknown as { countApi: { providers: Record<string, unknown> } }
    ).countApi;
    expect(Object.keys(api.providers).sort()).toEqual(['anthropic', 'google', 'xai']);

    const noKeys = new HybridTokenCounter({ catalog: catalogWith('count_api'), fetch: noopFetch });
    const emptyApi = (
      noKeys as unknown as { countApi: { providers: Record<string, unknown> } }
    ).countApi;
    expect(Object.keys(emptyApi.providers)).toEqual([]);
  });

  it('keys WITHOUT a fetch build no adapters at all', () => {
    // Building one anyway would give it an undefined fetch, turning the warned
    // fallback into a TypeError on the first exact count.
    const original = console.warn;
    console.warn = () => {};
    let counter: HybridTokenCounter;
    try {
      counter = new HybridTokenCounter({
        catalog: catalogWith('count_api'),
        countApiKeys: { anthropic: 'a', google: 'g', xai: 'x' },
      });
    } finally {
      console.warn = original;
    }
    const api = (
      counter as unknown as { countApi: { providers: Record<string, unknown> } }
    ).countApi;
    expect(Object.keys(api.providers)).toEqual([]);
  });
});

// ─── The optional-peer fallback ──────────────────────────────────────────────

/** A counter whose async measurement always throws the given error. */
function throwingCounter(err: unknown): TokenCounter {
  return {
    estimate: () => 0,
    estimateMessage: () => 0,
    measure: async () => {
      throw err;
    },
    measureMessage: async () => {
      throw err;
    },
    learn: () => {},
  };
}

function hybridWithBrokenTiktoken(err: unknown): HybridTokenCounter {
  const hybrid = new HybridTokenCounter({ catalog: catalogWith('tiktoken', 4) });
  // The catalog names tiktoken; substitute a counter standing in for a peer
  // that is not installed on the consumer's machine.
  (hybrid as unknown as { _tiktoken: TokenCounter })._tiktoken = throwingCounter(err);
  return hybrid;
}

describe('HybridTokenCounter — the peer being absent', () => {
  const ctx = { provider: 'acme', model: 'm1' };

  it('falls back to the heuristic when the peer is missing, and says so ONCE', async () => {
    const hybrid = hybridWithBrokenTiktoken(tiktokenUnavailableError(new Error('no module')));
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };
    try {
      expect(await hybrid.measure('x'.repeat(40), ctx)).toBe(10);
      expect(await hybrid.measureMessage({ role: 'user', content: 'x'.repeat(80) }, ctx)).toBe(20);
      await hybrid.measure('x'.repeat(40), ctx);
    } finally {
      console.warn = original;
    }

    // Once per counter, not once per call — an uninstalled peer is a
    // configuration fact, and repeating it trains the reader to ignore it.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('npm i tiktoken');
    expect(warnings[0]).toContain('falling back to the heuristic');
  });

  it('any OTHER failure surfaces instead of being answered with an estimate', async () => {
    const hybrid = hybridWithBrokenTiktoken(new Error('wasm segfault'));
    await expect(hybrid.measure('hello', ctx)).rejects.toThrow('wasm segfault');
    await expect(hybrid.measureMessage({ role: 'user', content: 'hi' }, ctx)).rejects.toThrow(
      'wasm segfault',
    );
  });

  it('with the peer present, measure() is exact and no warning is emitted', async () => {
    const catalog = new ModelCatalog();
    catalog.set('openai', 'gpt-4o', {
      pricing: {},
      tokenizer: { strategy: 'tiktoken', charsPerTokenDefault: 4, countApiAvailable: false },
    } as never);
    const hybrid = new HybridTokenCounter({ catalog });

    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };
    try {
      // The heuristic would say ceil(11/4) = 3; the real tokenizer says 2.
      expect(await hybrid.measure('hello world', { provider: 'openai', model: 'gpt-4o' })).toBe(2);
    } finally {
      console.warn = original;
    }
    expect(warnings).toEqual([]);
  });
});

// ─── Calibration ─────────────────────────────────────────────────────────────

describe('HeuristicCounter — calibration', () => {
  const ctx = { provider: 'acme', model: 'm1' };

  it('without a store, learn() is a no-op rather than a crash', () => {
    const counter = new HeuristicCounter(catalogWith('heuristic', 4));
    // Nowhere to record a ratio is the DEFAULT configuration, not an error.
    expect(() =>
      counter.learn({ ...ctx, bytesSent: 1000, actualTokens: 100, timestamp: 0 }),
    ).not.toThrow();
    expect(counter.estimate('x'.repeat(40), ctx)).toBe(10);
  });

  it('a partial token is rounded UP, never truncated away', () => {
    const counter = new HeuristicCounter(catalogWith('heuristic', 4));
    // 41 chars at 4 chars/token is 10.25 tokens. Rounding down would let a
    // request that does not fit report that it does.
    expect(counter.estimate('x'.repeat(41), ctx)).toBe(11);
    expect(counter.estimateMessage({ role: 'user', content: 'x'.repeat(41) }, ctx)).toBe(11);
  });

  it('learn() records the observed chars-per-token ratio', () => {
    const store = new RecordingStore();
    new HeuristicCounter(catalogWith('heuristic'), store).learn({
      ...ctx,
      contentClass: 'code',
      bytesSent: 1000,
      actualTokens: 250,
      timestamp: 0,
    });
    expect(store.updates).toEqual([
      {
        provider: 'acme',
        model: 'm1',
        contentClass: 'code',
        charsPerToken: 4,
        samples: 1,
      },
    ]);
  });

  it('learn() ignores samples that cannot produce a ratio', () => {
    const store = new RecordingStore();
    const counter = new HeuristicCounter(catalogWith('heuristic'), store);
    counter.learn({ ...ctx, bytesSent: 0, actualTokens: 100, timestamp: 0 });
    counter.learn({ ...ctx, bytesSent: -5, actualTokens: 100, timestamp: 0 });
    counter.learn({ ...ctx, bytesSent: 100, actualTokens: 0, timestamp: 0 });
    counter.learn({ ...ctx, bytesSent: 100, actualTokens: -1, timestamp: 0 });
    expect(store.updates).toEqual([]);
  });

  it('a store that rejects the update is swallowed — calibration is best-effort', async () => {
    const store = new RecordingStore();
    store.rejectUpdates = true;
    const counter = new HeuristicCounter(catalogWith('heuristic'), store);

    // A rejected update must not become an unhandled rejection nor a throw.
    expect(() =>
      counter.learn({ ...ctx, bytesSent: 1000, actualTokens: 250, timestamp: 0 }),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.updates).toHaveLength(1);
  });

  it('warmCache() pre-loads learned rates so the SYNC estimate uses them', async () => {
    const store = new RecordingStore();
    store.seed({
      provider: 'acme',
      model: 'm1',
      contentClass: undefined,
      charsPerToken: 8,
      samples: 20,
      confidence: 1,
      lastUpdated: 0,
    });
    const counter = new HeuristicCounter(catalogWith('heuristic', 4), store);

    // Before warming: the catalog default of 4 chars per token.
    expect(counter.estimate('x'.repeat(40), ctx)).toBe(10);
    await counter.warmCache();
    // After warming: the learned 8 chars per token.
    expect(counter.estimate('x'.repeat(40), ctx)).toBe(5);
    expect(counter.estimateMessage({ role: 'user', content: 'x'.repeat(40) }, ctx)).toBe(5);
  });

  it('warmCache() without a store is a no-op', async () => {
    const counter = new HeuristicCounter(catalogWith('heuristic', 4));
    await counter.warmCache();
    expect(counter.estimate('x'.repeat(40), ctx)).toBe(10);
  });

  it('async measure() consults the store and caches the answer for later sync calls', async () => {
    const store = new RecordingStore();
    store.seed({
      provider: 'acme',
      model: 'm1',
      contentClass: undefined,
      charsPerToken: 10,
      samples: 5,
      confidence: 1,
      lastUpdated: 0,
    });
    const counter = new HeuristicCounter(catalogWith('heuristic', 4), store);

    expect(await counter.measure('x'.repeat(40), ctx)).toBe(4);
    expect(await counter.measureMessage({ role: 'user', content: 'x'.repeat(40) }, ctx)).toBe(4);
    // The sync path now agrees, without a second store round-trip.
    expect(counter.estimate('x'.repeat(40), ctx)).toBe(4);
  });

  it('a store entry with no samples yet is ignored in favour of the catalog default', async () => {
    const store = new RecordingStore();
    store.seed({
      provider: 'acme',
      model: 'm1',
      contentClass: undefined,
      charsPerToken: 10,
      samples: 0,
      confidence: 1,
      lastUpdated: 0,
    });
    const counter = new HeuristicCounter(catalogWith('heuristic', 4), store);
    expect(await counter.measure('x'.repeat(40), ctx)).toBe(10);
  });

  it('measure() with no provider/model skips the store entirely', async () => {
    const store = new RecordingStore();
    const counter = new HeuristicCounter(catalogWith('heuristic', 4), store);
    expect(await counter.measure('x'.repeat(40))).toBe(10); // 4.0 global fallback
  });

  it('a catalog rate of zero or less is rejected in favour of the 4.0 fallback', () => {
    const c = new ModelCatalog();
    c.set('acme', 'm1', {
      pricing: {},
      tokenizer: { strategy: 'heuristic', charsPerTokenDefault: 0, countApiAvailable: false },
    } as never);
    expect(new HeuristicCounter(c).estimate('x'.repeat(40), ctx)).toBe(10);
  });

  it('calibration is keyed by content class, so prose and code do not blur', async () => {
    const store = new RecordingStore();
    store.seed({
      provider: 'acme',
      model: 'm1',
      contentClass: 'code' as ContentClass,
      charsPerToken: 2,
      samples: 9,
      confidence: 1,
      lastUpdated: 0,
    });
    const counter = new HeuristicCounter(catalogWith('heuristic', 4), store);
    await counter.warmCache();
    expect(counter.estimate('x'.repeat(40), { ...ctx, contentClass: 'code' })).toBe(20);
    expect(counter.estimate('x'.repeat(40), ctx)).toBe(10);
  });
});

describe('HybridTokenCounter — warmCache delegates to the heuristic', () => {
  it('warms the sync cache used by estimate()', async () => {
    const store = new RecordingStore();
    store.seed({
      provider: 'acme',
      model: 'm1',
      contentClass: undefined,
      charsPerToken: 8,
      samples: 20,
      confidence: 1,
      lastUpdated: 0,
    });
    const hybrid = new HybridTokenCounter({
      catalog: catalogWith('heuristic', 4),
      calibrationStore: store,
    });
    const ctx = { provider: 'acme', model: 'm1' };

    expect(hybrid.estimate('x'.repeat(40), ctx)).toBe(10);
    await hybrid.warmCache();
    expect(hybrid.estimate('x'.repeat(40), ctx)).toBe(5);
  });

  it('learn() reaches the heuristic even when the catalog names another strategy', () => {
    const store = new RecordingStore();
    const hybrid = new HybridTokenCounter({
      catalog: catalogWith('tiktoken'),
      calibrationStore: store,
    });
    hybrid.learn({
      provider: 'acme',
      model: 'm1',
      bytesSent: 800,
      actualTokens: 200,
      timestamp: 0,
    });
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0].charsPerToken).toBe(4);
  });
});

describe('messageChars — what the heuristic actually counts', () => {
  const counter = new HeuristicCounter(null);
  const chars = (m: Message): number => counter.estimateMessage(m, undefined) * 4;

  it('a media part costs a flat 1000 characters', () => {
    for (const type of ['image', 'audio', 'video', 'document'] as const) {
      expect(
        chars({ role: 'user', content: [{ type, source: { type: 'url', url: 'u' } }] as never }),
      ).toBe(1000);
    }
  });

  it('generated media output costs the same flat 1000 characters', () => {
    for (const type of ['image_output', 'audio_output', 'video_output'] as const) {
      expect(chars({ role: 'assistant', content: [{ type, id: 'x' }] as never })).toBe(1000);
    }
  });

  it('a tool call costs its name, its serialized arguments, and 10 for framing', () => {
    const args = { city: 'Prague' };
    const expected = 'lookup'.length + JSON.stringify(args).length + 10;
    expect(
      chars({
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c', name: 'lookup', arguments: args }],
      }),
    ).toBe(Math.ceil(expected / 4) * 4);
  });
});
