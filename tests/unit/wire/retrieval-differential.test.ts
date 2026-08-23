/** The hosted retrieval backends still send exactly what they sent before.
 *
 *  The fixture was frozen from the pre-migration commit
 *  (`tests/fixtures/retrieval-golden.json`), so a green run here is evidence that
 *  the WIRE did not move — not merely that the spec and the current code agree
 *  with each other, which they would even if both were wrong.
 *
 *  Both sides run `driveRetrieval` from the corpus module, so there is one
 *  definition of what a case is rather than one per consumer.
 */

import { describe, expect, it } from 'bun:test';
import {
  RETRIEVAL_CASES,
  canon,
  driveRetrieval,
  keyFor,
} from './retrieval-corpus';
import golden from '../../fixtures/retrieval-golden.json' with { type: 'json' };

const frozen = (golden as { index: Record<string, unknown> }).index;

describe('hosted retrieval — every frozen request is reproduced', () => {
  for (const c of RETRIEVAL_CASES) {
    it(`${c.provider}/${c.op}/${c.name}`, async () => {
      const seen = await driveRetrieval(c);
      expect(seen.length).toBeGreaterThan(0);
      for (let i = 0; i < seen.length; i++) {
        const key = keyFor(c, i);
        expect(frozen[key], `${key} is not in the frozen corpus`).toBeDefined();
        expect(JSON.parse(JSON.stringify(canon(seen[i]) ?? null))).toEqual(frozen[key]);
      }
    });
  }

  it('covers every frozen request, so nothing silently stops being sent', async () => {
    const produced = new Set<string>();
    for (const c of RETRIEVAL_CASES) {
      const seen = await driveRetrieval(c);
      for (let i = 0; i < seen.length; i++) produced.add(keyFor(c, i));
    }
    expect([...Object.keys(frozen)].filter((k) => !produced.has(k))).toEqual([]);
  });
});
