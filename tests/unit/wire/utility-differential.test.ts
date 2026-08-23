/** Token counting, model listing, file retrieval and the provenance check still
 *  send what they sent before.
 *
 *  Frozen from the pre-migration commit (`tests/fixtures/utility-golden.json`),
 *  normalised to the four fields that go on the wire — two of these surfaces took
 *  a WHATWG `(url, init)` fetch before the migration and an engine request object
 *  after it, and the fixture has to outlive that change to be worth anything.
 */

import { describe, expect, it } from 'bun:test';
import { UTILITY_CASES, driveUtility, utilityKey } from './utility-corpus';
import { frozenForm } from './canon';
import golden from '../../fixtures/utility-golden.json' with { type: 'json' };

const frozen = (golden as { index: Record<string, unknown> }).index;

/** `responseType` is engine metadata, not wire: it tells the NetworkEngine how to
 *  decode the answer. The token-count APIs acquired one by moving onto the engine
 *  at all — the point of that change — so it is compared out here and asserted
 *  explicitly below instead, where it actually means something. */
const wireOnly = (v: unknown): unknown => {
  const { responseType: _rt, _derived: _d, ...rest } = (v ?? {}) as Record<string, unknown>;
  return rest;
};

describe('the utility surfaces — every frozen request is reproduced', () => {
  for (const c of UTILITY_CASES) {
    it(`${c.op}/${c.name}`, async () => {
      const seen = await driveUtility(c);
      expect(seen.length).toBeGreaterThan(0);
      for (let i = 0; i < seen.length; i++) {
        const key = utilityKey(c, i);
        expect(frozen[key], `${key} is not in the frozen corpus`).toBeDefined();
        expect(wireOnly(frozenForm(seen[i]))).toEqual(wireOnly(frozen[key]));
      }
    });
  }

  it('covers every frozen request, so nothing silently stops being sent', async () => {
    const produced = new Set<string>();
    for (const c of UTILITY_CASES) {
      const seen = await driveUtility(c);
      for (let i = 0; i < seen.length; i++) produced.add(utilityKey(c, i));
    }
    expect([...Object.keys(frozen)].filter((k) => !produced.has(k))).toEqual([]);
  });

  it('asks the engine for the right decoding', async () => {
    const kind = async (name: string) => {
      const c = UTILITY_CASES.find((x) => x.name === name)!;
      const [req] = (await driveUtility(c)) as Array<{ responseType?: string }>;
      return req.responseType;
    };
    // A retrieved file is bytes; a streamed one must NOT be buffered first.
    expect(await kind('openai.byId')).toBe('arraybuffer');
    expect(await kind('openai.stream')).toBe('stream');
    // Everything else answers JSON.
    expect(await kind('anthropic.text')).toBe('json');
    expect(await kind('openai')).toBe('json');
  });
});
