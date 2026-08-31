import { describe, expect, it } from 'bun:test';
import {
  selectVariant,
  type PromptVariant,
} from '../../../../src/plugins/internal-tools/runner/variants';

function variant(id: string, extra: Partial<PromptVariant> = {}): PromptVariant {
  return { id, systemPrompt: `sys-${id}`, userTemplate: `user-${id}`, ...extra };
}

describe('selectVariant — guards', () => {
  it('throws on an empty variants array', () => {
    expect(() => selectVariant([], { provider: 'openai', model: 'm' })).toThrow(
      'selectVariant: variants array is empty',
    );
  });

  it('throws when nothing matches and there is no default', () => {
    const variants = [
      variant('a', { supportedProviders: ['google'] }),
      variant('b', { supportedModels: ['xai/grok'] }),
    ];
    expect(() => selectVariant(variants, { provider: 'openai', model: 'gpt' })).toThrow(
      /no match and no default variant/,
    );
  });

  it('reports the attempted context and the variant ids in the failure message', () => {
    const variants = [variant('a', { supportedProviders: ['google'] })];
    expect(() =>
      selectVariant(variants, { provider: 'openai', model: 'gpt', mode: 'fast' }),
    ).toThrow('Tried mode="fast", provider="openai", model="gpt". Variants: [a]');
  });

  it('renders an empty mode in the failure message when no mode was requested', () => {
    expect(() =>
      selectVariant([variant('a', { supportedProviders: ['google'] })], {
        provider: 'openai',
        model: 'gpt',
      }),
    ).toThrow('Tried mode="", provider="openai", model="gpt"');
  });
});

describe('selectVariant — no mode requested', () => {
  it('prefers an exact "provider/model" match', () => {
    const variants = [
      variant('default', { isDefault: true }),
      variant('for-provider', { supportedProviders: ['openai'] }),
      variant('for-model', { supportedModels: ['openai/gpt-5.4-nano'] }),
    ];
    expect(selectVariant(variants, { provider: 'openai', model: 'gpt-5.4-nano' }).id).toBe(
      'for-model',
    );
  });

  it('matches the model on the full "provider/model" id, not the bare model name', () => {
    const variants = [
      variant('bare', { supportedModels: ['gpt-5.4-nano'] }),
      variant('default', { isDefault: true }),
    ];
    expect(selectVariant(variants, { provider: 'openai', model: 'gpt-5.4-nano' }).id).toBe(
      'default',
    );
  });

  it('falls back to a provider match when no model matches', () => {
    const variants = [
      variant('default', { isDefault: true }),
      variant('for-provider', { supportedProviders: ['openai'] }),
      variant('for-model', { supportedModels: ['openai/other'] }),
    ];
    expect(selectVariant(variants, { provider: 'openai', model: 'gpt' }).id).toBe('for-provider');
  });

  it('falls back to the default variant when neither model nor provider matches', () => {
    const variants = [
      variant('for-provider', { supportedProviders: ['google'] }),
      variant('default', { isDefault: true }),
    ];
    expect(selectVariant(variants, { provider: 'openai', model: 'gpt' }).id).toBe('default');
  });

  it('picks the first default when several are flagged', () => {
    const variants = [variant('d1', { isDefault: true }), variant('d2', { isDefault: true })];
    expect(selectVariant(variants, { provider: 'openai', model: 'gpt' }).id).toBe('d1');
  });

  it('returns the sole variant when it is the default', () => {
    expect(
      selectVariant([variant('only', { isDefault: true })], { provider: 'x', model: 'y' }).id,
    ).toBe('only');
  });
});

describe('selectVariant — mode requested', () => {
  it('restricts candidates to the requested mode before matching by model', () => {
    const variants = [
      variant('no-mode-model', { supportedModels: ['openai/gpt'] }),
      variant('mode-model', { modes: ['fast'], supportedModels: ['openai/gpt'] }),
      variant('default', { isDefault: true }),
    ];
    expect(selectVariant(variants, { provider: 'openai', model: 'gpt', mode: 'fast' }).id).toBe(
      'mode-model',
    );
  });

  it('restricts candidates to the requested mode before matching by provider', () => {
    const variants = [
      variant('no-mode-provider', { supportedProviders: ['openai'] }),
      variant('mode-provider', { modes: ['fast'], supportedProviders: ['openai'] }),
      variant('default', { isDefault: true }),
    ];
    expect(selectVariant(variants, { provider: 'openai', model: 'gpt', mode: 'fast' }).id).toBe(
      'mode-provider',
    );
  });

  it('prefers a mode default over the global default', () => {
    const variants = [
      variant('global-default', { isDefault: true }),
      variant('mode-default', { modes: ['fast'], isDefault: true }),
    ];
    expect(selectVariant(variants, { provider: 'openai', model: 'gpt', mode: 'fast' }).id).toBe(
      'mode-default',
    );
  });

  it('falls back to the FIRST mode match when none of them is flagged default', () => {
    const variants = [
      variant('global-default', { isDefault: true }),
      variant('mode-a', { modes: ['fast'] }),
      variant('mode-b', { modes: ['fast'] }),
    ];
    expect(selectVariant(variants, { provider: 'openai', model: 'gpt', mode: 'fast' }).id).toBe(
      'mode-a',
    );
  });

  it('falls back to the global default when NO variant declares the requested mode', () => {
    const variants = [
      variant('mode-a', { modes: ['slow'] }),
      variant('global-default', { isDefault: true }),
    ];
    expect(selectVariant(variants, { provider: 'openai', model: 'gpt', mode: 'fast' }).id).toBe(
      'global-default',
    );
  });

  it('throws when the requested mode is unknown and there is no global default', () => {
    expect(() =>
      selectVariant([variant('mode-a', { modes: ['slow'] })], {
        provider: 'openai',
        model: 'gpt',
        mode: 'fast',
      }),
    ).toThrow(/no match and no default variant/);
  });

  it('matches a variant that declares several modes', () => {
    const variants = [
      variant('multi', { modes: ['fast', 'cheap'] }),
      variant('default', { isDefault: true }),
    ];
    expect(selectVariant(variants, { provider: 'openai', model: 'gpt', mode: 'cheap' }).id).toBe(
      'multi',
    );
  });
});

describe('selectVariant — realistic provider split', () => {
  const variants = [
    variant('strict', { supportedProviders: ['anthropic', 'google'] }),
    variant('balanced', { isDefault: true }),
  ];

  it.each([
    ['anthropic', 'claude-haiku-4-5', 'strict'],
    ['google', 'gemini-3.1-flash-lite-preview', 'strict'],
    ['openai', 'gpt-5.4-nano', 'balanced'],
    ['xai', 'grok', 'balanced'],
  ])('%s/%s selects the "%s" variant', (provider, model, expected) => {
    expect(selectVariant(variants, { provider, model }).id).toBe(expected);
  });
});
