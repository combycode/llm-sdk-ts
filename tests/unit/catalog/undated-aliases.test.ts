/** A model's documented name has to reach its catalog entry.
 *
 *  Anthropic's `/v1/models` lists dated snapshots (`claude-haiku-4-5-20251001`)
 *  and never the undated alias (`claude-haiku-4-5`) — but the API accepts the
 *  alias, and it is the spelling the docs put in front of people, so it is what
 *  gets configured. Our slug dots the version (`claude-haiku-4.5`), so the
 *  natural id matched no key and no alias: `get` and `getPricing` missed in
 *  silence. Reported from production as 72k tokens billed at $0.00 — a miss that
 *  reads exactly like a free model.
 *
 *  Both directions are load-bearing. Recognising MORE ids is the fix; sending a
 *  DIFFERENT id would be a new bug, so the wire behaviour is pinned too.
 */
import { describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../src/catalog/catalog';

const catalog = new ModelCatalog();
catalog.loadProviderDefaults();

/** Verified live against the Anthropic API on 2026-08-25: each of these is
 *  accepted by `/v1/messages` (claude-opus-4-1 excepted — that model is delisted
 *  and 404s under BOTH its ids, so it is an alias for pricing history only). */
const UNDATED = [
  ['claude-haiku-4-5', 'claude-haiku-4.5'],
  ['claude-sonnet-4-5', 'claude-sonnet-4.5'],
  ['claude-opus-4-5', 'claude-opus-4.5'],
  ['claude-opus-4-1', 'claude-opus-4.1'],
] as const;

describe('an undated anthropic id resolves and prices', () => {
  for (const [id, dotted] of UNDATED) {
    it(`${id} is found and priced`, () => {
      const info = catalog.get('anthropic', id);
      expect(info).not.toBeNull();
      // The point of the bug report: null pricing is indistinguishable from free.
      const pricing = catalog.getPricing('anthropic', id);
      expect(pricing).not.toBeNull();
      expect(Object.keys(pricing!).length).toBeGreaterThan(0);
    });

    it(`${id} reaches the same entry as ${dotted}`, () => {
      const viaAlias = catalog.get('anthropic', id);
      const viaSlug = catalog.get('anthropic', dotted);
      expect(viaSlug).not.toBeNull();
      expect(viaAlias!.model).toBe(viaSlug!.model);
    });
  }

  it('does not change what goes on the wire', () => {
    // An alias is an explicit choice — a floating "latest 4.5" — and is sent
    // verbatim. The slug still translates to the pinned snapshot. Rewriting the
    // alias to the dated id would silently pin a caller who asked not to be.
    expect(catalog.resolveModelId('anthropic', 'claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(catalog.resolveModelId('anthropic', 'claude-haiku-4.5')).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('never shadows a real slug', () => {
    // `claude-opus-4`'s undated form equals its own catalog key; emitting it as an
    // alias would be a self-reference at best and a shadow at worst.
    const info = catalog.get('anthropic', 'claude-opus-4');
    expect(info?.model).toBe('claude-opus-4');
  });
});

describe('the rule stays anthropic-only', () => {
  // Measured 2026-08-25: OpenAI, Google and xAI all REJECT the hyphenated
  // spelling (`gpt-4-1`, `gemini-2-5-pro`, `grok-4-3` → model_not_found), because
  // their native ids contain real dots — our slug never renamed them. Applying
  // anthropic's convention across providers would mint ids that do not exist
  // (`imagen-4.0-generate`, `command-r7b-12`), and a catalog that prices an
  // uncallable id is a worse lie than one that admits it does not know.
  const FABRICATED = [
    ['openai', 'gpt-4-1'],
    ['openai', 'gpt-5-1'],
    ['google', 'gemini-2-5-pro'],
    ['google', 'imagen-4.0-generate'],
    ['xai', 'grok-4-3'],
    ['openrouter', 'cohere/command-r7b-12'],
  ] as const;

  for (const [provider, id] of FABRICATED) {
    it(`${provider}/${id} is not invented`, () => {
      expect(catalog.get(provider, id)).toBeNull();
    });
  }

  it('leaves every other provider catalog untouched', () => {
    // The undated form of a DATED id exists everywhere; only anthropic may take it.
    for (const provider of ['openai', 'google', 'xai', 'openrouter']) {
      const invented = catalog
        .list()
        .filter((m) => m.provider === provider)
        .flatMap((m) => m.aliases ?? [])
        .filter((a) => /-\d{8}$/.test(a) === false && /^claude-/.test(a));
      expect(invented).toEqual([]);
    }
  });
});
