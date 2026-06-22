/** select() — tag-DSL model selection over the shipped catalog. */

import { describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';
import { select, selectModels } from '../../../src/helpers/select-model';
import type { EngineHandle } from '../../../src/helpers/engine';

function engineWith(apiKeys: Record<string, string>): EngineHandle {
  const catalog = new ModelCatalog();
  catalog.loadProviderDefaults();
  return { catalog, apiKeys } as unknown as EngineHandle;
}
const allKeys = { anthropic: 'k', openai: 'k', google: 'k', xai: 'k' };

describe('select()', () => {
  it('returns a provider/slug string feedable to complete()', () => {
    const r = select('type:chat', { engine: engineWith(allKeys) });
    expect(r).toMatch(/^[a-z]+\/.+/);
  });

  it('cheapest-first: a price-filtered chat pick is cheap', () => {
    const eng = engineWith(allKeys);
    const r = select('type:chat; price < 1', { engine: eng })!;
    const [prov, model] = [r.slice(0, r.indexOf('/')), r.slice(r.indexOf('/') + 1)];
    expect(eng.catalog.getPricing(prov, model)!.inputPerMTok!).toBeLessThanOrEqual(1);
  });

  it('inclusive context > N (≥) filters correctly', () => {
    const eng = engineWith(allKeys);
    for (const m of selectModels('type:chat; context > 200k', { engine: eng })) {
      expect(m.contextWindow!).toBeGreaterThanOrEqual(200_000);
    }
  });

  it('capability flag: vision filter only returns vision models', () => {
    const eng = engineWith(allKeys);
    for (const m of selectModels('vision', { engine: eng })) {
      expect(m.capabilities.vision).toBe(true);
    }
  });

  it('reasoning:off excludes reasoning models', () => {
    const eng = engineWith(allKeys);
    for (const m of selectModels('reasoning:off', { engine: eng })) {
      expect(m.reasoning.supported).toBe(false);
    }
  });

  it('availability-aware: no key for a provider → its models excluded', () => {
    const eng = engineWith({ anthropic: 'k' }); // only anthropic configured
    for (const m of selectModels('type:chat', { engine: eng })) {
      expect(m.provider).toBe('anthropic');
    }
  });

  it('custom tag expands (cheap → price:low)', () => {
    const eng = engineWith(allKeys);
    const r = select('cheap; type:chat', { engine: eng })!;
    const model = r.slice(r.indexOf('/') + 1);
    const prov = r.slice(0, r.indexOf('/'));
    expect(eng.catalog.getPricing(prov, model)!.inputPerMTok!).toBeLessThanOrEqual(1);
  });

  it('user-defined custom tag', () => {
    const eng = engineWith(allKeys);
    const r = select('coding', { engine: eng, prefs: { tags: { coding: 'type:code' } } });
    if (r) expect(eng.catalog.get(r.slice(0, r.indexOf('/')), r.slice(r.indexOf('/') + 1))!.type).toBe('code');
  });

  it('unknown filter key throws a helpful error', () => {
    expect(() => select('frobnicate:yes', { engine: engineWith(allKeys) })).toThrow(/unknown filter/);
  });

  it('no match → null', () => {
    expect(select('context > 999M', { engine: engineWith(allKeys) })).toBeNull();
  });

  it('only active (callable) models by default', () => {
    const eng = engineWith(allKeys);
    for (const m of selectModels('type:chat', { engine: eng })) {
      expect(m.active).not.toBe(false);
    }
  });
});
