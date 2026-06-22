/** Real Streamable-HTTP MCP server end-to-end: a Bun.serve endpoint speaking
 *  JSON-RPC, driven through the engine's fetch. */

import { describe, expect, it } from 'bun:test';
import type { AgentTool } from '../../src/agent/types';
import { createEngine } from '../../src/helpers/engine';
import { connectMcp } from '../../src/helpers/mcp';
import { isFunctionTool } from '../../src/llm/types/tools';

const ctx = () => ({ step: 0, callId: 'c', signal: new AbortController().signal, metrics: new Map() });
const fnName = (t: AgentTool) => (isFunctionTool(t.definition) ? t.definition.name : '');

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** The fixture's request handler — returns a JSON-RPC reply, or null for a notification. */
function reply(msg: { id?: number; method: string; params?: Record<string, unknown> }): unknown {
  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: (msg.params as { protocolVersion: string }).protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture-http', version: '0.0.1' },
        },
      };
    case 'notifications/initialized':
      return null;
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'add',
              description: 'Add two numbers',
              inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
            },
          ],
        },
      };
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

describe('MCP Streamable HTTP transport (real server)', () => {
  it('connects, lists, and calls over HTTP via engine.fetch', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === 'GET') return new Response(null, { status: 405 }); // no server->client stream
        if (req.method === 'DELETE') return new Response(null, { status: 200 });
        const msg = (await req.json()) as { id?: number; method: string; params?: Record<string, unknown> };
        const out = reply(msg);
        if (out === null) return new Response(null, { status: 202 });
        return new Response(JSON.stringify(out), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
        });
      },
    });
    const engine = createEngine({ registerAsDefault: false });
    try {
      const mcp = await connectMcp({ url: `http://localhost:${server.port}/mcp`, name: 'calc' }, { engine });
      expect(mcp.serverInfo?.serverInfo.name).toBe('fixture-http');
      const add = mcp.tools.find((t) => fnName(t) === 'calc__add');
      expect(add).toBeDefined();
      expect(await add?.execute({ a: 4, b: 5 }, ctx())).toBe('9');
      await mcp.close();
    } finally {
      engine.destroy();
      server.stop(true);
    }
  });

  it('receives server->client notifications over the GET SSE stream', async () => {
    const enc = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === 'GET') {
          // server->client SSE channel: push one notification, then close
          let timer: ReturnType<typeof setTimeout> | undefined;
          const body = new ReadableStream({
            start(controller) {
              const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`;
              controller.enqueue(enc.encode(frame));
              timer = setTimeout(() => {
                try {
                  controller.close();
                } catch {
                  /* client may have already aborted the stream */
                }
              }, 40);
            },
            cancel() {
              if (timer) clearTimeout(timer);
            },
          });
          return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        if (req.method === 'DELETE') return new Response(null, { status: 200 });
        const msg = (await req.json()) as { id?: number; method: string; params?: Record<string, unknown> };
        const out = reply(msg);
        if (out === null) return new Response(null, { status: 202 });
        return new Response(JSON.stringify(out), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-2' },
        });
      },
    });
    const engine = createEngine({ registerAsDefault: false });
    const seen: string[] = [];
    try {
      const mcp = await connectMcp(
        { url: `http://localhost:${server.port}/mcp`, name: 'calc' },
        { engine, onNotification: (method) => seen.push(method) },
      );
      await waitFor(() => seen.includes('notifications/tools/list_changed'));
      await mcp.close();
    } finally {
      engine.destroy();
      server.stop(true);
    }
  });
});
