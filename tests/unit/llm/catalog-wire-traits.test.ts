/** The CATALOG decides how to talk to a model — never a regex over the id.
 *
 *  Two shipped bugs came from adapters parsing the model id to pick a wire shape:
 *  2.2.1 (Anthropic flipped `thinking` at 4.6) and the 4.0 date-suffix defect.
 *  The catalog already knew what a model could DO; nothing knew how to SAY it.
 *
 *  This file used to prove that through `ModelInfo.wire`, per-model traits the
 *  adapters read. Those traits are gone: they and `wireSpec` were two
 *  representations of one fact, and two representations drift — the original
 *  failure in miniature. The pin is the single representation that survives, so
 *  the same property is proved through it.
 *
 *  What has to be true, unchanged:
 *    1. when the catalog pins a model, the adapter follows the pin — even when it
 *       CONTRADICTS what the id implies, which is the only way to show the catalog
 *       is genuinely driving rather than agreeing by luck;
 *    2. when the catalog is silent, the id still decides, so a catalog-less engine
 *       and a model newer than this build both keep working.
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { ModelCatalog } from '../../../src/catalog/catalog';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const anthropic = new AnthropicAdapter({ apiKey: 'k' });
const google = new GoogleAdapter({ apiKey: 'k' });

const body = (
  a: { buildRequest: (r: NormalizedRequest) => unknown },
  model: string,
  extra: Record<string, unknown>,
) =>
  (
    a.buildRequest({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      ...extra,
    } as unknown as NormalizedRequest) as { body: Record<string, unknown> }
  ).body;

const thinkingType = (b: Record<string, unknown>) =>
  (b.thinking as { type?: string } | undefined)?.type;

const thinkingConfig = (b: Record<string, unknown>) =>
  (b.generationConfig as Record<string, unknown>)?.thinkingConfig as Record<string, unknown>;

describe('the bundled catalog pins every chat model', () => {
  const catalog = new ModelCatalog();
  catalog.loadProviderDefaults();
  const chat = catalog.list().filter((m) => m.type === 'chat');

  it('anthropic models all carry a pin, spread across the whole chain', () => {
    const mine = chat.filter((m) => m.provider === 'anthropic');
    expect(mine.length).toBeGreaterThanOrEqual(14);
    expect(mine.filter((m) => !m.wireSpec).map((m) => m.model)).toEqual([]);
    // Every chain node is reachable: one nothing points at is one nobody tests.
    expect([...new Set(mine.map((m) => m.wireSpec))].sort()).toEqual([
      'anthropic/messages@4.0',
      'anthropic/messages@4.1',
      'anthropic/messages@4.6',
      'anthropic/messages@4.7',
    ]);
  });

  it('google models split across the 2.5 / 3.x boundary', () => {
    const mine = chat.filter((m) => m.provider === 'google');
    expect(mine.length).toBeGreaterThanOrEqual(12);
    expect([...new Set(mine.map((m) => m.wireSpec))].sort()).toEqual([
      'google/generate@2.5',
      'google/generate@3',
    ]);
  });
});

describe('the pin OVERRIDES what the id implies', () => {
  it('anthropic: a budgeted pin beats an id that reads as adaptive', () => {
    const b = body(anthropic, 'claude-sonnet-5', {
      wireSpec: 'anthropic/messages@4.1',
      thinking: { mode: 'on', effort: 'high' },
    });
    expect(thinkingType(b)).toBe('enabled');
  });

  it('anthropic: an adaptive pin beats an id that reads as budgeted', () => {
    const b = body(anthropic, 'claude-opus-4-20250514', {
      wireSpec: 'anthropic/messages@4.7',
      thinking: { mode: 'on' },
    });
    expect(thinkingType(b)).toBe('adaptive');
  });

  it('anthropic: a 4.7 pin suppresses top_k on an id whose band accepts it', () => {
    const b = body(anthropic, 'claude-opus-4-6', {
      wireSpec: 'anthropic/messages@4.7',
      topK: 20,
    });
    expect(b.top_k).toBeUndefined();
  });

  it('anthropic: a 4.6 pin sends top_k on an id whose band rejects it', () => {
    const b = body(anthropic, 'claude-sonnet-5', {
      wireSpec: 'anthropic/messages@4.6',
      topK: 20,
    });
    expect(b.top_k).toBe(20);
  });

  it('google: a 3.x pin beats a 2.5 id', () => {
    const cfg = thinkingConfig(
      body(google, 'gemini-2.5-flash', {
        wireSpec: 'google/generate@3',
        thinking: { mode: 'on', effort: 'high' },
      }),
    );
    expect(cfg.thinkingLevel).toBeDefined();
    expect(cfg.thinkingBudget).toBeUndefined();
  });

  it('google: a 2.5 pin beats a 3.x id', () => {
    const cfg = thinkingConfig(
      body(google, 'gemini-3-flash', {
        wireSpec: 'google/generate@2.5',
        thinking: { mode: 'on', effort: 'high' },
      }),
    );
    expect(cfg.thinkingBudget).toBeDefined();
    expect(cfg.thinkingLevel).toBeUndefined();
  });
});

describe('without a pin, the id still decides', () => {
  // Not an edge case: this is how the SDK behaves on the day a provider ships a
  // model this build has never heard of, and for any engine run without a catalog.
  it('anthropic thinking', () => {
    expect(
      thinkingType(body(anthropic, 'claude-opus-4-20250514', { thinking: { mode: 'on' } })),
    ).toBe('enabled');
    expect(thinkingType(body(anthropic, 'claude-sonnet-5', { thinking: { mode: 'on' } }))).toBe(
      'adaptive',
    );
  });

  it('anthropic top_k', () => {
    expect(body(anthropic, 'claude-opus-4-6', { topK: 20 }).top_k).toBe(20);
    expect(body(anthropic, 'claude-sonnet-5', { topK: 20 }).top_k).toBeUndefined();
  });

  it('google thinking', () => {
    expect(
      thinkingConfig(body(google, 'gemini-2.5-flash', { thinking: { mode: 'on' } })).thinkingBudget,
    ).toBeDefined();
    expect(
      thinkingConfig(body(google, 'gemini-3-flash', { thinking: { mode: 'on' } })).thinkingLevel,
    ).toBeDefined();
  });
});

describe('a pin set on the catalog reaches the adapter', () => {
  it('and wins over the id', () => {
    const catalog = new ModelCatalog();
    catalog.loadProviderDefaults();
    // An id that reads as adaptive, deliberately pinned to the budgeted node.
    catalog.set('anthropic', 'claude-sonnet-5', {
      type: 'chat',
      pricing: {},
      wireSpec: 'anthropic/messages@4.1',
    } as never);

    const pinned = catalog.get('anthropic', 'claude-sonnet-5')?.wireSpec;
    expect(pinned).toBe('anthropic/messages@4.1');

    const b = body(anthropic, 'claude-sonnet-5', { wireSpec: pinned, thinking: { mode: 'on' } });
    expect(thinkingType(b)).toBe('enabled');
  });
});
