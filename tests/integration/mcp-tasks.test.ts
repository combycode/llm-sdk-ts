/** P4: long-running tool calls (tasks) over the real stdio server. */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { connectMcp } from '../../src/helpers/mcp';

const fixture = join(import.meta.dir, '..', '_fixtures', 'mcp-stdio-server.mjs');

describe('MCP tasks (P4, real server)', () => {
  it('creates a task, polls to completion, fetches the result, lists + cancels', async () => {
    const mcp = await connectMcp({ command: process.execPath, args: [fixture], name: 'calc' });
    try {
      const task = await mcp.client.callToolTask('add', { a: 2, b: 3 }, { ttl: 60_000 });
      expect(task.status).toBe('working');
      expect(typeof task.taskId).toBe('string');

      const done = await mcp.client.awaitTask(task.taskId, { pollIntervalMs: 5 });
      expect(done.status).toBe('completed');

      const result = await mcp.client.getTaskResult(task.taskId);
      expect((result.content[0] as { text: string }).text).toBe('5');

      const list = await mcp.client.listTasks();
      expect(list.some((t) => t.taskId === task.taskId)).toBe(true);

      await mcp.client.cancelTask(task.taskId); // no throw
    } finally {
      await mcp.close();
    }
  });
});
