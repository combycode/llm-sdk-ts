/** Real stdio MCP server end-to-end: spawn the fixture, run the actual
 *  protocol (initialize -> tools/list -> tools/call) over NDJSON. */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { AgentTool } from '../../src/agent/types';
import { connectMcp } from '../../src/helpers/mcp';
import { isFunctionTool } from '../../src/llm/types/tools';

const fixture = join(import.meta.dir, '..', '_fixtures', 'mcp-stdio-server.mjs');
const ctx = () => ({ step: 0, callId: 'c', signal: new AbortController().signal, metrics: new Map() });
const fnName = (t: AgentTool) => (isFunctionTool(t.definition) ? t.definition.name : '');

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('MCP stdio transport (real server)', () => {
  it('connects, lists tools, and calls one over the real protocol', async () => {
    const mcp = await connectMcp({ command: process.execPath, args: [fixture], name: 'calc' });
    try {
      expect(mcp.serverInfo?.serverInfo.name).toBe('fixture');
      const names = mcp.tools.map(fnName);
      expect(names).toContain('calc__add');

      const add = mcp.tools.find((t) => fnName(t) === 'calc__add');
      expect(add).toBeDefined();
      const out = await add?.execute({ a: 2, b: 3 }, ctx());
      expect(out).toBe('5');
    } finally {
      await mcp.close();
    }
  });

  it('handles server->client notifications and a ping round-trip (bidirectional)', async () => {
    const seen: Array<{ method: string; params: unknown }> = [];
    const mcp = await connectMcp(
      { command: process.execPath, args: [fixture], name: 'calc' },
      { onNotification: (method, params) => seen.push({ method, params }) },
    );
    try {
      // notifications/message only arrives AFTER the server received our ping reply,
      // so waiting for it proves the full server->client request round-trip.
      await waitFor(() => seen.some((s) => s.method === 'notifications/message'));
      expect(seen.map((s) => s.method)).toContain('notifications/tools/list_changed');
      const log = seen.find((s) => s.method === 'notifications/message');
      expect((log?.params as { data?: string })?.data).toBe('pong-received');
    } finally {
      await mcp.close();
    }
  });
});
