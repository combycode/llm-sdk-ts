import { describe, expect, it } from 'bun:test';
import { StdioTransport } from '../../../../src/plugins/mcp/transport-stdio';

describe('stdio transport browser guard', () => {
  it('rejects in a simulated browser (no child_process)', async () => {
    const g = globalThis as { window?: unknown };
    const had = 'window' in g;
    const prev = g.window;
    g.window = { document: {} }; // make isBrowser() true
    try {
      const t = new StdioTransport({ command: 'node', args: [] });
      await expect(t.start()).rejects.toThrow(/browser/i);
    } finally {
      if (had) g.window = prev;
      else delete g.window;
    }
  });
});
