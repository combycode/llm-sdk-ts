/** `McpClient`'s method surface: resources, prompts, logging, completion, tasks, keep-alive and
 *  manual cache invalidation.
 *
 *  Everything runs against a scripted in-memory transport — no socket, no process. The point is to
 *  pin WHAT goes on the wire for each call (method name and params) and which era a method belongs
 *  to, because those are exactly the details a port re-derives from scratch. */

import { describe, expect, it } from 'bun:test';
import { McpClient } from '../../../../src/plugins/mcp/client';
import { McpError, McpErrorCode } from '../../../../src/plugins/mcp/jsonrpc';
import { MCP_PROTOCOL_VERSION_META_KEY } from '../../../../src/plugins/mcp/protocol-version';
import type { IncomingMcpHandlers, McpTransport } from '../../../../src/plugins/mcp/transport';
import { isHttpConfig } from '../../../../src/plugins/mcp/types';
import type { McpTask } from '../../../../src/plugins/mcp/types';

/** A transport whose answers come from a routing table; every call is recorded. */
class ScriptedTransport implements McpTransport {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly notifications: string[] = [];
  handlers: IncomingMcpHandlers = {};
  closed = 0;
  era: string | null = null;

  constructor(private readonly routes: Record<string, (params: unknown) => unknown> = {}) {}

  async start(): Promise<void> {}
  setHandlers(h: IncomingMcpHandlers): void {
    this.handlers = h;
  }
  setProtocolVersion(): void {}
  setEra(era: 'handshake' | 'modern'): void {
    this.era = era;
  }
  listen(): void {}
  async notify(method: string): Promise<void> {
    this.notifications.push(method);
  }
  async close(): Promise<void> {
    this.closed++;
  }
  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    const route = this.routes[method];
    if (!route) throw new McpError({ code: McpErrorCode.MethodNotFound, message: `no route: ${method}` });
    return route(params);
  }
  paramsOf(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }
  countOf(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

const HANDSHAKE_INIT = {
  initialize: () => ({ protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } }),
};

/** A connected handshake-era client (protocolMode 'legacy' skips the modern probe). */
async function legacyClient(routes: Record<string, (params: unknown) => unknown>, opts = {}) {
  const t = new ScriptedTransport({ ...HANDSHAKE_INIT, ...routes });
  const client = new McpClient(t, { protocolMode: 'legacy', ...opts });
  await client.connect();
  return { t, client };
}

/** A connected 2026-07-28 client. */
async function modernClient(routes: Record<string, (params: unknown) => unknown>, opts = {}) {
  const t = new ScriptedTransport({
    'server/discover': () => ({ capabilities: {}, supportedVersions: ['2026-07-28'], _meta: {} }),
    ...routes,
  });
  const client = new McpClient(t, { protocolMode: '2026-07-28', ...opts });
  await client.connect();
  return { t, client };
}

describe('McpClient: resources', () => {
  it('listResources follows cursor pagination and concatenates the pages', async () => {
    const { client, t } = await legacyClient({
      'resources/list': (p) =>
        (p as { cursor?: string })?.cursor === 'p2'
          ? { resources: [{ uri: 'file:///b' }] }
          : { resources: [{ uri: 'file:///a' }], nextCursor: 'p2' },
    });
    expect((await client.listResources()).map((r) => r.uri)).toEqual(['file:///a', 'file:///b']);
    expect(t.paramsOf('resources/list')).toEqual([{}, { cursor: 'p2' }]);
  });

  it('listResourceTemplates reads the `resourceTemplates` field, not `resources`', async () => {
    // The field name differs from the method name; reading the wrong one silently returns [].
    const { client } = await legacyClient({
      'resources/templates/list': () => ({ resourceTemplates: [{ uriTemplate: 'file:///{path}' }] }),
    });
    expect(await client.listResourceTemplates()).toEqual([{ uriTemplate: 'file:///{path}' }]);
  });

  it('readResource sends the uri and returns `contents`', async () => {
    const { client, t } = await legacyClient({
      'resources/read': () => ({ contents: [{ uri: 'file:///a', text: 'body' }] }),
    });
    expect(await client.readResource('file:///a')).toEqual([{ uri: 'file:///a', text: 'body' }]);
    expect(t.paramsOf('resources/read')).toEqual([{ uri: 'file:///a' }]);
  });

  it('readResource returns [] when the server answers without contents', async () => {
    const { client } = await legacyClient({ 'resources/read': () => ({}) });
    expect(await client.readResource('file:///a')).toEqual([]);
  });

  it('readResource drives an input_required result to a terminal one, echoing requestState', async () => {
    // MRTR applies to reads too, not only tool calls. The `requestState` is the server's sealed
    // continuation token and must come back byte-exact.
    let leg = 0;
    const t = new ScriptedTransport({
      ...HANDSHAKE_INIT,
      'resources/read': () => {
        leg++;
        return leg === 1
          ? {
              resultType: 'input_required',
              requestState: 'opaque-token-123',
              inputRequests: { q1: { method: 'roots/list', params: {} } },
            }
          : { contents: [{ uri: 'file:///a', text: 'after auth' }] };
      },
    });
    const seen: string[] = [];
    const client = new McpClient(t, {
      protocolMode: 'legacy',
      onServerRequest: async (method) => {
        seen.push(method);
        return { roots: [] };
      },
    });
    await client.connect();

    expect(await client.readResource('file:///a')).toEqual([{ uri: 'file:///a', text: 'after auth' }]);
    expect(seen).toEqual(['roots/list']);
    const second = t.paramsOf('resources/read').at(-1) as Record<string, unknown>;
    expect(second.requestState).toBe('opaque-token-123');
    expect(second.inputResponses).toEqual({ q1: { roots: [] } });
  });

  it('subscribeResource / unsubscribeResource send the per-resource methods on the handshake wire', async () => {
    const { client, t } = await legacyClient({
      'resources/subscribe': () => ({}),
      'resources/unsubscribe': () => ({}),
    });
    await client.subscribeResource('file:///a');
    await client.unsubscribeResource('file:///a');
    expect(t.paramsOf('resources/subscribe')).toEqual([{ uri: 'file:///a' }]);
    expect(t.paramsOf('resources/unsubscribe')).toEqual([{ uri: 'file:///a' }]);
  });

  it('subscribeResource is refused on a 2026-07-28 session, naming the replacement', async () => {
    // 2026-07-28 removed per-resource subscription. A bare -32601 from the server would leave the
    // caller with no idea the method existed on the other wire.
    const { client, t } = await modernClient({});
    await expect(client.subscribeResource('file:///a')).rejects.toThrow(/subscriptions\/listen/);
    await expect(client.unsubscribeResource('file:///a')).rejects.toThrow(/2026-07-28/);
    expect(t.countOf('resources/subscribe')).toBe(0); // nothing reached the wire
  });
});

describe('McpClient: prompts, logging and completion', () => {
  it('listPrompts follows pagination', async () => {
    const { client } = await legacyClient({
      'prompts/list': (p) =>
        (p as { cursor?: string })?.cursor === 'n'
          ? { prompts: [{ name: 'second' }] }
          : { prompts: [{ name: 'first' }], nextCursor: 'n' },
    });
    expect((await client.listPrompts()).map((p) => p.name)).toEqual(['first', 'second']);
  });

  it('setLogLevel sends logging/setLevel on the handshake wire', async () => {
    const { client, t } = await legacyClient({ 'logging/setLevel': () => ({}) });
    await client.setLogLevel('debug');
    expect(t.paramsOf('logging/setLevel')).toEqual([{ level: 'debug' }]);
  });

  it('setLogLevel throws on a 2026-07-28 session instead of silently doing nothing', async () => {
    // A caller who asked for debug logging and got none would have no way to tell.
    const { client, t } = await modernClient({});
    await expect(client.setLogLevel('debug')).rejects.toThrow(/logging\/setLevel/);
    expect(t.countOf('logging/setLevel')).toBe(0);
  });

  it('completeArgument unwraps the `completion` envelope', async () => {
    const { client, t } = await legacyClient({
      'completion/complete': () => ({ completion: { values: ['alpha', 'alps'], total: 2, hasMore: false } }),
    });
    const res = await client.completeArgument({ type: 'ref/prompt', name: 'p' }, { name: 'city', value: 'al' });
    expect(res.values).toEqual(['alpha', 'alps']);
    expect(t.paramsOf('completion/complete')).toEqual([
      { ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'city', value: 'al' } },
    ]);
  });

  it('completeArgument returns an empty value list when the server sends no completion', async () => {
    // Callers index into `.values`; an undefined result would throw at the call site instead of
    // reading as "no suggestions".
    const { client } = await legacyClient({ 'completion/complete': () => ({}) });
    expect(await client.completeArgument({ type: 'ref/prompt', name: 'p' }, { name: 'a', value: '' })).toEqual({
      values: [],
    });
  });
});

describe('McpClient: tasks', () => {
  const task = (over: Partial<McpTask> = {}): McpTask => ({
    taskId: 't1',
    status: 'working',
    ttl: null,
    createdAt: '2026-01-01T00:00:00Z',
    lastUpdatedAt: '2026-01-01T00:00:00Z',
    ...over,
  });

  it('callToolTask sends the task metadata alongside the call and unwraps the task', async () => {
    const { client, t } = await legacyClient({ 'tools/call': () => ({ task: task() }) });
    expect(await client.callToolTask('slow', { a: 1 }, { ttl: 60_000 })).toEqual(task());
    expect(t.paramsOf('tools/call')).toEqual([{ name: 'slow', arguments: { a: 1 }, task: { ttl: 60_000 } }]);
  });

  it('getTask / getTaskResult / cancelTask each address the task by id', async () => {
    const { client, t } = await legacyClient({
      'tasks/get': () => task({ status: 'completed' }),
      'tasks/result': () => ({ content: [{ type: 'text', text: 'done' }] }),
      'tasks/cancel': () => ({}),
    });
    expect((await client.getTask('t1')).status).toBe('completed');
    expect(await client.getTaskResult('t1')).toEqual({ content: [{ type: 'text', text: 'done' }] });
    await client.cancelTask('t1');
    expect(t.paramsOf('tasks/get')).toEqual([{ taskId: 't1' }]);
    expect(t.paramsOf('tasks/result')).toEqual([{ taskId: 't1' }]);
    expect(t.paramsOf('tasks/cancel')).toEqual([{ taskId: 't1' }]);
  });

  it('listTasks paginates like every other list', async () => {
    const { client } = await legacyClient({
      'tasks/list': (p) =>
        (p as { cursor?: string })?.cursor === 'c2'
          ? { tasks: [task({ taskId: 't2' })] }
          : { tasks: [task()], nextCursor: 'c2' },
    });
    expect((await client.listTasks()).map((x) => x.taskId)).toEqual(['t1', 't2']);
  });

  it('awaitTask polls until the task reaches a terminal status', async () => {
    let n = 0;
    const { client, t } = await legacyClient({
      'tasks/get': () => {
        n++;
        return n < 3 ? task({ pollInterval: 1 }) : task({ status: 'completed' });
      },
    });
    expect((await client.awaitTask('t1', { pollIntervalMs: 1 })).status).toBe('completed');
    expect(t.countOf('tasks/get')).toBe(3);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('awaitTask stops on a %s task', async (status) => {
    // `failed` and `cancelled` are terminal too — polling them forever would hang the caller on a
    // task that is never coming back.
    const { client, t } = await legacyClient({ 'tasks/get': () => task({ status }) });
    expect((await client.awaitTask('t1', { pollIntervalMs: 1 })).status).toBe(status);
    expect(t.countOf('tasks/get')).toBe(1);
  });

  it('awaitTask gives up with RequestTimeout rather than polling forever', async () => {
    const { client } = await legacyClient({ 'tasks/get': () => task({ status: 'working', pollInterval: 1 }) });
    const err = (await client.awaitTask('t1', { pollIntervalMs: 1, timeoutMs: 5 }).catch((e) => e)) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(McpErrorCode.RequestTimeout);
    expect(err.message).toContain('t1');
  });
});

describe('McpClient: request escape hatch', () => {
  it('sends an arbitrary method with its params untouched on the handshake wire', async () => {
    const { client, t } = await legacyClient({ 'x/custom': () => ({ ok: 1 }) });
    expect(await client.request('x/custom', { a: 1 })).toEqual({ ok: 1 });
    expect(t.paramsOf('x/custom')).toEqual([{ a: 1 }]);
  });

  it('carries the modern identity envelope like every other request', async () => {
    // At 2026-07-28 a request without `_meta` is rejected with -32602. The escape hatch must not
    // be the one call that forgets it.
    const { client, t } = await modernClient({ 'x/custom': () => ({ ok: 1 }) });
    await client.request('x/custom', { a: 1 });
    const params = t.paramsOf('x/custom')[0] as { a: number; _meta: Record<string, unknown> };
    expect(params.a).toBe(1);
    expect(params._meta[MCP_PROTOCOL_VERSION_META_KEY]).toBe('2026-07-28');
  });
});

describe('McpClient: keep-alive', () => {
  it('pings on an interval while the handshake session is open, and stops on close()', async () => {
    const { client, t } = await legacyClient({ ping: () => ({}) }, { keepAliveMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    const during = t.countOf('ping');
    expect(during).toBeGreaterThan(0);

    await client.close();
    expect(t.closed).toBe(1);
    const after = t.countOf('ping');
    await new Promise((r) => setTimeout(r, 20));
    expect(t.countOf('ping')).toBe(after); // the timer really was cleared
  });

  it('swallows a failing ping instead of producing an unhandled rejection', async () => {
    const { client, t } = await legacyClient({}, { keepAliveMs: 5 }); // no `ping` route -> throws
    await new Promise((r) => setTimeout(r, 20));
    expect(t.countOf('ping')).toBeGreaterThan(0);
    await client.close();
  });

  it('is ignored on a 2026-07-28 session, where `ping` no longer exists', async () => {
    // Starting a keep-alive there would send a method the server has every right to reject.
    const { client, t } = await modernClient({}, { keepAliveMs: 5 });
    await new Promise((r) => setTimeout(r, 25));
    expect(t.countOf('ping')).toBe(0);
    await client.close();
  });

  it('close() without a keep-alive still closes the transport', async () => {
    const { client, t } = await legacyClient({});
    await client.close();
    expect(t.closed).toBe(1);
  });
});

describe('McpClient: manual cache invalidation', () => {
  const cachedRoutes = {
    'tools/list': () => ({ tools: [{ name: 'a', inputSchema: {} }], ttlMs: 60_000 }),
    'prompts/list': () => ({ prompts: [{ name: 'p' }], ttlMs: 60_000 }),
  };

  it('invalidateCache(method) drops only that method, leaving the others cached', async () => {
    const { client, t } = await legacyClient(cachedRoutes, { cacheResults: true });
    await client.listTools();
    await client.listPrompts();
    expect(t.countOf('tools/list')).toBe(1);

    client.invalidateCache('tools/list');
    await client.listTools();
    await client.listPrompts();

    expect(t.countOf('tools/list')).toBe(2); // refetched
    expect(t.countOf('prompts/list')).toBe(1); // untouched
  });

  it('invalidateCache() with no argument drops everything', async () => {
    const { client, t } = await legacyClient(cachedRoutes, { cacheResults: true });
    await client.listTools();
    await client.listPrompts();

    client.invalidateCache();
    await client.listTools();
    await client.listPrompts();

    expect(t.countOf('tools/list')).toBe(2);
    expect(t.countOf('prompts/list')).toBe(2);
  });

  it('is a harmless no-op when caching was never enabled', async () => {
    const { client, t } = await legacyClient(cachedRoutes);
    await client.listTools();
    expect(() => client.invalidateCache()).not.toThrow();
    expect(() => client.invalidateCache('tools/list')).not.toThrow();
    await client.listTools();
    expect(t.countOf('tools/list')).toBe(2); // nothing was cached in the first place
  });
});

describe('isHttpConfig', () => {
  it('discriminates on the presence of a string `url`', () => {
    expect(isHttpConfig({ url: 'https://mcp.example.com/rpc' })).toBe(true);
    expect(isHttpConfig({ command: 'my-server', args: [] })).toBe(false);
  });

  it('a non-string url is not an HTTP config', () => {
    // Otherwise a malformed config would be routed to the HTTP transport and fail deep inside
    // URL parsing rather than at the boundary.
    expect(isHttpConfig({ url: 123 } as never)).toBe(false);
    expect(isHttpConfig({ url: undefined, command: 'x' } as never)).toBe(false);
  });
});
