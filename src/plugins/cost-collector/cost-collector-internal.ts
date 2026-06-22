/** CostCollector internals — pure cost-math + filtering helpers, split out of
 *  the class so each is independently testable. */

import type { CostEntry } from '../../bus/hook-map';
import type { ModelCatalog, ModelPricing } from '../model-catalog/catalog';
import type { CostFilter, CostSummary } from './cost-collector-types';

/** Pull provider-reported cost evidence out of a raw response body. */
export function extractProviderCost(provider: string, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const usage = (r.usage as Record<string, unknown>) ?? {};

  if (provider === 'openrouter') {
    return {
      cost: usage.cost,
      cost_details: usage.cost_details,
      is_byok: usage.is_byok,
    };
  }
  if (provider === 'xai') {
    const ticks = usage.cost_in_usd_ticks as number | undefined;
    return { cost_in_usd_ticks: ticks, cost_usd: ticks != null ? ticks / 1e10 : null };
  }
  return {};
}

/** The provider's own total cost (USD), when it reports one. */
export function getProviderTotal(provider: string, evidence: Record<string, unknown>): number | null {
  if (provider === 'openrouter' && typeof evidence.cost === 'number') return evidence.cost;
  if (provider === 'xai' && typeof evidence.cost_usd === 'number') return evidence.cost_usd;
  return null;
}

/** Compute a CostEntry cost: provider total when reported, else catalog pricing
 *  at the billed service tier (tier rates overlay the flat standard rates). */
export function calculateCost(
  catalog: ModelCatalog,
  provider: string,
  model: string,
  tokens: CostEntry['tokens'],
  providerEvidence: Record<string, unknown>,
  tier?: string,
): CostEntry['cost'] {
  const providerTotal = getProviderTotal(provider, providerEvidence);
  if (providerTotal !== null) {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: providerTotal,
      source: 'provider',
    };
  }

  const base = catalog.getPricing(provider, model);
  // Service-tier rates override the flat (standard) rates field-by-field; any
  // field a tier doesn't change falls back to standard. No tier / unknown tier
  // → flat behavior (identical to before).
  const tierRates = tier && tier !== 'standard' ? base?.tiers?.[tier] : undefined;
  const pricing = base ? { ...base, ...tierRates } : base;
  if (pricing) {
    const inputRate = pricing.inputPerMTok ?? 0;
    const outputRate = pricing.outputPerMTok ?? 0;
    const cacheReadRate = pricing.cacheReadPerMTok ?? inputRate * 0.1;
    const cacheWriteRate = pricing.cacheWritePerMTok ?? inputRate * 1.25;

    // Audio tokens (realtime / audio models) price at their own rate; fall back
    // to the text rate when no audio rate is set.
    const audioInRate = pricing.audioInputPerMTok ?? inputRate;
    const audioOutRate = pricing.audioOutputPerMTok ?? outputRate;

    const input =
      (tokens.input / 1_000_000) * inputRate +
      ((tokens.audioInput ?? 0) / 1_000_000) * audioInRate;
    const output =
      (tokens.output / 1_000_000) * outputRate +
      ((tokens.audioOutput ?? 0) / 1_000_000) * audioOutRate;
    const cacheRead = (tokens.cached / 1_000_000) * cacheReadRate;
    const cacheWrite = (tokens.cacheWrite / 1_000_000) * cacheWriteRate;
    const reasoning = (tokens.reasoning / 1_000_000) * outputRate;

    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning,
      total: input + output + cacheRead + cacheWrite + reasoning,
      source: 'calculated',
    };
  }

  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    source: 'unknown',
  };
}

const SECONDS_PER_MINUTE = 60;

/** Media units for unit-priced generation (image count / video seconds / TTS
 *  chars), plus the resolution that selects a `perUnit` rate. */
export interface MediaCostUnits {
  type: 'image' | 'audio' | 'video';
  count?: number;
  durationSeconds?: number;
  textChars?: number;
  resolution?: string;
}

/** Everything `computeCost` needs to price one generation (chat OR media). */
export interface CostComputeInput {
  provider: string;
  model: string;
  /** Token usage — chat, and token-priced media (gpt-image, gemini-tts). */
  tokens?: CostEntry['tokens'];
  /** Unit-priced media facts. */
  media?: MediaCostUnits;
  providerEvidence?: Record<string, unknown>;
  tier?: string;
}

const zeroCost = (
  total: number,
  source: CostEntry['cost']['source'],
): CostEntry['cost'] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total,
  source,
});

/** Compute cost for a speech-to-text transcription billed by audio duration
 *  (whisper, gpt-4o-transcribe).  Returns a zero-cost entry with `source:
 *  'unknown'` when the catalog has no `perMinute` rate for this model, so the
 *  cost pipeline can attach a note instead of emitting nothing.
 *
 *  `durationSeconds` is the audio duration measured or derived by the caller
 *  (WAV header parse, or a caller-supplied hint). */
export function calculateTranscriptionCost(
  catalog: ModelCatalog,
  provider: string,
  model: string,
  durationSeconds: number | undefined,
): { cost: CostEntry['cost']; note?: string } {
  const pricing = catalog.getPricing(provider, model);
  if (!pricing) {
    return {
      cost: zeroCost(0, 'unknown'),
      note: `unpriced: no catalog entry for ${provider}/${model}`,
    };
  }
  if (pricing.perMinute == null) {
    return {
      cost: zeroCost(0, 'unknown'),
      note: `unpriced: no catalog perMinute rate for ${provider}/${model}`,
    };
  }
  if (durationSeconds == null || durationSeconds <= 0) {
    return {
      cost: zeroCost(0, 'unknown'),
      note: 'unpriced: audio duration unknown; pass audioDurationSeconds to transcribe()',
    };
  }
  const minutes = durationSeconds / SECONDS_PER_MINUTE;
  return { cost: zeroCost(minutes * pricing.perMinute, 'calculated') };
}

/** Unit cost for media that bills per image / per second / per Mchars, honoring
 *  a `perUnit[resolution]` override. Returns null when no applicable rate. */
function mediaUnitCost(pricing: ModelPricing, media: MediaCostUnits): number | null {
  const { type, count = 1, durationSeconds, textChars, resolution } = media;
  const perUnit = resolution ? pricing.perUnit?.[resolution] : undefined;

  if (type === 'image') {
    const rate = perUnit ?? pricing.perImage;
    return rate != null ? rate * count : null;
  }
  if (type === 'video') {
    const rate = perUnit ?? pricing.perSecond;
    const seconds = durationSeconds ?? count;
    return rate != null ? rate * seconds : null;
  }
  // audio / TTS — char-billed.
  if (pricing.perMChars != null && textChars != null) {
    return (textChars / 1_000_000) * pricing.perMChars;
  }
  return null;
}

/** The single cost engine for the whole SDK. Priority ladder:
 *    1. provider-reported total (when the response carries one)
 *    2. token cost — usage × per-MTok rates (chat, gpt-image, gemini-tts)
 *    3. media unit cost — perUnit[resolution] → perImage/perSecond/perMChars
 *    4. unknown (0)
 *  Token pricing wins over unit pricing only when the model actually has
 *  per-token rates, so unit-priced media with incidental usage still prices by
 *  unit. */
export function computeCost(catalog: ModelCatalog, input: CostComputeInput): CostEntry['cost'] {
  const { provider, model, tokens, media, providerEvidence = {}, tier } = input;

  // 1. Provider-reported total wins outright.
  const providerTotal = getProviderTotal(provider, providerEvidence);
  if (providerTotal !== null) return zeroCost(providerTotal, 'provider');

  const base =
    catalog.getPricing(provider, model) ??
    (media ? catalog.getPricing(provider, media.type) : null);

  // 2. Token cost — only when the model has per-token rates.
  const hasTokenRates = !!base && (base.inputPerMTok != null || base.outputPerMTok != null);
  if (tokens && hasTokenRates) {
    return calculateCost(catalog, provider, model, tokens, {}, tier);
  }

  // 3. Media unit cost.
  if (media && base) {
    const total = mediaUnitCost(base, media);
    if (total !== null) return zeroCost(total, 'calculated');
  }

  return zeroCost(0, 'unknown');
}

/** Does an entry fall within a budget scope (all defined scope keys match)? */
export function matchesScope(entry: CostEntry, scope: Record<string, string | undefined>): boolean {
  for (const [key, value] of Object.entries(scope)) {
    if (value === undefined) continue;
    if (entry.tags[key] !== value) return false;
  }
  return true;
}

/** Predicate for CostFilter (provider/model/time/run/conversation/session). */
export function applyFilter(e: CostEntry, filter: CostFilter): boolean {
  if (filter.provider && e.provider !== filter.provider) return false;
  if (filter.model && e.model !== filter.model) return false;
  if (filter.after && e.timestamp < filter.after) return false;
  if (filter.before && e.timestamp > filter.before) return false;
  if (filter.runId && e.tags.runId !== filter.runId) return false;
  if (filter.conversationId && e.tags.conversationId !== filter.conversationId) return false;
  if (filter.sessionId && e.tags.sessionId !== filter.sessionId) return false;
  return true;
}

/** Sum a set of entries into a CostSummary. */
export function summarize(entries: CostEntry[]): CostSummary {
  const s: CostSummary = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
    entries: entries.length,
  };
  for (const e of entries) {
    s.input += e.cost.input;
    s.output += e.cost.output;
    s.cacheRead += e.cost.cacheRead;
    s.cacheWrite += e.cost.cacheWrite;
    s.reasoning += e.cost.reasoning;
    s.total += e.cost.total;
    s.tokens.input += e.tokens.input;
    s.tokens.output += e.tokens.output;
    s.tokens.cached += e.tokens.cached;
    s.tokens.cacheWrite += e.tokens.cacheWrite;
    s.tokens.reasoning += e.tokens.reasoning;
  }
  return s;
}
