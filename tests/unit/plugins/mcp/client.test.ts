import { describe, expect, it } from 'bun:test';
import { McpClient } from '../../../../src/plugins/mcp/client';
import { McpError } from '../../../../src/plugins/mcp/jsonrpc';
import type { IncomingMcpHandlers, McpTransport } from '../../../../src/plugins/mcp/transport';
import { HookBus } from '../../../../src/bus/hook-bus';
import type { McpToolCallContext, McpErrorContext } from '../../../../src/bus/hook-map';

/** A scripted in-memory transport: `handler(method, params)` returns the result,
 *  or throws to simulate a JSON-RPC error. Captures the client's incoming
 *  handlers so a test can simulate server->client requests/notifications. */
class MockTransport implements McpTransport {
  started = false;
  listening = false;
  protocolVersion: string | null = null;
  notifications: string[] = [];
  handlers: IncomingMcpHandlers = {};
  constructor(private readonly handler: (method: string, params: unknown) => unknown) {}
  async start() {
    this.started = true;
  }
  setHandlers(h: IncomingMcpHandlers) {
    this.handlers = h;
  }
  setProtocolVersion(v: string) {
    this.protocolVersion = v;
  }
  listen() {
    this.listening = true;
  }
  async request(method: string, params?: unknown) {
    return this.handler(method, params);
  }
  async notify(method: string) {
    this.notifications.push(method);
  }
  async close() {}
}

describe('McpClient', () => {
  it('connect() runs initialize + sends initialized + records protocol version', async () => {
    const t = new MockTransport((method) =>
      method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 's', version: '1' } }
        : {},
    );
    const client = new McpClient(t, { clientInfo: { name: 'test', version: '0' } });
    const info = await client.connect();
    expect(t.started).toBe(true);
    expect(info.serverInfo.name).toBe('s');
    expect(t.protocolVersion).toBe('2025-11-25');
    expect(t.notifications).toContain('notifications/initialized');
    expect(client.info).toEqual(info);
  });

  it('listTools() follows cursor pagination', async () => {
    const t = new MockTransport((method, params) => {
      if (method === 'initialize') return { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } };
      if (method === 'tools/list') {
        const cursor = (params as { cursor?: string })?.cursor;
        return cursor === 'p2'
          ? { tools: [{ name: 'b', inputSchema: { type: 'object' } }] }
          : { tools: [{ name: 'a', inputSchema: { type: 'object' } }], nextCursor: 'p2' };
      }
      return {};
    });
    const client = new McpClient(t);
    await client.connect();
    const tools = await client.listTools();
    expect(tools.map((x) => x.name)).toEqual(['a', 'b']);
  });

  it('answers a server->client ping and forwards notifications (bidirectional)', async () => {
    const t = new MockTransport((method) =>
      method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } } : {},
    );
    const seen: Array<{ method: string; params: unknown }> = [];
    const client = new McpClient(t, { onNotification: (method, params) => seen.push({ method, params }) });
    await client.connect();
    expect(t.listening).toBe(true);
    // server -> client ping is answered internally
    expect(await t.handlers.onRequest?.('ping', {})).toEqual({});
    // an unhandled server request rejects with MethodNotFound
    await expect(t.handlers.onRequest?.('sampling/createMessage', {})).rejects.toThrow(McpError);
    // a notification is forwarded to the callback
    t.handlers.onNotification?.('notifications/tools/list_changed', { x: 1 });
    expect(seen).toEqual([{ method: 'notifications/tools/list_changed', params: { x: 1 } }]);
  });

  it('callTool() returns the result; a JSON-RPC error becomes McpError', async () => {
    const t = new MockTransport((method, params) => {
      if (method === 'tools/call') {
        const p = params as { name: string };
        if (p.name === 'boom') throw new McpError({ code: -32601, message: 'no such tool' });
        return { content: [{ type: 'text', text: 'ok' }] };
      }
      return {};
    });
    const client = new McpClient(t);
    const res = await client.callTool('fine', {});
    expect(res.content[0]).toEqual({ type: 'text', text: 'ok' });
    await expect(client.callTool('boom', {})).rejects.toThrow(McpError);
  });

  it('callTool() threads trace into onMcpToolCall hook', async () => {
    const t = new MockTransport((method) => {
      if (method === 'initialize') return { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } };
      if (method === 'tools/call') return { content: [{ type: 'text', text: 'ok' }] };
      return {};
    });
    const hooks = new HookBus();
    const captured: McpToolCallContext[] = [];
    hooks.on('onMcpToolCall', (ctx) => { captured.push({ ...ctx }); });

    const client = new McpClient(t, { hooks, server: 'test-server' });
    await client.connect();
    const trace = { sessionId: 'sess-1', requestId: 'req-1', callId: 'call-1' };
    await client.callTool('my-tool', {}, trace);

    expect(captured.length).toBe(1);
    expect(captured[0].trace).toEqual(trace);
    expect(captured[0].tool).toBe('my-tool');
    expect(captured[0].server).toBe('test-server');
  });

  it('callTool() threads trace into onMcpError hook on failure', async () => {
    const t = new MockTransport((method) => {
      if (method === 'initialize') return { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } };
      if (method === 'tools/call') throw new McpError({ code: -32601, message: 'bad tool' });
      return {};
    });
    const hooks = new HookBus();
    const errors: McpErrorContext[] = [];
    hooks.on('onMcpError', (ctx) => { errors.push({ ...ctx }); });

    const client = new McpClient(t, { hooks, server: 'test-server' });
    await client.connect();
    const trace = { sessionId: 'sess-2', requestId: 'req-2' };
    await expect(client.callTool('bad', {}, trace)).rejects.toThrow(McpError);

    expect(errors.length).toBe(1);
    expect(errors[0].trace).toEqual(trace);
    expect(errors[0].phase).toBe('request');
  });

  it('callTool() emits onMcpToolCall without trace when none provided', async () => {
    const t = new MockTransport((method) => {
      if (method === 'initialize') return { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } };
      if (method === 'tools/call') return { content: [] };
      return {};
    });
    const hooks = new HookBus();
    const captured: McpToolCallContext[] = [];
    hooks.on('onMcpToolCall', (ctx) => { captured.push({ ...ctx }); });

    const client = new McpClient(t, { hooks, server: 'test-server' });
    await client.connect();
    await client.callTool('no-trace-tool', {});

    expect(captured.length).toBe(1);
    expect(captured[0].trace).toBeUndefined();
  });
});
