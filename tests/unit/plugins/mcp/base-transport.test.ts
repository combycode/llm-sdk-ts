/** `BaseJsonRpcTransport` — the JSON-RPC correlation layer every MCP transport inherits.
 *
 *  It is exercised here through a concrete in-memory subclass rather than through stdio/WS/HTTP,
 *  because the behaviours below are the ones a port must reproduce EXACTLY on every wire:
 *  id allocation, the pending/long-lived split, and the shape of the frames written back to a
 *  server-initiated request. Nothing here opens a socket or spawns anything. */

import { describe, expect, it } from 'bun:test';
import { BaseJsonRpcTransport, type InboundMessage } from '../../../../src/plugins/mcp/base-transport';
import { McpError, McpErrorCode } from '../../../../src/plugins/mcp/jsonrpc';

/** A concrete transport whose "wire" is an array. The `expose*` members exist only to reach the
 *  protected surface a real subclass calls from its own medium-specific parsing code. */
class ArrayTransport extends BaseJsonRpcTransport {
  readonly sent: Array<Record<string, unknown>> = [];
  /** Set to make `sendMessage` reject, mimicking a wire that died mid-write. */
  failSend: Error | null = null;

  protected sendMessage(obj: unknown): void {
    if (this.failSend) throw this.failSend;
    this.sent.push(obj as Record<string, unknown>);
  }

  exposeAllocateId(): number {
    return this.allocateId();
  }
  exposeRoute(msg: InboundMessage): void {
    this.routeIncoming(msg);
  }
  exposeResolveLongLived(id: number | string, error?: unknown): boolean {
    return this.resolveLongLived(id, error);
  }
  exposeFailAll(err: McpError): void {
    this.failAll(err);
  }
  /** Register a pending request the way a real `request()` implementation does. */
  exposeRequest(method: string, timeoutMs: number): { id: number; promise: Promise<unknown> } {
    const id = this.allocateId();
    const promise = new Promise<unknown>((resolve, reject) => {
      this.registerPending(id, resolve, reject, timeoutMs, method);
    });
    return { id, promise };
  }
  get pendingCount(): number {
    return this.pending.size;
  }
  get longLivedCount(): number {
    return this.longLived.size;
  }
}

describe('BaseJsonRpcTransport: request ids', () => {
  it('allocates monotonically from 0 and never reuses an id', () => {
    const t = new ArrayTransport();
    expect([t.exposeAllocateId(), t.exposeAllocateId(), t.exposeAllocateId()]).toEqual([0, 1, 2]);
  });

  it('shares one counter between ordinary and long-lived requests', async () => {
    // A separate counter per kind would let a listen stream and a call collide on the same id,
    // and the response to one would settle the other.
    const t = new ArrayTransport();
    const first = t.exposeRequest('tools/list', 1000);
    const listenId = await t.sendLongLivedRequest('subscriptions/listen');
    const second = t.exposeRequest('tools/call', 1000);
    expect([first.id, listenId, second.id]).toEqual([0, 1, 2]);
    t.exposeFailAll(new McpError({ code: McpErrorCode.ConnectionClosed, message: 'done' }));
    await expect(first.promise).rejects.toThrow();
    await expect(second.promise).rejects.toThrow();
  });
});

describe('BaseJsonRpcTransport: long-lived requests', () => {
  it('writes a JSON-RPC request frame carrying the returned id', async () => {
    const t = new ArrayTransport();
    const id = await t.sendLongLivedRequest('subscriptions/listen', { notifications: { toolsListChanged: true } });
    expect(t.sent).toEqual([
      {
        jsonrpc: '2.0',
        id,
        method: 'subscriptions/listen',
        params: { notifications: { toolsListChanged: true } },
      },
    ]);
  });

  it('omits `params` entirely when none are given', async () => {
    // A `params: undefined` key serialises to nothing over JSON but IS present for an in-process
    // peer, and a strict server rejects an unexpected key. Absence must be absence.
    const t = new ArrayTransport();
    await t.sendLongLivedRequest('subscriptions/listen');
    expect(Object.keys(t.sent[0])).toEqual(['jsonrpc', 'id', 'method']);
  });

  it('arms NO timeout — a healthy stream that answers nothing is not an error', async () => {
    const t = new ArrayTransport();
    await t.sendLongLivedRequest('subscriptions/listen', undefined, () => {});
    expect(t.pendingCount).toBe(0);
    expect(t.longLivedCount).toBe(1);
  });

  it('a late response settles the stream through onEnd, once, with no error', async () => {
    const t = new ArrayTransport();
    const ends: unknown[] = [];
    const id = await t.sendLongLivedRequest('subscriptions/listen', {}, (e) => ends.push(e));

    t.exposeRoute({ id, result: {} });
    expect(ends).toEqual([undefined]);

    // The entry is consumed: a duplicate response must not fire onEnd a second time.
    t.exposeRoute({ id, result: {} });
    expect(ends).toEqual([undefined]);
    expect(t.longLivedCount).toBe(0);
  });

  it('an error response ends the stream with an McpError carrying the server code', async () => {
    const t = new ArrayTransport();
    let ended: unknown = 'unset';
    const id = await t.sendLongLivedRequest('subscriptions/listen', {}, (e) => {
      ended = e;
    });

    t.exposeRoute({ id, error: { code: McpErrorCode.InvalidParams, message: 'bad filter' } });

    expect(ended).toBeInstanceOf(McpError);
    expect((ended as McpError).code).toBe(McpErrorCode.InvalidParams);
    expect((ended as McpError).message).toBe('bad filter');
  });

  it('resolveLongLived reports false for an id nobody is waiting on', () => {
    // A stray response must be dropped silently, not mistaken for a stream ending.
    const t = new ArrayTransport();
    expect(t.exposeResolveLongLived(99)).toBe(false);
  });

  it('resolveLongLived reports true for a registered id even with no onEnd callback', async () => {
    // `onEnd` is optional, so the map holds `undefined` for it — the entry must still be found by
    // membership, not by truthiness of the callback.
    const t = new ArrayTransport();
    const id = await t.sendLongLivedRequest('subscriptions/listen');
    expect(t.exposeResolveLongLived(id)).toBe(true);
    expect(t.exposeResolveLongLived(id)).toBe(false);
  });
});

describe('BaseJsonRpcTransport: pending requests', () => {
  it('rejects with RequestTimeout naming the method, and forgets the request', async () => {
    const t = new ArrayTransport();
    const { promise } = t.exposeRequest('tools/list', 5);
    await expect(promise).rejects.toThrow(/MCP request 'tools\/list' timed out/);
    expect(t.pendingCount).toBe(0);
    await promise.catch((e: McpError) => expect(e.code).toBe(McpErrorCode.RequestTimeout));
  });

  it('a response resolves the promise with `result` and disarms the timeout', async () => {
    const t = new ArrayTransport();
    const { id, promise } = t.exposeRequest('tools/list', 10);
    t.exposeRoute({ id, result: { tools: [] } });
    expect(await promise).toEqual({ tools: [] });
    expect(t.pendingCount).toBe(0);
    // If the timer were still armed it would reject an already-settled promise; wait past it to
    // prove it was cleared (an unhandled rejection would surface here).
    await new Promise((r) => setTimeout(r, 20));
  });

  it('an error response rejects with McpError, preserving code and data', async () => {
    const t = new ArrayTransport();
    const { id, promise } = t.exposeRequest('tools/call', 1000);
    t.exposeRoute({ id, error: { code: -32022, message: 'nope', data: { supported: ['2025-11-25'] } } });
    const err = (await promise.catch((e) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(-32022);
    expect(err.data).toEqual({ supported: ['2025-11-25'] });
  });

  it('ignores a response whose id is not a number', async () => {
    // Our ids are always numbers; a string id belongs to somebody else's correlation space and
    // must not settle one of ours.
    const t = new ArrayTransport();
    const { promise } = t.exposeRequest('tools/list', 1000);
    t.exposeRoute({ id: 'not-ours', result: { tools: ['stolen'] } });
    expect(t.pendingCount).toBe(1);
    t.exposeFailAll(new McpError({ code: McpErrorCode.ConnectionClosed, message: 'closing' }));
    await expect(promise).rejects.toThrow('closing');
  });
});

describe('BaseJsonRpcTransport: routing', () => {
  it('a frame with a method but no id is a notification', () => {
    const t = new ArrayTransport();
    const seen: Array<[string, unknown]> = [];
    t.setHandlers({ onNotification: (m, p) => seen.push([m, p]) });
    t.exposeRoute({ method: 'notifications/tools/list_changed', params: { a: 1 } });
    expect(seen).toEqual([['notifications/tools/list_changed', { a: 1 }]]);
    expect(t.sent).toEqual([]); // a notification is never answered
  });

  it('a frame with neither id nor method is dropped', () => {
    const t = new ArrayTransport();
    let calls = 0;
    t.setHandlers({ onNotification: () => calls++, onRequest: async () => ++calls });
    t.exposeRoute({});
    expect(calls).toBe(0);
    expect(t.sent).toEqual([]);
  });
});

describe('BaseJsonRpcTransport: server-initiated requests', () => {
  it('answers with the handler result, echoing the request id', async () => {
    const t = new ArrayTransport();
    t.setHandlers({ onRequest: async (method) => ({ echoed: method }) });
    t.exposeRoute({ id: 7, method: 'roots/list', params: {} });
    await Promise.resolve();
    expect(t.sent).toEqual([{ jsonrpc: '2.0', id: 7, result: { echoed: 'roots/list' } }]);
  });

  it('substitutes an empty object when the handler returns undefined', async () => {
    // JSON-RPC requires `result` OR `error`; a `result: undefined` serialises to neither and the
    // server sees a malformed response.
    const t = new ArrayTransport();
    t.setHandlers({ onRequest: async () => undefined });
    t.exposeRoute({ id: 1, method: 'ping' });
    await Promise.resolve();
    expect(t.sent).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });

  it('replies MethodNotFound when no handler is registered at all', async () => {
    const t = new ArrayTransport();
    t.exposeRoute({ id: 2, method: 'sampling/createMessage', params: {} });
    await Promise.resolve();
    expect(t.sent).toEqual([
      { jsonrpc: '2.0', id: 2, error: { code: McpErrorCode.MethodNotFound, message: 'no request handler' } },
    ]);
  });

  it('forwards an McpError thrown by the handler with its own code and data', async () => {
    const t = new ArrayTransport();
    t.setHandlers({
      onRequest: async () => {
        throw new McpError({ code: McpErrorCode.InvalidParams, message: 'bad', data: { field: 'x' } });
      },
    });
    t.exposeRoute({ id: 3, method: 'elicitation/create' });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.sent).toEqual([
      { jsonrpc: '2.0', id: 3, error: { code: McpErrorCode.InvalidParams, message: 'bad', data: { field: 'x' } } },
    ]);
  });

  it('maps a non-McpError throw to InternalError with the error message', async () => {
    const t = new ArrayTransport();
    t.setHandlers({
      onRequest: async () => {
        throw new TypeError('handler blew up');
      },
    });
    t.exposeRoute({ id: 4, method: 'sampling/createMessage' });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.sent).toEqual([
      { jsonrpc: '2.0', id: 4, error: { code: McpErrorCode.InternalError, message: 'handler blew up' } },
    ]);
  });

  it('stringifies a thrown non-Error rather than sending an empty message', async () => {
    const t = new ArrayTransport();
    t.setHandlers({
      onRequest: async () => {
        throw 'just a string';
      },
    });
    t.exposeRoute({ id: 5, method: 'sampling/createMessage' });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.sent).toEqual([
      { jsonrpc: '2.0', id: 5, error: { code: McpErrorCode.InternalError, message: 'just a string' } },
    ]);
  });
});

describe('BaseJsonRpcTransport: failAll', () => {
  it('rejects every in-flight request and ends every subscription with the same error', async () => {
    const t = new ArrayTransport();
    const a = t.exposeRequest('tools/list', 10_000);
    const b = t.exposeRequest('tools/call', 10_000);
    const ends: unknown[] = [];
    await t.sendLongLivedRequest('subscriptions/listen', {}, (e) => ends.push(e));
    await t.sendLongLivedRequest('subscriptions/listen', {}, (e) => ends.push(e));

    const err = new McpError({ code: McpErrorCode.ConnectionClosed, message: 'MCP ws closed' });
    t.exposeFailAll(err);

    await expect(a.promise).rejects.toThrow('MCP ws closed');
    await expect(b.promise).rejects.toThrow('MCP ws closed');
    // A subscription that survives its connection is a handle to a stream that will never deliver
    // again and never says so.
    expect(ends).toEqual([err, err]);
    expect(t.pendingCount).toBe(0);
    expect(t.longLivedCount).toBe(0);
  });

  it('is idempotent — a second failAll settles nothing twice', async () => {
    const t = new ArrayTransport();
    const { promise } = t.exposeRequest('tools/list', 10_000);
    const ends: unknown[] = [];
    await t.sendLongLivedRequest('subscriptions/listen', {}, (e) => ends.push(e));
    t.exposeFailAll(new McpError({ code: McpErrorCode.ConnectionClosed, message: 'first' }));
    t.exposeFailAll(new McpError({ code: McpErrorCode.ConnectionClosed, message: 'second' }));
    await expect(promise).rejects.toThrow('first');
    expect(ends).toHaveLength(1);
  });
});
