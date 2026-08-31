/** The catalog is loaded by default, and that is load-bearing.
 *
 *  It used to start EMPTY unless the caller passed `catalog: true`. Nothing said
 *  so, and three separate things quietly fell back at once: the wire spec was
 *  derived from the model id instead of read from its pin, every price was
 *  unknown, and every token count was the 4-chars-per-token estimate. Each
 *  fallback is correct in isolation — for a model this build has never heard of —
 *  which is exactly why the silence was hard to notice.
 *
 *  The whole 3.0.0 wire-spec design rests on adapters being able to see per-model
 *  data (report 037, R1). An empty catalog by default meant they usually could not.
 */

import { describe, expect, it } from 'bun:test';
import { createEngine } from '../../../src/helpers/engine';
import { ModelCatalog } from '../../../src/catalog/catalog';

const engine = (catalog?: unknown) =>
  createEngine({ apiKeys: { openai: 'k' }, registerAsDefault: false, catalog } as never);

describe('an engine has model data unless it is told not to', () => {
  it('loads the bundled catalogs when nothing is said', () => {
    expect(engine().catalog.list().length).toBeGreaterThan(400);
  });

  it('resolves the wire-spec PIN, so a request is built from data rather than from the id', () => {
    const cat = engine().catalog;
    expect(cat.get('anthropic', 'claude-sonnet-5')?.wireSpec).toBe('anthropic/messages@4.7');
    expect(cat.get('google', 'gemini-2.5-flash')?.wireSpec).toBe('google/generate@2.5');
  });

  it('knows what a model costs, so a price is a number rather than a shrug', () => {
    expect(engine().catalog.get('openai', 'gpt-5.4-nano')?.pricing?.inputPerMTok).toBeGreaterThan(0);
  });

  it('still accepts an explicit instance, entries, or the defaults by name', () => {
    const mine = new ModelCatalog();
    mine.set('openai', 'mine', { pricing: {} } as never);
    expect(engine(mine).catalog).toBe(mine);
    expect(engine({ entries: { 'openai/x': { pricing: {} } } }).catalog.list().length).toBe(1);
    expect(engine('defaults').catalog.list().length).toBeGreaterThan(400);
    expect(engine(true).catalog.list().length).toBeGreaterThan(400);
  });

  it('opts out only when asked, and says which words do it', () => {
    expect(engine(false).catalog.list()).toEqual([]);
    expect(engine('empty').catalog.list()).toEqual([]);
  });

  it('gives each engine its OWN catalog, because the catalog is mutable', () => {
    const a = engine();
    const b = engine();
    a.catalog.set('openai', 'only-in-a', { pricing: {} } as never);
    expect(a.catalog.get('openai', 'only-in-a')).toBeDefined();
    expect(b.catalog.get('openai', 'only-in-a')).toBeNull();
  });
});

describe('capability lookups for a model the catalog has never heard of', () => {
  const cat = engine().catalog;

  it('supportsApi is true only for an api the model actually lists', () => {
    const info = cat.get('openai', 'gpt-5.4-nano');
    expect(info?.supportedApis.length).toBeGreaterThan(0);
    for (const api of info?.supportedApis ?? []) {
      expect(cat.supportsApi('openai', 'gpt-5.4-nano', api)).toBe(true);
    }
    expect(cat.supportsApi('openai', 'gpt-5.4-nano', 'interactions')).toBe(false);
  });

  it('supportsApi is FALSE for an unknown model, never a permissive true', () => {
    // A shrug that reads as "yes" routes the request to an API the model does
    // not serve, and the 404 arrives from the provider instead of from us.
    expect(cat.supportsApi('openai', 'gpt-99-imaginary', 'responses')).toBe(false);
    expect(cat.supportsApi('nosuchprovider', 'm', 'completions')).toBe(false);
  });

  it('supportsTools reflects the catalog capability and defaults to false', () => {
    expect(cat.supportsTools('openai', 'gpt-5.4-nano')).toBe(
      cat.get('openai', 'gpt-5.4-nano')?.capabilities.toolUse ?? false,
    );
    expect(cat.supportsTools('openai', 'gpt-99-imaginary')).toBe(false);
  });

  it('an explicitly non-tool-capable entry reports false', () => {
    const mine = new ModelCatalog();
    mine.set('openai', 'text-only', {
      pricing: {},
      supportedApis: ['completions'],
      capabilities: { toolUse: false },
    } as never);
    expect(mine.supportsTools('openai', 'text-only')).toBe(false);
    expect(mine.supportsApi('openai', 'text-only', 'completions')).toBe(true);
    expect(mine.supportsApi('openai', 'text-only', 'responses')).toBe(false);
  });
});
