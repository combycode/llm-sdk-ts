/** P3: server->client requests — sampling / roots / elicitation — over the real
 *  stdio server. The fixture asks us to fulfill each, then logs what we returned. */

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

describe('MCP server-initiated requests (P3)', () => {
  it('fulfills sampling (custom handler), roots, and elicitation', async () => {
    const logs: string[] = [];
    const mcp = await connectMcp(
      { command: process.execPath, args: [fixture], name: 'calc' },
      {
        sampling: async () => ({ role: 'assistant', content: { type: 'text', text: 'SAMPLED-OK' }, model: 'test', stopReason: 'endTurn' }),
        roots: [{ uri: 'file:///root', name: 'root' }],
        elicit: async () => ({ action: 'accept', content: { name: 'Alex' } }),
        onNotification: (method, params) => {
          if (method === 'notifications/message') logs.push(String((params as { data?: string }).data));
        },
      },
    );
    try {
      const probe = mcp.tools.find((t) => fnName(t) === 'calc__probe_server');
      expect(probe).toBeDefined();
      await probe?.execute({}, ctx()); // triggers the three server->client requests

      await waitFor(() => logs.some((l) => l.startsWith('sampled:')) && logs.some((l) => l.startsWith('roots:')) && logs.some((l) => l.startsWith('elicit:')));
      expect(logs).toContain('sampled:SAMPLED-OK');
      expect(logs).toContain('roots:[{"uri":"file:///root","name":"root"}]');
      expect(logs).toContain('elicit:accept');
    } finally {
      await mcp.close();
    }
  });
});
