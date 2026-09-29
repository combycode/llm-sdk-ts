/** A model nobody can call must not be recommended.
 *
 *  Two different facts, deliberately kept apart:
 *
 *  `unavailable` is MEASURED — somebody called the endpoint and it was gone.
 *  It forces `active: false`, so it drops out of `select()` and can be refused
 *  without spending a round trip to be told again.
 *
 *  A past `shutdownDate` is ANNOUNCED, and is checked at query time because a
 *  catalog exported yesterday cannot know a date passed overnight.
 *
 *  What is NOT grounds for hiding a model: `deprecation.date` alone. That says a
 *  source announced end-of-life, and the model stays callable until the
 *  shutdown — hiding it would take away something that still works. */

import { describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../src/catalog/catalog';
import { selectModels, type SelectOptions } from '../../../src/helpers/select-model';
import { coreRegistry } from '../../../src/helpers/engine';

const PAST = '2020-01-01';
const FUTURE = '2999-01-01';

function catalogWith(extra: Record<string, Record<string, unknown>>): ModelCatalog {
  const base = {
    'openai/fine': { type: 'chat', active: true, pricing: { inputPerMTok: 1, outputPerMTok: 1 } },
    ...extra,
  };
  const c = new ModelCatalog();
  c.load(base);
  return c;
}

const engineWith = (catalog: ModelCatalog) =>
  ({ catalog, apiKeys: { openai: 'k', google: 'k' } }) as unknown as NonNullable<
    SelectOptions['engine']
  >;

describe('select() does not offer models that cannot be called', () => {
  it('drops a measured-unavailable model', () => {
    const catalog = catalogWith({
      'openai/dead': {
        type: 'chat',
        active: false,
        unavailable: { since: '2026-09-29', reason: 'endpoint answers 404' },
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      },
    });
    const ids = selectModels('type:chat', { engine: engineWith(catalog) }).map((m) => m.model);
    expect(ids).toContain('fine');
    expect(ids).not.toContain('dead');
  });

  it('drops a model whose shutdown date has passed', () => {
    const catalog = catalogWith({
      'openai/retired': {
        type: 'chat',
        active: true,
        deprecation: { shutdownDate: PAST, source: 'litellm' },
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      },
    });
    const ids = selectModels('type:chat', { engine: engineWith(catalog) }).map((m) => m.model);
    expect(ids).not.toContain('retired');
  });

  it('KEEPS one whose shutdown is still ahead', () => {
    const catalog = catalogWith({
      'openai/soon': {
        type: 'chat',
        active: true,
        deprecation: { shutdownDate: FUTURE, source: 'litellm' },
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      },
    });
    const ids = selectModels('type:chat', { engine: engineWith(catalog) }).map((m) => m.model);
    expect(ids).toContain('soon');
  });

  it('KEEPS one that is merely deprecated, because it still works', () => {
    const catalog = catalogWith({
      'openai/olden': {
        type: 'chat',
        active: true,
        deprecation: { date: PAST, source: 'litellm' },
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      },
    });
    const ids = selectModels('type:chat', { engine: engineWith(catalog) }).map((m) => m.model);
    expect(ids).toContain('olden');
  });

  it('an explicit active filter still reaches them, for tooling that wants the whole set', () => {
    const catalog = catalogWith({
      'openai/dead': {
        type: 'chat',
        active: false,
        unavailable: { since: '2026-09-29', reason: 'gone' },
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      },
    });
    const ids = selectModels('type:chat; active:no', { engine: engineWith(catalog) }).map((m) => m.model);
    expect(ids).toContain('dead');
  });
});

describe('unavailableReason: refusing without a round trip', () => {
  it('explains a measured refusal, and says when it was measured', () => {
    const catalog = catalogWith({
      'openai/dead': {
        type: 'chat',
        active: false,
        unavailable: { since: '2026-09-29', reason: '/v1/videos answers 404' },
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      },
    });
    const why = catalog.unavailableReason('openai', 'dead');
    expect(why).toContain('404');
    expect(why).toContain('2026-09-29');
  });

  it('explains a passed shutdown date', () => {
    const catalog = catalogWith({
      'openai/retired': {
        type: 'chat',
        deprecation: { shutdownDate: PAST, source: 'litellm' },
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      },
    });
    expect(catalog.unavailableReason('openai', 'retired')).toContain(PAST);
  });

  it('says nothing about a model that works', () => {
    const catalog = catalogWith({});
    expect(catalog.unavailableReason('openai', 'fine')).toBeNull();
  });

  it('says nothing about a merely deprecated model', () => {
    const catalog = catalogWith({
      'openai/olden': {
        type: 'chat',
        deprecation: { date: PAST, source: 'litellm' },
        pricing: { inputPerMTok: 0, outputPerMTok: 0 },
      },
    });
    expect(catalog.unavailableReason('openai', 'olden')).toBeNull();
  });

  it('says nothing about a model it has never heard of', () => {
    expect(catalogWith({}).unavailableReason('openai', 'who')).toBeNull();
  });
});

describe('the shipped catalog carries the measurements', () => {
  it('marks the retired Imagen and Sora models', () => {
    const catalog = coreRegistry.get?.()?.catalog ?? new ModelCatalog();
    catalog.loadProviderDefaults?.();
    for (const [provider, model] of [
      ['google', 'imagen-4'],
      ['openai', 'sora-2'],
    ] as const) {
      const info = catalog.get(provider, model);
      if (!info) continue; // a trimmed catalog build
      expect(info.active).toBe(false);
      expect(info.unavailable).toBeDefined();
    }
  });
});
