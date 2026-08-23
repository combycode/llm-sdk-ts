/** The MCP Streamable-HTTP transport still sends what it sent before.
 *
 *  Frozen from the pre-migration commit (`tests/fixtures/mcp-golden.json`), so a
 *  green run is evidence the wire did not move — not that the spec and the code
 *  agree with each other.
 *
 *  This carries more weight than the provider differentials do, because the live
 *  MCP example reaches a HANDSHAKE-era server: the modern routing headers have no
 *  live coverage anywhere, and this is the only thing that checks them.
 */

import { describe, expect, it } from 'bun:test';
import { MCP_CASES, driveMcp, mcpKey } from './mcp-corpus';
import { frozenForm } from './canon';
import golden from '../../fixtures/mcp-golden.json' with { type: 'json' };

const frozen = (golden as { index: Record<string, unknown> }).index;

describe('mcp transport — every frozen request is reproduced', () => {
  for (const c of MCP_CASES) {
    it(`${c.op}/${c.name}`, async () => {
      const seen = await driveMcp(c);
      expect(seen.length).toBeGreaterThan(0);
      for (let i = 0; i < seen.length; i++) {
        const key = mcpKey(c, i);
        expect(frozen[key], `${key} is not in the frozen corpus`).toBeDefined();
        expect(frozenForm(seen[i])).toEqual(frozen[key]);
      }
    });
  }

  it('covers every frozen request, so nothing silently stops being sent', async () => {
    const produced = new Set<string>();
    for (const c of MCP_CASES) {
      const seen = await driveMcp(c);
      for (let i = 0; i < seen.length; i++) produced.add(mcpKey(c, i));
    }
    expect([...Object.keys(frozen)].filter((k) => !produced.has(k))).toEqual([]);
  });
});
