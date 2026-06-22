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
