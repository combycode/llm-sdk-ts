/** xAI service-tier mapping — provider-specific, kept out of the SDK core.
 *
 *  xAI's `ServiceTier` enum accepts only `SERVICE_TIER_DEFAULT` / `SERVICE_TIER_PRIORITY`
 *  (verified against the xai-sdk proto). The OpenAI-inherited map emits `auto` / `flex` /
 *  `scale`, which xAI rejects — so the xAI adapter remaps here instead of inheriting.
 *  `standard` → xAI's `default`; anything xAI can't honor is omitted (the server then
 *  uses its own default tier). The billed response value (`default` / `priority`) parses
 *  correctly through the shared `openaiBilledTier` (`default` → `standard`), so only the
 *  request direction needs an xAI-specific map. */

import type { ServiceTier } from '../../types/tiers';

/** unified → xAI request `service_tier` (`default` | `priority`), or `undefined` to omit. */
export function xaiRequestTier(t?: ServiceTier): 'default' | 'priority' | undefined {
  if (!t) return undefined;
  if (t === 'priority') return 'priority';
  if (t === 'standard' || t === 'default') return 'default';
  // auto / flex / scale / unknown → omit: xAI has no equivalent and 400s on them.
  return undefined;
}
