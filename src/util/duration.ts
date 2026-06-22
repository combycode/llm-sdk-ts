/** Compact duration strings — a reusable pattern across the SDK (server-state
 *  retention, cache TTLs, timeouts, etc.).
 *
 *  Format: `<number><unit>` where unit is one of s/m/h/d/w. Examples:
 *    "30s", "5m", "72h", "3d", "2w"
 *
 *  parseDuration("72h") -> 259_200_000 (ms)
 */

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parse a duration string to milliseconds. Throws on malformed input. */
export function parseDuration(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i.exec(value.trim());
  if (!m) {
    throw new Error(`Invalid duration "${value}" — expected e.g. "30s", "72h", "3d", "2w".`);
  }
  return Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
}

/** Parse to milliseconds, or return null for null/undefined/empty (not for malformed). */
export function parseDurationOrNull(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  return parseDuration(value);
}
