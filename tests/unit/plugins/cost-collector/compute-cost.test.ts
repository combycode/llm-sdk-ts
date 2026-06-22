/** computeCost — the unified cost engine. Positive + negative scenarios across
 *  the provider → token → media-unit → unknown ladder. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { computeCost } from '../../../../src/plugins/cost-collector/cost-collector-internal';
import { ModelCatalog } from '../../../../src/plugins/model-catalog/catalog';

let catalog: ModelCatalog;

beforeEach(() => {
  catalog = new ModelCatalog();
  // chat (token-priced)
  catalog.set('anthropic', 'claude-x', { pricing: { inputPerMTok: 5, outputPerMTok: 25 } });
  // gpt-image: token-priced IMAGE
  catalog.set('openai', 'gpt-image-1', { pricing: { inputPerMTok: 8, outputPerMTok: 32 } });
  // imagen: per-image (no token rates)
  catalog.set('google', 'imagen-4', { pricing: { perImage: 0.04 } });
  // veo: per-second + perUnit by resolution
  catalog.set('google', 'veo-3', {
    pricing: { perSecond: 0.4, perUnit: { '720p': 0.1, '1080p': 0.12 } },
  });
  // grok image: per-image + perUnit by resolution
  catalog.set('xai', 'grok-img', { pricing: { perImage: 0.02, perUnit: { '1k': 0.002, '2k': 0.02 } } });
  // tts: char-priced
  catalog.set('openai', 'tts-x', { pricing: { perMChars: 15 } });
  // openrouter passthrough (token rates present but provider reports cost)
  catalog.set('openrouter', 'or-x', { pricing: { inputPerMTok: 1, outputPerMTok: 1 } });
});

const tokens = (input: number, output: number) => ({
  input,
  output,
  cached: 0,
  cacheWrite: 0,
  reasoning: 0,
});

describe('computeCost — positive', () => {
  it('chat: token cost from per-MTok rates', () => {
    const c = computeCost(catalog, { provider: 'anthropic', model: 'claude-x', tokens: tokens(1_000_000, 500_000) });
    expect(c.total).toBeCloseTo(5 + 12.5, 6);
    expect(c.source).toBe('calculated');
  });

  it('gpt-image: token-priced image', () => {
    const c = computeCost(catalog, { provider: 'openai', model: 'gpt-image-1', tokens: tokens(1000, 500), media: { type: 'image', count: 1 } });
    expect(c.total).toBeCloseTo(0.008 + 0.016, 6);
    expect(c.source).toBe('calculated');
  });

  it('video: perUnit[resolution] × seconds', () => {
    const c = computeCost(catalog, { provider: 'google', model: 'veo-3', media: { type: 'video', durationSeconds: 8, resolution: '1080p' } });
    expect(c.total).toBeCloseTo(0.96, 6);
  });

  it('video: falls back to perSecond when resolution not in perUnit', () => {
    const c = computeCost(catalog, { provider: 'google', model: 'veo-3', media: { type: 'video', durationSeconds: 8, resolution: '4k' } });
    expect(c.total).toBeCloseTo(3.2, 6);
  });

  it('image: perImage × count', () => {
    const c = computeCost(catalog, { provider: 'google', model: 'imagen-4', media: { type: 'image', count: 2 } });
    expect(c.total).toBeCloseTo(0.08, 6);
  });

  it('image: perUnit[resolution] overrides perImage', () => {
    const c = computeCost(catalog, { provider: 'xai', model: 'grok-img', media: { type: 'image', count: 1, resolution: '2k' } });
    expect(c.total).toBeCloseTo(0.02, 6);
  });

  it('audio: perMChars × chars', () => {
    const c = computeCost(catalog, { provider: 'openai', model: 'tts-x', media: { type: 'audio', textChars: 500_000 } });
    expect(c.total).toBeCloseTo(7.5, 6);
  });

  it('provider-reported total wins over token math', () => {
    const c = computeCost(catalog, {
      provider: 'openrouter',
      model: 'or-x',
      tokens: tokens(1_000_000, 1_000_000),
      providerEvidence: { cost: 0.123 },
    });
    expect(c.total).toBe(0.123);
    expect(c.source).toBe('provider');
  });

  it('xai cost ticks treated as provider total', () => {
    const c = computeCost(catalog, { provider: 'xai', model: 'grok-img', providerEvidence: { cost_usd: 0.05 } });
    expect(c.total).toBe(0.05);
    expect(c.source).toBe('provider');
  });
});

describe('computeCost — negative / edge', () => {
  it('unknown provider + no pricing → unknown, 0', () => {
    const c = computeCost(catalog, { provider: 'nope', model: 'nope', tokens: tokens(100, 100) });
    expect(c.total).toBe(0);
    expect(c.source).toBe('unknown');
  });

  it('unit-priced model with incidental usage still prices by unit (not token)', () => {
    const c = computeCost(catalog, {
      provider: 'google',
      model: 'imagen-4',
      tokens: tokens(1000, 1000),
      media: { type: 'image', count: 1 },
    });
    expect(c.total).toBeCloseTo(0.04, 6); // perImage, NOT token math
    expect(c.source).toBe('calculated');
  });

  it('image count 0 → 0 (calculated)', () => {
    const c = computeCost(catalog, { provider: 'google', model: 'imagen-4', media: { type: 'image', count: 0 } });
    expect(c.total).toBe(0);
    expect(c.source).toBe('calculated');
  });

  it('video without resolution falls back to perSecond', () => {
    const c = computeCost(catalog, { provider: 'google', model: 'veo-3', media: { type: 'video', durationSeconds: 4 } });
    expect(c.total).toBeCloseTo(1.6, 6);
  });

  it('zero-usage chat → 0 calculated', () => {
    const c = computeCost(catalog, { provider: 'anthropic', model: 'claude-x', tokens: tokens(0, 0) });
    expect(c.total).toBe(0);
    expect(c.source).toBe('calculated');
  });

  it('non-numeric provider evidence is ignored (not provider-sourced)', () => {
    const c = computeCost(catalog, {
      provider: 'openrouter',
      model: 'or-x',
      tokens: tokens(1_000_000, 0),
      providerEvidence: { cost: 'oops' },
    });
    expect(c.source).toBe('calculated');
    expect(c.total).toBeCloseTo(1, 6);
  });

  it('media with no applicable rate → unknown', () => {
    // imagen has perImage only; ask for audio → no perMChars → null → unknown.
    const c = computeCost(catalog, { provider: 'google', model: 'imagen-4', media: { type: 'audio', textChars: 1000 } });
    expect(c.total).toBe(0);
    expect(c.source).toBe('unknown');
  });
});
