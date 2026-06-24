/** Google service-tier mapping — provider-specific (shared by the generate adapter),
 *  never leaked into the SDK core. Google accepts flex|standard|priority on the request
 *  (top-level `serviceTier`) and reports the billed tier on `usageMetadata.serviceTier`. */

import type { ServiceTier } from '../../types/tiers';

/** Google's accepted request tiers (no 'auto'/'scale'). */
const REQUEST = new Set(['flex', 'standard', 'priority']);

/** unified ServiceTier → Google request `serviceTier`. Unsupported values
 *  ('auto', 'scale', or anything Google doesn't take) are omitted so Google
 *  applies its default (standard). */
export function googleRequestTier(t?: ServiceTier): string | undefined {
  if (!t) return undefined;
  return REQUEST.has(t) ? t : undefined;
}

/** Google billed tier (response `usageMetadata.serviceTier`, e.g. 'FLEX') →
 *  {raw, normalized catalog key}. pricingTier is lower-cased to key `pricing.tiers`;
 *  serviceTier preserves the provider's raw value. */
export function googleBilledTier(raw: unknown): { serviceTier?: string; pricingTier?: string } {
  if (typeof raw !== 'string' || !raw) return {};
  return { serviceTier: raw, pricingTier: raw.toLowerCase() };
}
