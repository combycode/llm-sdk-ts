import { describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../../src/plugins/model-catalog/catalog';

describe('ModelCatalog', () => {
  it('starts empty', () => {
    expect(new ModelCatalog().size).toBe(0);
  });

  it('set + get round-trips', () => {
    const c = new ModelCatalog();
    c.set('anthropic', 'claude-x', { pricing: { inputPerMTok: 5, outputPerMTok: 25 } });
    const info = c.get('anthropic', 'claude-x');
    expect(info?.pricing.inputPerMTok).toBe(5);
    expect(info?.preferredApi).toBe('completions');
  });

  describe('builtinTools (adapter-sourced injection)', () => {
    it('injects provider builtin tools for tool-capable models', () => {
      const c = new ModelCatalog();
      c.set('anthropic', 'claude-x', { pricing: {}, capabilities: { toolUse: true } as never });
      expect(c.builtinToolsFor('anthropic', 'claude-x')).toEqual(['web_search', 'code_interpreter']);
      expect(c.supportsBuiltinTool('anthropic', 'claude-x', 'code_interpreter')).toBe(true);
      expect(c.supportsBuiltinTool('anthropic', 'claude-x', 'file_search')).toBe(false);
    });

    it('openrouter gets web_search only (no code_interpreter routing)', () => {
      const c = new ModelCatalog();
      c.set('openrouter', 'x/y', { pricing: {}, capabilities: { toolUse: true } as never });
      expect(c.builtinToolsFor('openrouter', 'x/y')).toEqual(['web_search']);
      expect(c.supportsBuiltinTool('openrouter', 'x/y', 'code_interpreter')).toBe(false);
    });

    it('non-tool models (embeddings/media) get none', () => {
      const c = new ModelCatalog();
      c.set('openai', 'embed-x', { pricing: {}, capabilities: { toolUse: false } as never });
      expect(c.builtinToolsFor('openai', 'embed-x')).toEqual([]);
    });

    it('explicit builtinTools on the entry wins', () => {
      const c = new ModelCatalog();
      c.set('openai', 'gpt-x', {
        pricing: {},
        capabilities: { toolUse: true, builtinTools: ['web_search'] } as never,
      });
      expect(c.builtinToolsFor('openai', 'gpt-x')).toEqual(['web_search']);
    });
  });

  it('availability round-trips (limited / preview access tier; undefined = GA)', () => {
    const c = new ModelCatalog();
    c.set('anthropic', 'claude-fable-5', { pricing: {}, availability: 'limited' });
    c.set('xai', 'grok-imagine-video-1.5-preview', { pricing: {}, availability: 'preview' });
    c.set('openai', 'gpt-x', { pricing: {} });
    expect(c.get('anthropic', 'claude-fable-5')?.availability).toBe('limited');
    expect(c.get('xai', 'grok-imagine-video-1.5-preview')?.availability).toBe('preview');
    expect(c.get('openai', 'gpt-x')?.availability).toBeUndefined();
  });

  it('load supports legacy pricing-only and modern object formats', () => {
    const c = new ModelCatalog();
    c.load({
      'openai/old': { inputPerMTok: 1, outputPerMTok: 2 },
      'openai/new': {
        pricing: { inputPerMTok: 3 },
        preferredApi: 'responses',
        supportedApis: ['responses'],
      },
    });
    expect(c.getPricing('openai', 'old')?.inputPerMTok).toBe(1);
    expect(c.getPreferredApi('openai', 'new')).toBe('responses');
  });

  it('supportsPreviousResponseId honors per-model + provider defaults', () => {
    const c = new ModelCatalog();
    c.set('openai', 'gpt-x', {
      pricing: {},
      supportedApis: ['responses'],
      preferredApi: 'responses',
    });
    expect(c.supportsPreviousResponseId('openai', 'gpt-x')).toBe(true);

    c.set('openai', 'gpt-no-chain', {
      pricing: {},
      supportedApis: ['responses'],
      preferredApi: 'responses',
      supportsPreviousResponseId: false,
    });
    expect(c.supportsPreviousResponseId('openai', 'gpt-no-chain')).toBe(false);
  });

  it('list filters by provider', () => {
    const c = new ModelCatalog();
    c.set('a', 'm1', { pricing: {} });
    c.set('a', 'm2', { pricing: {} });
    c.set('b', 'm3', { pricing: {} });
    expect(c.list('a').length).toBe(2);
    expect(c.list().length).toBe(3);
  });
});
