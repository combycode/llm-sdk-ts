/** Unified service tier for a request. The named values are the cross-provider core; the open
 *  `(string & {})` lets callers pass any tier (e.g. `'scale'`, or a future internal-optimization
 *  label) — each adapter decides whether it can honor it (pass through if the provider allows it,
 *  else fall back to that provider's `auto`). Open by design, per CONSTITUTION.md R1: a provider
 *  adding a tier must never break a consumer, so listing a value here only adds autocomplete.
 *
 *  `batch` is intentionally NOT a value here — it's a separate API (the Batch
 *  endpoint), not a per-request flag on a synchronous call.
 *
 *  Tier mapping is provider-specific and lives ENTIRELY in the adapters. */
export type ServiceTier =
  | 'auto'
  | 'standard'
  | 'priority'
  | 'flex'
  | 'fast'
  /** OpenAI Responses only, and access-controlled: an account without it gets a
   *  400 naming `service_tier`. Not accepted on chat-completions, where the
   *  adapter reports the downgrade rather than performing it quietly. */
  | 'ultrafast'
  | (string & {});
