/** WebSocket MCP transport, driven entirely by an in-memory fake connection.
 *
 *  No socket is opened here: `WsTransport` takes the engine's `connect` as a dependency, so the
 *  test supplies one that records frames and lets the test fire lifecycle events by hand. The
 *  behaviours pinned are the ones the wire cannot show us later — what goes out on the socket,
 *  which error each lifecycle event produces, and what happens to in-flight work when the socket
 *  dies. */

import { describe, expect, it } from 'bun:test';
import { WsTransport } from '../../../../src/plugins/mcp/transport-ws';
import { McpError, McpErrorCode } from '../../../../src/plugins/mcp/jsonrpc';
import type { EngineConnect, RealtimeConnection, RealtimeFrame, WsRequest } from '../../../../src/network/types';

type Listener = (arg?: unknown) => void;

/** A `RealtimeConnection` whose events the test fires and whose frames the test reads. */
class FakeConn {
  readonly sent: string[] = [];
  readyState = 0; // CONNECTING
  closeCalls = 0;
  private readonly listeners = new Map<string, Listener[]>();

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(String(data));
  }
  on(type: string, cb: Listener): () => void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
    return () => {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((x) => x !== cb),
      );
    };
  }
  close(): void {
    this.closeCalls++;
  }
  emit(type: string, arg?: unknown): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(arg);
  }
  /** Deliver a server->client frame as the engine would. */
  deliver(frame: RealtimeFrame): void {
    this.emit('message', frame);
  }
  deliverJson(obj: unknown): void {
    this.deliver({ text: JSON.stringify(obj) });
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  asConnection(): RealtimeConnection {
    return this as unknown as RealtimeConnection;
  }
}

function makeConnect(conn: FakeConn): { connect: EngineConnect; requests: WsRequest[] } {
  const requests: WsRequest[] = [];
  const connect = ((req: WsRequest) => {
    requests.push(req);
    return conn.asConnection();
  }) as EngineConnect;
  return { connect, requests };
}

/** Start a transport whose socket is already open — the common setup. */
async function startOpen(timeoutMs = 200) {
  const conn = new FakeConn();
  conn.readyState = 1; // OPEN
  const { connect, requests } = makeConnect(conn);
  const t = new WsTransport({ url: 'wss://mcp.example.com/rpc' }, { connect, timeoutMs });
  await t.start();
  return { t, conn, requests };
}

describe('WsTransport: connecting', () => {
  it('routes the connection through the engine with MCP identity and the config', async () => {
    // `provider`/`model` are not wire fields — they are how the NetworkEngine queues and labels the
    // socket, so a regression here silently moves MCP traffic into another provider's queue.
    const conn = new FakeConn();
    conn.readyState = 1;
    const { connect, requests } = makeConnect(conn);
    const t = new WsTransport(
      { url: 'wss://mcp.example.com/rpc', protocols: ['mcp'], headers: { authorization: 'Bearer x' }, name: 'files' },
      { connect },
    );
    await t.start();

    expect(requests).toEqual([
      {
        url: 'wss://mcp.example.com/rpc',
        protocols: ['mcp'],
        headers: { authorization: 'Bearer x' },
        provider: 'mcp',
        model: 'files',
      },
    ]);
  });

  it("labels an unnamed server 'server'", async () => {
    const conn = new FakeConn();
    conn.readyState = 1;
    const { connect, requests } = makeConnect(conn);
    await new WsTransport({ url: 'wss://mcp.example.com/rpc' }, { connect }).start();
    expect(requests[0]?.model).toBe('server');
  });

  it('waits for the open event when the socket is still connecting', async () => {
    const conn = new FakeConn(); // readyState CONNECTING
    const { connect } = makeConnect(conn);
    const t = new WsTransport({ url: 'wss://mcp.example.com/rpc' }, { connect, timeoutMs: 500 });

    let opened = false;
    const started = t.start().then(() => {
      opened = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(opened).toBe(false); // still waiting — nothing resolved it yet

    conn.emit('open');
    await started;
    expect(opened).toBe(true);
  });

  it('rejects with ConnectionClosed when the socket errors before it opens', async () => {
    const conn = new FakeConn();
    const { connect } = makeConnect(conn);
    const t = new WsTransport({ url: 'wss://mcp.example.com/rpc' }, { connect, timeoutMs: 500 });
    const started = t.start();
    conn.emit('error', new Error('refused'));
    const err = (await started.catch((e) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(McpErrorCode.ConnectionClosed);
    expect(err.message).toBe('MCP ws failed to open');
  });

  it('rejects with RequestTimeout when the socket never opens', async () => {
    const conn = new FakeConn();
    const { connect } = makeConnect(conn);
    const t = new WsTransport({ url: 'wss://mcp.example.com/rpc' }, { connect, timeoutMs: 20 });
    const err = (await t.start().catch((e) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(McpErrorCode.RequestTimeout);
    expect(err.message).toBe('MCP ws open timed out');
  });

  it('setProtocolVersion and listen are no-ops — a socket carries no headers and is already duplex', async () => {
    const { t, conn } = await startOpen();
    t.setProtocolVersion();
    t.listen();
    expect(conn.sent).toEqual([]);
  });
});

describe('WsTransport: requests', () => {
  it('refuses to send before start() rather than dropping the call', async () => {
    const conn = new FakeConn();
    const { connect } = makeConnect(conn);
    const t = new WsTransport({ url: 'wss://mcp.example.com/rpc' }, { connect });
    const err = (await t.request('tools/list').catch((e) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(McpErrorCode.ConnectionClosed);
    expect(err.message).toBe('MCP ws transport not started');
    expect(conn.sent).toEqual([]);
  });

  it('sends a correlated JSON-RPC request and resolves it from the matching response', async () => {
    const { t, conn } = await startOpen();
    const pending = t.request('tools/list', { cursor: 'p2' });

    expect(conn.frames()).toEqual([{ jsonrpc: '2.0', id: 0, method: 'tools/list', params: { cursor: 'p2' } }]);

    conn.deliverJson({ jsonrpc: '2.0', id: 0, result: { tools: [{ name: 'a' }] } });
    expect(await pending).toEqual({ tools: [{ name: 'a' }] });
  });

  it('omits `params` when the caller passed none', async () => {
    const { t, conn } = await startOpen();
    const pending = t.request('ping');
    expect(Object.keys(conn.frames()[0])).toEqual(['jsonrpc', 'id', 'method']);
    conn.deliverJson({ jsonrpc: '2.0', id: 0, result: {} });
    await pending;
  });

  it('rejects with McpError when the response carries an error', async () => {
    const { t, conn } = await startOpen();
    const pending = t.request('tools/call', { name: 'nope' });
    conn.deliverJson({ jsonrpc: '2.0', id: 0, error: { code: -32601, message: 'no such tool' } });
    const err = (await pending.catch((e) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(-32601);
  });

  it('times out a request the server never answers', async () => {
    const { t } = await startOpen(20);
    await expect(t.request('tools/list')).rejects.toThrow(/'tools\/list' timed out/);
  });

  it('notify() sends a frame with no id, so no response is ever awaited', async () => {
    const { t, conn } = await startOpen();
    await t.notify('notifications/initialized');
    await t.notify('notifications/progress', { progress: 1 });
    expect(conn.frames()).toEqual([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
    ]);
  });

  it('notify() before start is a silent no-op, not a crash', async () => {
    const conn = new FakeConn();
    const { connect } = makeConnect(conn);
    const t = new WsTransport({ url: 'wss://mcp.example.com/rpc' }, { connect });
    await t.notify('notifications/initialized');
    expect(conn.sent).toEqual([]);
  });
});

describe('WsTransport: inbound frames', () => {
  it('decodes a binary frame the same as a text one', async () => {
    // Some servers send text as binary frames; treating those as unparseable would drop every
    // message from such a server without a word.
    const { t, conn } = await startOpen();
    const pending = t.request('tools/list');
    conn.deliver({ binary: new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { ok: true } })) });
    expect(await pending).toEqual({ ok: true });
  });

  it('drops an unparseable frame instead of throwing out of the socket callback', async () => {
    const { t, conn } = await startOpen();
    const pending = t.request('tools/list');
    expect(() => conn.deliver({ text: 'not json at all' })).not.toThrow();
    // The pending request is untouched and still settles on the real response.
    conn.deliverJson({ jsonrpc: '2.0', id: 0, result: { ok: true } });
    expect(await pending).toEqual({ ok: true });
  });

  it('forwards a server notification to the registered handler', async () => {
    const { t, conn } = await startOpen();
    const seen: Array<[string, unknown]> = [];
    t.setHandlers({ onNotification: (m, p) => seen.push([m, p]) });
    conn.deliverJson({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } });
    expect(seen).toEqual([['notifications/message', { level: 'info' }]]);
  });

  it('answers a server->client request back over the same socket', async () => {
    const { t, conn } = await startOpen();
    t.setHandlers({ onRequest: async (method) => ({ answered: method }) });
    conn.deliverJson({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list', params: {} });
    await new Promise((r) => setTimeout(r, 5));
    expect(conn.frames()).toEqual([{ jsonrpc: '2.0', id: 'srv-1', result: { answered: 'roots/list' } }]);
  });
});

describe('WsTransport: teardown', () => {
  it('a socket error fails every in-flight request with ConnectionClosed', async () => {
    const { t, conn } = await startOpen(10_000);
    const pending = t.request('tools/list');
    conn.emit('error', new Error('reset'));
    const err = (await pending.catch((e) => e)) as McpError;
    expect(err.code).toBe(McpErrorCode.ConnectionClosed);
    expect(err.message).toBe('MCP ws error');
  });

  it('a socket close fails every in-flight request, distinctly from an error', async () => {
    // The two messages differ on purpose: "closed" is the peer hanging up, "error" is the socket
    // breaking, and a caller logging them cannot tell them apart if they are merged.
    const { t, conn } = await startOpen(10_000);
    const pending = t.request('tools/list');
    conn.emit('close');
    await expect(pending).rejects.toThrow('MCP ws closed');
  });

  it('close() fails in-flight work, shuts the socket, and refuses later requests', async () => {
    const { t, conn } = await startOpen(10_000);
    const pending = t.request('tools/list');
    await t.close();

    await expect(pending).rejects.toThrow('MCP transport closed');
    expect(conn.closeCalls).toBe(1);
    // The connection handle is dropped, so a later call fails loudly instead of vanishing.
    await expect(t.request('tools/list')).rejects.toThrow('MCP ws transport not started');
  });

  it('close() on a never-started transport is a no-op', async () => {
    const conn = new FakeConn();
    const { connect } = makeConnect(conn);
    const t = new WsTransport({ url: 'wss://mcp.example.com/rpc' }, { connect });
    await t.close();
    expect(conn.closeCalls).toBe(0);
  });
});
