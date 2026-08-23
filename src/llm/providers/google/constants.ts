/** Google provider constants.
 *
 *  The thinking-control tables and the 2.5-vs-3.x band test have moved into data:
 *  the effort maps are `$table`s in the chain specs, and the band is
 *  `src/wire/pins/google.generate.json`. Only the Interactions map remains here,
 *  because its lowercase enum is read by code the specs do not own. */

/**
 * Effort → Interactions `thinking_level`. The Interactions API uses **lowercase**
 * values (`minimal`/`low`/`medium`/`high`) — distinct from generateContent's
 * uppercase `thinkingLevel`, and it 400s on the uppercase form (live 2026-07-16).
 */
export const GOOGLE_INTERACTION_THINKING_LEVELS: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high',
};
