/** `subscriptions/listen` (SEP-2575) and the `ttlMs` / `cacheScope` result hints (2026-07-28).
 *
 *  Both are opt-in and both must be invisible to a pre-2026 server: caching stores nothing without
 *  a hint, and `listen` is refused outright on a handshake session rather than silently doing
 *  nothing. */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { McpClient } from '../../../../src/plugins/mcp/client';
import type { IncomingMcpHandlers, McpTransport } from '../../../../src/plugins/mcp/transport';
import { McpResultCache } from '../../../../src/plugins/mcp/result-cache';
import {
  MCP_SUBSCRIPTIONS_ACKNOWLEDGED,
  type McpServerEvent,
} from '../../../../src/plugins/mcp/subscriptions';
import { MCP_SUBSCRIPTION_ID_META_KEY } from '../../../../src/plugins/mcp/protocol-version';

class DuplexTransport implements McpTransport {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly longLived: Array<{ method: string; params: unknown }> = [];
  private handlers: IncomingMcpHandlers = {};
  private nextId = 100;

  constructor(private readonly routes: Record<string, (params: unknown) => unknown> = {}) {}

  async start(): Promise<void> {}
  setHandlers(h: IncomingMcpHandlers): void {
    this.handlers = h;
  }
  setProtocolVersion(): void {}
  setEra(): void {}
  async notify(): Promise<void> {}
  async close(): Promise<void> {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'server/discover') {
      return { capabilities: {}, supportedVersions: ['2026-07-28'], resultType: 'complete', _meta: {} };
    }
    const route = this.routes[method];
    if (!route) throw new Error(`no route: ${method}`);
    return route(params);
  }

  async sendLongLivedRequest(method: string, params?: unknown): Promise<number> {
    this.longLived.push({ method, params });
    return this.nextId++;
  }

  /** Simulate a server-pushed frame. */
  emit(method: string, params: unknown): void {
    this.handlers.onNotification?.(method, params);
  }

  countOf(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

const stamped = (id: number, extra: Record<string, unknown> = {}) => ({
  _meta: { [MCP_SUBSCRIPTION_ID_META_KEY]: id },
  ...extra,
});

// ─── the cache primitive ──────────────────────────────────────────────────────

describe('McpResultCache', () => {
  it('stores nothing without a ttl hint (every pre-2026 server)', () => {
    const c = new McpResultCache();
    expect(c.set('k', [1], undefined)).toBe(false);
    expect(c.set('k', [1], {})).toBe(false);
    expect(c.size).toBe(0);
  });

  it('treats ttlMs: 0 as "immediately stale", not as a missing value', () => {
    const c = new McpResultCache();
    expect(c.set('k', [1], { ttlMs: 0 })).toBe(false);
    expect(c.get('k')).toBeUndefined();
  });

  it('expires an entry once its ttl has elapsed', () => {
    const c = new McpResultCache();
    c.set('k', [1], { ttlMs: 1000 }, 0);
    expect(c.get('k', 999)).toEqual([1]);
    expect(c.get('k', 1000)).toBeUndefined();
  });

  it('clears by method prefix without touching other methods', () => {
    const c = new McpResultCache();
    c.set(McpResultCache.key('resources/read', { uri: 'a' }), ['a'], { ttlMs: 9999 });
    c.set('tools/list', ['t'], { ttlMs: 9999 });
    c.clearMethod('resources/read');
    expect(c.get('tools/list')).toEqual(['t']);
    expect(c.size).toBe(1);
  });
});

// ─── caching through the client ───────────────────────────────────────────────

describe('cacheResults', () => {
  it('is off by default — every list hits the wire', async () => {
    const t = new DuplexTransport({ 'tools/list': () => ({ tools: [{ name: 'a' }], ttlMs: 60_000 }) });
    const client = new McpClient(t, {});
    await client.connect();
    await client.listTools();
    await client.listTools();
    expect(t.countOf('tools/list')).toBe(2);
  });

  it('reuses a hinted result when enabled', async () => {
    const t = new DuplexTransport({ 'tools/list': () => ({ tools: [{ name: 'a' }], ttlMs: 60_000 }) });
    const client = new McpClient(t, { cacheResults: true });
    await client.connect();
    expect(await client.listTools()).toEqual(await client.listTools());
    expect(t.countOf('tools/list')).toBe(1);
  });

  it('still hits the wire when the server sends no hints', async () => {
    const t = new DuplexTransport({ 'tools/list': () => ({ tools: [{ name: 'a' }] }) });
    const client = new McpClient(t, { cacheResults: true });
    await client.connect();
    await client.listTools();
    await client.listTools();
    expect(t.countOf('tools/list')).toBe(2);
  });

  it('drops the cached list when the server says it changed', async () => {
    const t = new DuplexTransport({ 'tools/list': () => ({ tools: [{ name: 'a' }], ttlMs: 60_000 }) });
    const client = new McpClient(t, { cacheResults: true });
    await client.connect();
    await client.listTools();
    t.emit('notifications/tools/list_changed', {});
    await client.listTools();
    // A cache that outlives the server's own "this changed" notice is worse than no cache.
    expect(t.countOf('tools/list')).toBe(2);
  });

  it('invalidates only the resource that was updated', async () => {
    const t = new DuplexTransport({
      'resources/read': (p) => ({ contents: [{ uri: (p as { uri: string }).uri }], ttlMs: 60_000 }),
    });
    const client = new McpClient(t, { cacheResults: true });
    await client.connect();
    await client.readResource('file:///a');
    await client.readResource('file:///b');
    t.emit('notifications/resources/updated', { uri: 'file:///a' });
    await client.readResource('file:///a');
    await client.readResource('file:///b'); // still cached
    expect(t.countOf('resources/read')).toBe(3);
  });
});

// ─── subscriptions/listen ─────────────────────────────────────────────────────

describe('subscriptions/listen', () => {
  it('is refused on a handshake session, naming the replacement', async () => {
    const legacy = new DuplexTransport({
      initialize: () => ({ protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } }),
    });
    const client = new McpClient(legacy, { protocolMode: 'legacy' });
    await client.connect();
    await expect(client.listen({ toolsListChanged: true }, () => {})).rejects.toThrow(
      /requires protocol version 2026-07-28/,
    );
  });

  it('sends the opt-in filter and delivers matching events', async () => {
    const t = new DuplexTransport();
    const client = new McpClient(t, {});
    await client.connect();

    const seen: McpServerEvent[] = [];
    const sub = await client.listen({ toolsListChanged: true, resourceSubscriptions: ['file:///a'] }, (e) =>
      seen.push(e),
    );

    // The filter goes out under `notifications`, alongside the modern `_meta` identity
    // envelope every 2026-07-28 request carries (a real server rejects it without one).
    expect(t.longLived[0].method).toBe('subscriptions/listen');
    const listenParams = t.longLived[0].params as {
      notifications?: unknown;
      _meta?: Record<string, unknown>;
    };
    expect(listenParams.notifications).toEqual({
      toolsListChanged: true,
      resourceSubscriptions: ['file:///a'],
    });
    expect(listenParams._meta?.['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');

    t.emit('notifications/tools/list_changed', stamped(sub.id as number));
    t.emit('notifications/resources/updated', stamped(sub.id as number, { uri: 'file:///a' }));

    expect(seen).toEqual([{ type: 'tools_list_changed' }, { type: 'resource_updated', uri: 'file:///a' }]);
  });

  it('ignores frames stamped for a different subscription', async () => {
    const t = new DuplexTransport();
    const client = new McpClient(t, {});
    await client.connect();
    const seen: McpServerEvent[] = [];
    const sub = await client.listen({ toolsListChanged: true }, (e) => seen.push(e));

    t.emit('notifications/tools/list_changed', stamped((sub.id as number) + 999));
    expect(seen).toEqual([]);
  });

  it('records the honoured subset, which can be narrower than requested', async () => {
    const t = new DuplexTransport();
    const client = new McpClient(t, {});
    await client.connect();
    const sub = await client.listen({ toolsListChanged: true, promptsListChanged: true }, () => {});

    expect(sub.honored).toBeNull(); // nothing assumed before the ack

    t.emit(MCP_SUBSCRIPTIONS_ACKNOWLEDGED, stamped(sub.id as number, {
      notifications: { toolsListChanged: true },
    }));

    // Asking is not receiving: the server granted tools only.
    expect(sub.isHonored('toolsListChanged')).toBe(true);
    expect(sub.isHonored('promptsListChanged')).toBe(false);
  });

  it('stops delivering after close()', async () => {
    const t = new DuplexTransport();
    const client = new McpClient(t, {});
    await client.connect();
    const seen: McpServerEvent[] = [];
    const sub = await client.listen({ toolsListChanged: true }, (e) => seen.push(e));

    sub.close();
    t.emit('notifications/tools/list_changed', stamped(sub.id as number));
    expect(seen).toEqual([]);
  });
});

// ─── connectMcp must actually forward the options it documents ────────────────

import { connectMcp } from '../../../../src/helpers/mcp';

describe('connectMcp option forwarding', () => {
  /** `cacheResults` and `inputRequiredMaxRounds` existed on McpClient but were never
   *  passed through connectMcp — the documented entry point — so opting in was a silent
   *  no-op. Proven by counting wire frames against a real mcp-py 2.0.0 server: 3
   *  listTools() calls produced 3 requests with caching "on", and 0 after the fix. */
  it('passes cacheResults and inputRequiredMaxRounds to the client', () => {
    const src = readFileSync(
      new URL('../../../../src/helpers/mcp.ts', import.meta.url),
      'utf8',
    );
    const ctor = src.slice(src.indexOf('new McpClient('), src.indexOf('new McpClient(') + 900);
    expect(ctor).toContain('cacheResults: opts.cacheResults');
    expect(ctor).toContain('inputRequiredMaxRounds: opts.inputRequiredMaxRounds');
    // And the options must be declarable, or callers cannot reach them in TypeScript.
    expect(src).toMatch(/cacheResults\?: boolean/);
    expect(src).toMatch(/inputRequiredMaxRounds\?: number/);
    expect(typeof connectMcp).toBe('function');
  });
});
