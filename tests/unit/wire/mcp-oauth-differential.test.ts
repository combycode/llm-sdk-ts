/** The MCP OAuth flow still sends what it sent before.
 *
 *  Frozen from the pre-migration commit (`tests/fixtures/mcp-oauth-golden.json`).
 *
 *  This is the ONLY check these requests have. An OAuth round-trip needs a real
 *  authorization server and a browser, so nothing here is ever exercised live —
 *  which is exactly why the frozen bytes matter more, not less.
 */

import { describe, expect, it } from 'bun:test';
import { OAUTH_CASES, driveOauth, oauthKey } from './mcp-oauth-corpus';
import { frozenForm } from './canon';
import golden from '../../fixtures/mcp-oauth-golden.json' with { type: 'json' };

const frozen = (golden as { index: Record<string, unknown> }).index;

describe('mcp oauth — every frozen request is reproduced', () => {
  for (const c of OAUTH_CASES) {
    it(`${c.op}/${c.name}`, async () => {
      const seen = await driveOauth(c);
      expect(seen.length).toBeGreaterThan(0);
      for (let i = 0; i < seen.length; i++) {
        const key = oauthKey(c, i);
        expect(frozen[key], `${key} is not in the frozen corpus`).toBeDefined();
        expect(frozenForm(seen[i])).toEqual(frozen[key]);
      }
    });
  }

  it('covers every frozen request, so nothing silently stops being sent', async () => {
    const produced = new Set<string>();
    for (const c of OAUTH_CASES) {
      const seen = await driveOauth(c);
      for (let i = 0; i < seen.length; i++) produced.add(oauthKey(c, i));
    }
    expect([...Object.keys(frozen)].filter((k) => !produced.has(k))).toEqual([]);
  });
});
