/** select() — pick a model by capabilities/features via a tiny tag DSL, returning
 *  a `provider/slug` string you can feed straight to complete({ model }).
 *
 *  Query: a `;`-separated string OR an array of clauses. Clause grammar:
 *    key:value      exact          e.g. type:chat, search:yes, status:stable
 *    key            → key:yes      e.g. search, vision, reasoning
 *    key > N        key ≥ N        e.g. context > 200k   (inclusive)
 *    key < N        key ≤ N        e.g. price < 1        (inclusive)
 *    N parses k/M suffixes (200k → 200000). Custom tags expand first.
 *
 *  Availability-aware: only considers providers with a configured API key.
 *  Ranks cheapest-first (tiebreak: newest version); select() returns the single
 *  best, selectModels() the ranked list. Thresholds + custom tags are overridable. */

import type { ModelInfo } from '../catalog/catalog';
import type { ProviderName } from '../llm/types/provider';
import { coreRegistry, type EngineHandle } from './engine';

export interface SelectPrefs {
  /** Named cutoffs (overridable). */
  thresholds?: Partial<typeof DEFAULT_THRESHOLDS>;
  /** Custom tag → DSL expansion, e.g. `{ cheap: 'price < 1', coding: 'type:code; tools' }`. */
  tags?: Record<string, string>;
}
export interface SelectOptions {
  engine?: EngineHandle;
  /** Restrict to one provider. */
  provider?: ProviderName;
  /** Price tier to evaluate `price` against (default: standard/flat). */
  tier?: string;
  prefs?: SelectPrefs;
}

const DEFAULT_THRESHOLDS = {
  'price.low': 1,
  'price.mid': 5,
  'context.small': 32_000,
  'context.large': 200_000,
};
const DEFAULT_TAGS: Record<string, string> = {
  cheap: 'price:low',
  free: 'price:free',
  tiny: 'context:small',
  huge: 'context:large',
};

const CAP_KEYS: Record<string, string> = {
  vision: 'vision',
  tools: 'toolUse',
  audio: 'audio',
  structured: 'structuredOutput',
};
/** Query tokens that check `capabilities.builtinTools` membership (hosted server
 *  tools). `search` is kept as an alias for `web_search`. */
const BUILTIN_TOOL_KEYS: Record<string, string> = {
  search: 'web_search',
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  code_interpreter: 'code_interpreter',
};
const KNOWN_KEYS = new Set([
  'price', 'context', 'reasoning', 'type', 'tier', 'status', 'provider', 'active',
  ...Object.keys(CAP_KEYS),
  ...Object.keys(BUILTIN_TOOL_KEYS),
]);

/** One filter a UI can offer, and what it accepts. */
export interface FilterFacet {
  /** The DSL key, e.g. `price`. Write it as `key:value`. */
  key: string;
  /** Group heading for a picker. */
  category: 'what it is' | 'cost' | 'thinking' | 'inputs' | 'hosted tools' | 'availability';
  /** Short human label. */
  label: string;
  /** The values this key accepts. Empty when the key is a bare flag (`vision`),
   *  which the parser reads as `key:yes`. */
  values: string[];
  /** True when the key also accepts `> N` / `< N`, so a picker can offer a number. */
  numeric: boolean;
  /** True when a bare `key` (no value) is meaningful — the parser expands it to
   *  `key:yes`. */
  bare: boolean;
}

/** Every clause the query parser understands, as data.
 *
 *  Exported because the alternative is a UI hand-listing the same tags: a second
 *  copy of this vocabulary, drifting from the parser the first time either moves,
 *  and drifting invisibly because a wrong tag reads as "no models matched" rather
 *  than as an error. Here the picker and the parser cannot disagree — both come
 *  from `KNOWN_KEYS`, `CAP_KEYS` and `BUILTIN_TOOL_KEYS` above.
 *
 *  `type`, `provider`, `status` and `tier` take their values from the CATALOG
 *  when one is passed, because those are open sets: a provider ships a new model
 *  type and a hard-coded list is wrong that day. Without a catalog they come back
 *  empty rather than guessed — an empty list is honest, a stale list is not. */
export function filterFacets(catalog?: { list(): ModelInfo[] }): FilterFacet[] {
  const models = catalog?.list() ?? [];
  const distinct = (pick: (m: ModelInfo) => string | undefined): string[] =>
    [...new Set(models.map(pick).filter((v): v is string => !!v))].sort();

  const facets: FilterFacet[] = [
    { key: 'type', category: 'what it is', label: 'Type', values: distinct((m) => m.type), numeric: false, bare: false },
    { key: 'provider', category: 'what it is', label: 'Provider', values: distinct((m) => m.provider), numeric: false, bare: false },
    // The named cutoffs the parser compares against, plus `free` for exactly zero.
    { key: 'price', category: 'cost', label: 'Price', values: ['free', 'low', 'mid', 'high'], numeric: true, bare: false },
    // filled below from the models themselves — tiers are per model, not a fixed set
    { key: 'tier', category: 'cost', label: 'Billing tier', values: [], numeric: false, bare: false },
    { key: 'context', category: 'inputs', label: 'Context window', values: ['small', 'large'], numeric: true, bare: false },
    { key: 'reasoning', category: 'thinking', label: 'Reasoning', values: ['yes', 'no'], numeric: false, bare: true },
    { key: 'status', category: 'availability', label: 'Status', values: distinct((m) => m.status), numeric: false, bare: false },
    { key: 'active', category: 'availability', label: 'Offered now', values: ['yes', 'no'], numeric: false, bare: true },
  ];

  for (const key of Object.keys(CAP_KEYS)) {
    facets.push({ key, category: 'inputs', label: key, values: ['yes', 'no'], numeric: false, bare: true });
  }
  for (const key of Object.keys(BUILTIN_TOOL_KEYS)) {
    facets.push({ key, category: 'hosted tools', label: key.replace(/_/g, ' '), values: ['yes', 'no'], numeric: false, bare: true });
  }

  // Billing tiers are per model, so they are collected rather than declared.
  const tiers = [...new Set(models.flatMap((m) => Object.keys(m.pricing?.tiers ?? {})))].sort();
  const tierFacet = facets.find((f) => f.key === 'tier');
  if (tierFacet) tierFacet.values = tiers;

  return facets;
}

/** The shorthand tags the parser expands before matching (`cheap` → `price:low`).
 *  A picker can show these as one-click presets. */
export function filterAliases(): Record<string, string> {
  return { ...DEFAULT_TAGS };
}

function parseNum(v: string): number {
  const m = /^([\d.]+)\s*([kKmM]?)$/.exec(v.trim());
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  return m[2] ? n * (m[2].toLowerCase() === 'm' ? 1e6 : 1e3) : n;
}
const isNo = (v: string) => /^(no|off|false|0)$/i.test(v);

interface Crit { key: string; op: ':' | '>' | '<'; value: string }

function parseQuery(query: string | string[], tags: Record<string, string>): Crit[] {
  const raw = (Array.isArray(query) ? query : query.split(';')).map((s) => s.trim()).filter(Boolean);
  const out: Crit[] = [];
  for (const clause of raw) {
    // custom-tag expansion (a bare token that names a tag)
    const bare = clause.toLowerCase();
    if (tags[bare]) {
      out.push(...parseQuery(tags[bare], tags));
      continue;
    }
    const m = /^([a-z][\w.]*)\s*(>=|<=|>|<|:)?\s*(.*)$/i.exec(clause);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const opRaw = m[2];
    const op = opRaw === '>' || opRaw === '>=' ? '>' : opRaw === '<' || opRaw === '<=' ? '<' : ':';
    const value = m[3].trim() || 'yes';
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`select: unknown filter "${key}". Known: ${[...KNOWN_KEYS].sort().join(', ')}`);
    }
    out.push({ key, op, value });
  }
  return out;
}

const priceOf = (m: ModelInfo, tier?: string): number | undefined =>
  (tier && tier !== 'standard' ? m.pricing.tiers?.[tier]?.inputPerMTok : undefined) ?? m.pricing.inputPerMTok;

function matches(m: ModelInfo, c: Crit, th: typeof DEFAULT_THRESHOLDS, tier?: string): boolean {
  switch (c.key) {
    case 'price': {
      const p = priceOf(m, tier);
      if (p == null) return false;
      if (c.op === '<') return p <= parseNum(c.value);
      if (c.op === '>') return p >= parseNum(c.value);
      if (c.value === 'free') return p === 0;
      if (c.value === 'low') return p <= th['price.low'];
      if (c.value === 'mid') return p <= th['price.mid'];
      if (c.value === 'high') return p > th['price.mid'];
      return false;
    }
    case 'context': {
      const ctx = m.contextWindow;
      if (ctx == null) return false;
      if (c.op === '<') return ctx <= parseNum(c.value);
      if (c.op === '>') return ctx >= parseNum(c.value);
      if (c.value === 'small') return ctx <= th['context.small'];
      if (c.value === 'large') return ctx >= th['context.large'];
      return ctx >= parseNum(c.value);
    }
    case 'reasoning': {
      const sup = !!m.reasoning?.supported;
      return isNo(c.value) ? !sup : sup;
    }
    case 'type':
      return m.type === c.value;
    case 'tier':
      return !!m.pricing.tiers?.[c.value];
    case 'status':
      return m.status === c.value;
    case 'provider':
      return m.provider === c.value;
    case 'active':
      return isNo(c.value) ? m.active === false : m.active !== false;
    default: {
      const tool = BUILTIN_TOOL_KEYS[c.key];
      if (tool) {
        // builtinTools membership, with legacy `webSearch` boolean as a fallback.
        const inList = m.capabilities.builtinTools?.includes(tool) ?? false;
        const legacy =
          tool === 'web_search' &&
          !!(m.capabilities as unknown as Record<string, unknown>).webSearch;
        const has = inList || legacy;
        return isNo(c.value) ? !has : has;
      }
      const cap = CAP_KEYS[c.key];
      const has = !!(m.capabilities as unknown as Record<string, unknown>)[cap];
      return isNo(c.value) ? !has : has;
    }
  }
}

function versionVec(v?: string): number[] {
  return (v?.match(/\d+/g) ?? []).map(Number);
}
function cmpVer(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** All matching models, ranked cheapest-first (tiebreak: newest version). */
/** Has this model's announced SHUTDOWN date passed?
 *
 *  Deliberately `shutdownDate` and not `deprecation.date`: the two mean
 *  different things here. A `date` says a source announced end-of-life, and the
 *  model stays callable until the shutdown; hiding it would take away a model
 *  that still works. A `shutdownDate` in the past says it does not.
 *
 *  Checked at QUERY time rather than baked into `active`, because a catalog
 *  exported yesterday cannot know that a date passed overnight. Recommending a
 *  model that has stopped is worse than returning one fewer candidate: the
 *  caller is better off switching model than discovering it in production, and
 *  a fallback chain is the place to absorb the difference.
 *
 *  `active: false` covers the other case — somebody CALLED the endpoint and it
 *  was gone, which no date predicts. */
function isPastShutdown(m: ModelInfo, now = new Date()): boolean {
  const shutdown = m.deprecation?.shutdownDate;
  if (!shutdown) return false;
  return shutdown < now.toISOString().slice(0, 10);
}

export function selectModels(query: string | string[], opts: SelectOptions = {}): ModelInfo[] {
  const engine = opts.engine ?? coreRegistry.get();
  const th = { ...DEFAULT_THRESHOLDS, ...opts.prefs?.thresholds };
  const tags = { ...DEFAULT_TAGS, ...opts.prefs?.tags };
  const crits = parseQuery(query, tags);
  const hasActiveFilter = crits.some((c) => c.key === 'active');

  const available = new Set(
    Object.entries(engine.apiKeys ?? {}).filter(([, k]) => !!k).map(([p]) => p),
  );
  const candidates = engine.catalog.list(opts.provider).filter((m) => {
    if (opts.provider && m.provider !== opts.provider) return false;
    if (available.size && !available.has(m.provider)) return false; // availability-aware
    if (!hasActiveFilter && m.active === false) return false; // default: callable only
    if (!hasActiveFilter && isPastShutdown(m)) return false;
    return crits.every((c) => matches(m, c, th, opts.tier));
  });

  return candidates.sort((a, b) => {
    const pa = priceOf(a, opts.tier) ?? Number.POSITIVE_INFINITY;
    const pb = priceOf(b, opts.tier) ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb; // cheapest first
    return cmpVer(versionVec(b.version), versionVec(a.version)); // then newest
  });
}

/** The single best match as a `provider/slug` string (feedable to complete), or null. */
export function select(query: string | string[], opts: SelectOptions = {}): string | null {
  const best = selectModels(query, opts)[0];
  return best ? `${best.provider}/${best.model}` : null;
}
