/** Google provider constants. */

/**
 * Map from unified thinking effort levels to Gemini `thinkingLevel` enum strings.
 * `thinkingLevel` is the Gemini 3.x thinking control (LOW/HIGH).
 */
export const GOOGLE_THINKING_LEVELS: Record<string, string> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  max: 'HIGH',
};

/**
 * Map from unified thinking effort to a Gemini `thinkingBudget` (token count).
 * Gemini **2.5** models only accept a token budget — they 400 on `thinkingLevel`
 * ("Thinking level is not supported for this model", live-verified 2026-07-16).
 * Values sit inside the 2.5 range (flash/flash-lite cap ~24576, pro ~32768).
 */
export const GOOGLE_THINKING_BUDGETS: Record<string, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  max: 24576,
};

/** Gemini 2.5 series uses `thinkingBudget`; 3.x+ uses `thinkingLevel`. */
export function googleUsesThinkingBudget(model: string): boolean {
  return /gemini-2\.5/.test(model);
}

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
