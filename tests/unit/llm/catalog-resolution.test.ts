/** Slug ↔ callable resolution + tiered pricing against the REAL shipped catalog. */

import { describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';

function defaults(): ModelCatalog {
  const c = new ModelCatalog();
  c.loadProviderDefaults();
  return c;
}

describe('shipped catalog — slug + callable resolution', () => {
  const cat = defaults();

  it('resolves a model by its normalised slug', () => {
    const m = cat.get('anthropic', 'claude-opus-4.8');
    expect(m).not.toBeNull();
    expect(m?.providerModelName).toBe('claude-opus-4-8');
    expect(m?.type).toBe('chat');
    expect(m?.status).toBe('stable');
  });

  it('resolves the SAME model by its callable id (alias index)', () => {
    const bySlug = cat.get('anthropic', 'claude-opus-4.8');
    const byCallable = cat.get('anthropic', 'claude-opus-4-8');
    expect(byCallable).not.toBeNull();
    expect(byCallable?.model).toBe(bySlug?.model); // both → the slug-keyed entry
  });

  it('resolveModelId: slug → providerModelName (translate)', () => {
    expect(cat.resolveModelId('anthropic', 'claude-opus-4.8')).toBe('claude-opus-4-8');
  });

  it('resolveModelId: already-callable id → verbatim', () => {
    expect(cat.resolveModelId('anthropic', 'claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('resolveModelId: unknown model → passthrough', () => {
    expect(cat.resolveModelId('anthropic', 'made-up-model')).toBe('made-up-model');
  });

  it('carries service-tier pricing (standard flat + priority/batch tiers)', () => {
    const p = cat.getPricing('anthropic', 'claude-opus-4.8');
    expect(p?.inputPerMTok).toBe(5);
    expect(p?.outputPerMTok).toBe(25);
    expect(p?.tiers?.priority).toEqual({ inputPerMTok: 10, outputPerMTok: 50 });
    expect(p?.tiers?.batch).toEqual({ inputPerMTok: 2.5, outputPerMTok: 12.5 });
  });

  it('pricing resolves via the callable id too (cost path)', () => {
    expect(cat.getPricing('anthropic', 'claude-opus-4-8')?.inputPerMTok).toBe(5);
  });
});
