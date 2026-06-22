/** P2: resources / prompts / logging over the real stdio MCP server. */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { connectMcp } from '../../src/helpers/mcp';
import { mcpPromptToMessages } from '../../src/plugins/mcp/tools';

const fixture = join(import.meta.dir, '..', '_fixtures', 'mcp-stdio-server.mjs');

describe('MCP resources / prompts / logging (real server)', () => {
  it('lists + reads resources, lists + renders prompts, sets log level', async () => {
    const logs: unknown[] = [];
    const mcp = await connectMcp(
      { command: process.execPath, args: [fixture], name: 'calc' },
      { onNotification: (method, params) => method === 'notifications/message' && logs.push(params) },
    );
    try {
      // resources
      const resources = await mcp.client.listResources();
      expect(resources.map((r) => r.uri)).toContain('mem://greeting');
      const contents = await mcp.client.readResource('mem://greeting');
      expect(contents[0]?.text).toBe('hello from resource');

      // prompts
      const prompts = await mcp.client.listPrompts();
      expect(prompts.map((p) => p.name)).toContain('greet');
      const got = await mcp.client.getPrompt('greet', { who: 'Alex' });
      const messages = mcpPromptToMessages(got);
      expect(messages).toEqual([{ role: 'user', content: 'Say hi to Alex' }]);

      // logging — server replies + emits a log notification
      await mcp.client.setLogLevel('debug');
      // (the log notification arrives async; not asserted strictly to avoid flakiness)

      // completion/complete — argument autocompletion
      const completion = await mcp.client.completeArgument({ type: 'ref/prompt', name: 'greet' }, { name: 'who', value: 'Al' });
      expect(completion.values).toEqual(['Alex', 'Alice']);
    } finally {
      await mcp.close();
    }
  });
});
