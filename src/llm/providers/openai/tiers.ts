/** OpenAI service-tier mapping — provider-specific, kept here (shared by the
 *  responses + completions adapters), never leaked into the SDK core.
 *
 *  The accepted set is PER SURFACE, verified against the clone rather than the
 *  diff. `openai-ts` 7.23 carries three different vocabularies, and reading the
 *  diff's +/- lines alone suggests changes that did not happen (`scale` looks
 *  removed; it is not — it is simply absent from the Live union):
 *
 *    Responses, GA and beta   auto default flex scale priority fast ultrafast
 *    Chat Completions         auto default flex scale priority fast
 *    Live                     auto default flex priority fast_tier_temp_pilot ultrafast
 *
 *  Live is not a surface this map serves, so `fast_tier_temp_pilot` is
 *  deliberately absent: listing a value the adapter can never send would be a
 *  claim we do not honour. */

import type { ServiceTier } from '../../types/tiers';

/** unified → OpenAI request `service_tier`. */
const REQUEST: Record<string, string> = {
  auto: 'auto',
  standard: 'default',
  priority: 'priority',
  flex: 'flex',
  scale: 'scale',
  fast: 'fast',
  ultrafast: 'ultrafast',
};

const SHARED = ['auto', 'default', 'flex', 'scale', 'priority', 'fast'] as const;

/** What each surface accepts. `responses` covers the beta variant, whose
 *  `BetaServiceTier` is character-for-character the GA union. */
const ACCEPTED: Record<string, ReadonlySet<string>> = {
  responses: new Set([...SHARED, 'ultrafast']),
  'chat-completions': new Set(SHARED),
};

const DEFAULT_SURFACE = 'responses';

export interface TierDecision {
  /** What to put on the wire, or undefined to omit the field. */
  value: string | undefined;
  /** Set when the caller asked for a tier this surface will not take, and we
   *  sent a different one. Never set when the request is honoured. */
  note?: string;
}

/** Map a unified tier to OpenAI's `service_tier` for one surface.
 *
 *  A tier the surface does not accept falls back to `auto` — but NEVER silently.
 *  That fallback has now cost two releases: `fast` arrived in 2026-08 and was
 *  downgraded to the project default for a month, and `ultrafast` would have
 *  gone the same way. Both are billing and latency decisions taken on the
 *  caller's behalf, and the caller could not see either one happen. The note
 *  reaches them as an `onWarning` with code `request_adjusted`.
 *
 *  `ultrafast` is access-controlled and served only by `gpt-5.6-sol`; an account
 *  without access gets a 400 naming `service_tier`, which is the honest answer
 *  and strictly better than being quietly billed at another tier. */
export function openaiTierDecision(t?: ServiceTier, api: string = DEFAULT_SURFACE): TierDecision {
  if (!t) return { value: undefined };
  const accepted = ACCEPTED[api] ?? ACCEPTED[DEFAULT_SURFACE]!;
  const mapped = REQUEST[t] ?? t;
  if (accepted.has(mapped)) return { value: mapped };
  return {
    value: 'auto',
    note:
      `serviceTier "${t}" is not accepted on OpenAI ${api}; sent "auto" instead. ` +
      `Accepted here: ${[...accepted].join(', ')}.`,
  };
}

/** The wire value alone, for callers that do not surface notes. */
export function openaiRequestTier(t?: ServiceTier, api?: string): string | undefined {
  return openaiTierDecision(t, api).value;
}

/** OpenAI billed `service_tier` (response) → {raw, normalized catalog key}.
 *  `default` is OpenAI's word for the standard tier. */
export function openaiBilledTier(raw: unknown): { serviceTier?: string; pricingTier?: string } {
  if (typeof raw !== 'string' || !raw) return {};
  return { serviceTier: raw, pricingTier: raw === 'default' ? 'standard' : raw };
}
