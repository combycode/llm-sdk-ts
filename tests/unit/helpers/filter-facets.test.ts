/** The facet list and the query parser cannot disagree.
 *
 *  A picker that offers filter tags has to get them from somewhere. Hand-listing
 *  them puts a second copy of this vocabulary in every consumer, and that copy
 *  drifts silently: a tag the parser no longer knows comes back as "no models
 *  matched", which reads like an empty result rather than a broken filter.
 *
 *  So `filterFacets()` is derived from the same constants the parser matches on,
 *  and these tests are the proof — every facet is a clause the parser accepts,
 *  every value actually selects, and a key the parser knows cannot be missing
 *  from the list a UI shows.
 */
import { describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../src/catalog/catalog';
import { createEngine } from '../../../src/helpers/engine';
import { filterAliases, filterFacets, selectModels } from '../../../src/helpers/select-model';

const catalog = new ModelCatalog();
catalog.loadProviderDefaults();

const engine = createEngine({
  registerAsDefault: false,
  apiKeys: { openai: 'k', anthropic: 'k', google: 'k', xai: 'k', openrouter: 'k' },
});

const facets = filterFacets(catalog);

describe('filterFacets', () => {
  it('offers every clause the parser understands', () => {
    // The parser throws `unknown filter "x"` for anything outside its key set, so
    // this asserts the facet list is not missing one — a key nobody can reach
    // through the UI is a feature that quietly does not exist.
    const message = (() => {
      try {
        selectModels('definitely_not_a_key:1', { engine });
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    const known = message.slice(message.indexOf('Known:') + 6).split(',').map((k) => k.trim()).filter(Boolean);
    expect(known.length).toBeGreaterThan(0);
    expect([...new Set(facets.map((f) => f.key))].sort()).toEqual(known.sort());
  });

  it('every facet value is a clause the parser accepts', () => {
    // Not "returns results" — an empty result is legitimate. The check is that the
    // parser does not REJECT it, which is what a stale value would cause.
    const rejected: string[] = [];
    for (const facet of facets) {
      for (const value of facet.values) {
        try {
          selectModels(`${facet.key}:${value}`, { engine });
        } catch (e) {
          rejected.push(`${facet.key}:${value} — ${(e as Error).message}`);
        }
      }
      if (facet.bare) {
        try {
          selectModels(facet.key, { engine });
        } catch (e) {
          rejected.push(`${facet.key} (bare) — ${(e as Error).message}`);
        }
      }
    }
    expect(rejected).toEqual([]);
  });

  it('takes open sets from the catalog rather than a hard-coded list', () => {
    const types = facets.find((f) => f.key === 'type')!.values;
    const catalogTypes = [...new Set(catalog.list().map((m) => m.type))];
    expect(types.sort()).toEqual(catalogTypes.sort());
    expect(types).toContain('chat');

    const providers = facets.find((f) => f.key === 'provider')!.values;
    expect(providers).toEqual(['anthropic', 'google', 'openai', 'openrouter', 'xai']);
  });

  it('reports empty value lists rather than guesses when it has no catalog', () => {
    // An empty list is honest — "we do not know what types exist" — where a
    // hard-coded fallback would be confidently wrong the day a type is added.
    const blind = filterFacets();
    expect(blind.find((f) => f.key === 'type')!.values).toEqual([]);
    expect(blind.find((f) => f.key === 'provider')!.values).toEqual([]);
    // Closed sets are still known without a catalog.
    expect(blind.find((f) => f.key === 'price')!.values).toEqual(['free', 'low', 'mid', 'high']);
  });

  it('every alias expands to a clause the parser accepts', () => {
    for (const [alias, expansion] of Object.entries(filterAliases())) {
      expect(() => selectModels(alias, { engine })).not.toThrow();
      expect(() => selectModels(expansion, { engine })).not.toThrow();
    }
  });

  it('a facet actually narrows the result set', () => {
    // Guards the whole thing being decorative: if these came back identical, the
    // picker would be offering filters that filter nothing.
    const all = selectModels('active', { engine }).length;
    const reasoning = selectModels('active; reasoning', { engine }).length;
    const cheap = selectModels('active; price:free', { engine }).length;
    expect(all).toBeGreaterThan(reasoning);
    expect(all).toBeGreaterThan(cheap);
  });
});
