/** Unified service tier for a request. The four named values are the
 *  cross-provider core; the open `(string & {})` lets callers pass any tier
 *  (e.g. `'scale'`, or a future internal-optimization label) — each adapter
 *  decides whether it can honor it (pass through if the provider allows it,
 *  else fall back to that provider's `auto`).
 *
 *  `batch` is intentionally NOT a value here — it's a separate API (the Batch
 *  endpoint), not a per-request flag on a synchronous call.
 *
 *  Tier mapping is provider-specific and lives ENTIRELY in the adapters. */
export type ServiceTier = 'auto' | 'standard' | 'priority' | 'flex' | (string & {});
