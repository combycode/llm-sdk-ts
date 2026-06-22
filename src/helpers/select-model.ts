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

import type { ModelInfo } from '../plugins/model-catalog/catalog';
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
  search: 'webSearch',
  vision: 'vision',
  tools: 'toolUse',
  audio: 'audio',
  structured: 'structuredOutput',
};
const KNOWN_KEYS = new Set([
  'price', 'context', 'reasoning', 'type', 'tier', 'status', 'provider', 'active',
  ...Object.keys(CAP_KEYS),
]);

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
