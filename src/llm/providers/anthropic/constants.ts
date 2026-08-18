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
 * The version at which `thinking: {type:'adaptive'}` takes over from
 * `{type:'enabled', budget_tokens}`.
 *
 * There is no shape that works everywhere, and the direction reversed under us. This
 * adapter used to send the budgeted form to every model, on the reasoning that it was the
 * universally accepted one — true when it was written. Anthropic then REMOVED
 * `budget_tokens` on 4.7 and later: Sonnet 5, Opus 5/4.8/4.7 and Fable 5 reject it with a
 * 400 ("thinking.type.enabled is not supported for this model"). Meanwhile the older half
 * — Haiku 4.5, Sonnet 4.5, Opus 4.x — has no `adaptive` at all and still requires the
 * budget. So the shape must be chosen per model.
 *
 * 4.6 is the boundary: it accepts both and prefers `adaptive`, everything above requires
 * `adaptive`, everything below requires the budget.
 */
export const ANTHROPIC_ADAPTIVE_THINKING_MIN = { major: 4, minor: 6 } as const;

/**
 * Pick the `thinking` shape for a model id.
 *
 * Parsed from the id rather than read from the catalog on purpose: the catalog is optional
 * (an engine can run with none), `buildRequest` has no access to it, and its per-model
 * `reasoning` block does not currently distinguish the two shapes anyway.
 *
 * An unrecognised id gets `adaptive`, because `budget_tokens` is the shape being retired —
 * an id we do not recognise is far likelier to be newer than us than older.
 */
export function anthropicThinkingShape(model: string): 'adaptive' | 'budgeted' {
  const id = model.toLowerCase().replace(/^anthropic\//, '');

  // Current ids put the family before the version: claude-sonnet-4-6, claude-opus-5,
  // claude-haiku-4-5-20251001 (the date suffix falls outside the match).
  const modern = /^claude-[a-z]+-(\d+)(?:[-.](\d+))?/.exec(id);
  if (modern) {
    const major = Number(modern[1]);
    const minor = modern[2] === undefined ? 0 : Number(modern[2]);
    const { major: minMajor, minor: minMinor } = ANTHROPIC_ADAPTIVE_THINKING_MIN;
    return major > minMajor || (major === minMajor && minor >= minMinor) ? 'adaptive' : 'budgeted';
  }

  // Legacy ids put the version first: claude-3-5-sonnet-latest. All of those predate
  // adaptive thinking, so they take the budget rather than the unknown-id default.
  if (/^claude-\d/.test(id)) return 'budgeted';

  return 'adaptive';
}

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
