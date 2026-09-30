/** Which xAI models take a reasoning effort — provider-specific, kept here next
 *  to `tiers.ts` for the same reason, and never leaked into the SDK core.
 *
 *  The wire used to delete `reasoning` for every xAI model whose id did not
 *  contain `multi-agent`, on the belief that only that model used the field. The
 *  catalog meanwhile advertised `effortControl: true` with `effortValues`
 *  including `xhigh` for grok-4.5 and 4.6 — so the catalog promised a control the
 *  request never carried, and a caller asking for `xhigh` silently got whatever
 *  the model does by default.
 *
 *  MEASURED 2026-09-30 against `/v1/responses`, reasoning-token counts on a hard
 *  prompt (a trivial prompt cannot separate the efforts, which is how "accepted
 *  and inert" hides — the same trap `topK` fell into):
 *
 *    grok-4.6                   200   low 449 -> xhigh 3066   x6.8, ranges disjoint
 *    grok-4.5                   200   low  95 -> xhigh 3475   x36.6, ranges disjoint
 *    grok-4.3                   200   low 1307 -> xhigh 9729  x7.4, ranges disjoint
 *    grok-4.20                  400   "does not support parameter reasoningEffort"
 *    grok-4.20-non-reasoning    400   same
 *    grok-4.20-0309-reasoning   400   same
 *    grok-4.20-multi-agent      200   low 882 -> xhigh 4611   scales, but see below
 *
 *  Two things that rule this out being a version comparison, which is what a
 *  regex over the number would amount to:
 *
 *  1. `grok-4.20` REFUSES the field outright while the numerically LOWER 4.3, 4.5
 *     and 4.6 honour it. 4.20 is a separate line, not a later 4.2 — exactly the
 *     trap `wire/pins.ts` records for version arithmetic, and a 400 is not a
 *     failure mode worth risking on a guess.
 *  2. On `grok-4.20-multi-agent` the field is accepted but means something else:
 *     an agent COUNT rather than a thinking budget. Sending a caller's `xhigh`
 *     there would buy them a different thing than they asked for, so it is
 *     deliberately treated as not taking an effort.
 *
 *  So this is an explicit ordered table, first match wins, with the measurement
 *  beside each rule. A model released after this build falls to `false` — the
 *  conservative direction: an unsent field costs a caller the control they asked
 *  for, while a rejected one costs them the whole request.
 */

/** Ordered rules, first match wins. `takes` is what the match implies. */
interface Rule {
  match: RegExp;
  takes: boolean;
  why: string;
}

const RULES: Rule[] = [
  {
    // The whole 4.20 line refuses the parameter by name, under every spelling
    // its listing shows. Checked BEFORE the general grok-4 rule below, because
    // the id would otherwise match it.
    match: /^grok-4\.20\b/,
    takes: false,
    why: '400 "does not support parameter reasoningEffort" (measured 2026-09-30, all three spellings)',
  },
  {
    // 4.3 and up honour it. The catalog said `effortControl: false` for 4.3 and
    // for 4.7 while saying true for 4.5/4.6 — an ordering that was wrong on its
    // face and wrong in measurement.
    match: /^grok-4\.(?:[3-9]|\d\d?\.)/,
    takes: true,
    why: 'measured honoured on 4.3 (x7.4), 4.5 (x36.6), 4.6 (x6.8); 4.7 accepts it',
  },
];

/** Does this xAI model accept `reasoning.effort` AS a thinking budget?
 *
 *  The id may arrive with or without the `xai/` prefix, and a caller may pass
 *  either — a capability must not depend on which. */
export function xaiTakesReasoningEffort(model: string): boolean {
  const id = String(model).toLowerCase().replace(/^xai\//, '');
  for (const rule of RULES) {
    if (rule.match.test(id)) return rule.takes;
  }
  return false;
}

/** The multi-agent grok reads `reasoning.effort` as an agent COUNT, so it is the
 *  one model that wants the field for a reason of its own. Kept separate from
 *  `xaiTakesReasoningEffort` precisely because the two are different questions
 *  that happen to touch the same wire field. */
export function xaiUsesEffortAsAgentCount(model: string): boolean {
  return String(model).toLowerCase().includes('multi-agent');
}
