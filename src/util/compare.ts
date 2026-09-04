/** Ordering that does not depend on where the process is running.
 *
 *  `String.prototype.localeCompare` with no locale argument reads the HOST's
 *  default locale, so the same inputs sort differently on different machines:
 *  under `sv-SE` or `tr-TR`, `ünique` sorts after `user-name` rather than next
 *  to `unique`. That is fine for a list shown to a person and wrong for
 *  anything whose order becomes bytes — a rendered system prompt changes
 *  content with the host's locale, which breaks reproducibility and misses the
 *  provider's prompt cache on a prefix that should have been identical.
 *
 *  Codepoint order is not "nicer" than collation. It is the same everywhere,
 *  which is the only property these call sites actually need. */
export function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
