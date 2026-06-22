/** WebSocket MCP transport over a real Bun.serve WebSocket server. */

import { describe, expect, it } from 'bun:test';
import type { AgentTool } from '../../src/agent/types';
import { createEngine } from '../../src/helpers/engine';
import { connectMcp } from '../../src/helpers/mcp';
import { isFunctionTool } from '../../src/llm/types/tools';

const ctx = () => ({ step: 0, callId: 'c', signal: new AbortController().signal, metrics: new Map() });
const fnName = (t: AgentTool) => (isFunctionTool(t.definition) ? t.definition.name : '');

function reply(msg: { id?: number; method: string; params?: Record<string, unknown> }): unknown {
  switch (msg.method) {
    case 'initialize':
      return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params as { protocolVersion: string }).protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture-ws', version: '0.0.1' } } };
    case 'notifications/initialized':
      return null;
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'add', description: 'Add', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }] } };
    case 'tools/call': {
      const { name, arguments: args } = msg.params as { name: string; arguments: { a: number; b: number } };
      return name === 'add'
        ? { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(args.a + args.b) }] } }
        : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown tool' } };
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
  }
}

describe('MCP WebSocket transport (real server)', () => {
  it('connects, lists, and calls over ws://', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response('expected websocket', { status: 400 });
      },
      websocket: {
        message(ws, message) {
          const msg = JSON.parse(String(message));
          const out = reply(msg);
          if (out !== null) ws.send(JSON.stringify(out));
        },
      },
    });
    const engine = createEngine({ registerAsDefault: false });
    try {
      const mcp = await connectMcp({ url: `ws://localhost:${server.port}`, name: 'calc' }, { engine });
      expect(mcp.serverInfo?.serverInfo.name).toBe('fixture-ws');
      const add = mcp.tools.find((t) => fnName(t) === 'calc__add');
      expect(add).toBeDefined();
      expect(await add?.execute({ a: 6, b: 7 }, ctx())).toBe('13');
      await mcp.close();
    } finally {
      engine.destroy();
      server.stop(true);
    }
  });
});
