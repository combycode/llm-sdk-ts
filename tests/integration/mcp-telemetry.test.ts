/** MCP telemetry: onMcpConnect + onMcpToolCall emitted on the engine's hook bus. */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { McpConnectContext, McpToolCallContext } from '../../src/bus/hook-map';
import { createEngine } from '../../src/helpers/engine';
import { connectMcp } from '../../src/helpers/mcp';
import { isFunctionTool } from '../../src/llm/types/tools';

const fixture = join(import.meta.dir, '..', '_fixtures', 'mcp-stdio-server.mjs');
const ctx = () => ({ step: 0, callId: 'c', signal: new AbortController().signal, metrics: new Map() });

describe('MCP telemetry', () => {
  it('emits onMcpConnect and onMcpToolCall on the engine hook bus', async () => {
    const engine = createEngine({ registerAsDefault: false });
    const connects: McpConnectContext[] = [];
    const toolCalls: McpToolCallContext[] = [];
    engine.hooks.on('onMcpConnect', (c) => {
      connects.push(c);
    });
    engine.hooks.on('onMcpToolCall', (c) => {
      toolCalls.push(c);
    });

    const mcp = await connectMcp({ command: process.execPath, args: [fixture], name: 'calc' }, { engine });
    try {
      expect(connects.length).toBe(1);
      expect(connects[0].serverName).toBe('fixture');
      expect(connects[0].transport).toBe('stdio');
      expect(connects[0].toolCount).toBeGreaterThanOrEqual(1);

      const add = mcp.tools.find((t) => isFunctionTool(t.definition) && t.definition.name === 'calc__add');
      await add?.execute({ a: 1, b: 1 }, ctx());
      expect(toolCalls.some((c) => c.tool === 'add' && c.isError === false)).toBe(true);
    } finally {
      await mcp.close();
      engine.destroy();
    }
  });
});
