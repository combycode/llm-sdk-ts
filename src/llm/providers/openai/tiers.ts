/** OpenAI service-tier mapping — provider-specific, kept here (shared by the
 *  responses + completions adapters), never leaked into the SDK core.
 *  Request param + response value share the enum: auto|default|flex|scale|priority. */

import type { ServiceTier } from '../../types/tiers';

/** unified → OpenAI request `service_tier`. */
const REQUEST: Record<string, string> = {
  auto: 'auto',
  standard: 'default',
  priority: 'priority',
  flex: 'flex',
  scale: 'scale',
};
const KNOWN = new Set(['auto', 'default', 'flex', 'scale', 'priority']);

/** Map a unified tier to OpenAI's `service_tier`. Unknown values pass through if
 *  OpenAI accepts them, otherwise fall back to `auto`. Undefined → omit. */
export function openaiRequestTier(t?: ServiceTier): string | undefined {
  if (!t) return undefined;
  const mapped = REQUEST[t] ?? t;
  return KNOWN.has(mapped) ? mapped : 'auto';
}

/** OpenAI billed `service_tier` (response) → {raw, normalized catalog key}.
 *  `default` is OpenAI's word for the standard tier. */
export function openaiBilledTier(raw: unknown): { serviceTier?: string; pricingTier?: string } {
  if (typeof raw !== 'string' || !raw) return {};
  return { serviceTier: raw, pricingTier: raw === 'default' ? 'standard' : raw };
}
