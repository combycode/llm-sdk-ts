/** Anthropic provider constants. */

/** The Anthropic API version header sent on every request. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Token budgets for Anthropic extended thinking by effort level.
 * Used to set budget_tokens in the `thinking` request param.
 */
export const ANTHROPIC_THINKING_BUDGETS: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
  max: 16384,
};

/**
 * Budget applied when no effort level is specified or when the level is
 * unrecognised.
 */
export const DEFAULT_ANTHROPIC_THINKING_BUDGET = 2048;

/**
 * Models that still accept `top_k`.
 *
 * Anthropic DEPRECATED `top_k`: the SDK marks it
 * "Models released after Claude Opus 4.6 do not accept top_k; any value will be rejected
 * with a 400 error", and the wire agrees. Live-verified across the whole catalog on
 * 2026-07-29:
 *   ACCEPT  opus-4.1, opus-4.5, opus-4.6, sonnet-4.5, sonnet-4.6, haiku-4.5
 *   REJECT  opus-4.7, opus-4.8, sonnet-5, opus-5, fable-5  ->  400 "`top_k` is deprecated
 *           for this model"
 *
 * This is an ALLOW-list on purpose, so it FAILS SAFE: any model we do not recognise — every
 * future release included — simply does not get `top_k`. Omitting it is a no-op; sending it
 * to a newer model is a hard request failure, so the asymmetry decides the default.
 */
const ANTHROPIC_TOP_K_MODELS =
  /^claude-(opus-4-(1|5|6)|sonnet-4-(5|6)|haiku-4-5)(\b|-)/;

/** True when this Anthropic model still accepts `top_k` (see ANTHROPIC_TOP_K_MODELS). */
export function anthropicAcceptsTopK(model: string): boolean {
  return ANTHROPIC_TOP_K_MODELS.test(model);
}
