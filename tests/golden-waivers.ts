/** Fields the specs report that the FROZEN `response-golden.json` predates.
 *
 *  Waived, never re-recorded. Re-recording would silence that corpus's whole
 *  purpose: it would absorb any OTHER drift sitting in the same cells along with
 *  the change being made. So each entry names one key, the output is compared with
 *  that key removed, and the key must actually be PRESENT — a waiver that stops
 *  applying fails rather than quietly protecting nothing.
 *
 *  Shared by every test that reads the corpus (`response-differential`,
 *  `response-spec-differential`) so one deliberate change is recorded once, in one
 *  place, rather than drifting between copies of the same list. The Python twin
 *  keeps the same list in `tests/golden_waivers.py`.
 *
 *  `container` (2026-10-02): Anthropic reports the code-execution container a turn
 *  ran in, and we dropped it. These two cells were recorded on 2026-08-31 already
 *  carrying `container: {id, expires_at}`, so the corpus is the evidence that real
 *  containers had been going in the bin for over a month. Buffered: a new
 *  `response.container`. Streamed: it rides the terminal frame, so it lands on the
 *  `done` event.
 */

/** cell id -> the one key waived, and where it lands. */
export const INTENTIONAL: Record<string, { key: string; on?: 'done' }> = {
  'anthropic/messages::builtin.codeexec': { key: 'container' },
  'anthropic/messages::stream.builtin.codeexec': { key: 'container', on: 'done' },
};

/** `built` with one waived key removed. Throws when the key is not there, because
 *  a waiver for a field that stopped being emitted would otherwise keep passing
 *  while protecting nothing. */
export function withoutWaived(id: string, built: unknown): unknown {
  const waiver = INTENTIONAL[id];
  if (!waiver) return built;

  if (waiver.on === 'done') {
    const events = built as Record<string, unknown>[];
    const done = events.filter((e) => e.type === 'done');
    if (done.length === 0) {
      throw new Error(`${id}: waiver expects a \`done\` event; none was emitted`);
    }
    if (!done.some((e) => waiver.key in e)) {
      throw new Error(
        `${id}: waived key '${waiver.key}' is no longer on any \`done\` event — ` +
          'remove the waiver or fix the regression',
      );
    }
    return events.map((e) => {
      if (e.type !== 'done') return e;
      const { [waiver.key]: _dropped, ...rest } = e;
      return rest;
    });
  }

  const obj = built as Record<string, unknown>;
  if (!(waiver.key in obj)) {
    throw new Error(
      `${id}: waived key '${waiver.key}' is no longer reported — ` +
        'remove the waiver or fix the regression',
    );
  }
  const { [waiver.key]: _dropped, ...rest } = obj;
  return rest;
}
