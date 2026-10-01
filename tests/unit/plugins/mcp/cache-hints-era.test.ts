/** Cache hints a server sends from a protocol revision later than its own.
 *
 *  `ttlMs` / `cacheScope` arrived with 2026-07-28, so a 2025-11-25 session sending
 *  them is describing itself with a later revision's vocabulary. The row behind this
 *  suggested ignoring them there, for consistency with the dual-era rule. They are
 *  HONOURED, because the two mistakes do not cost the same:
 *
 *   - ignoring them silently disables a cache the operator explicitly opted into
 *     (`cacheResults: true`), against a server that asked for it in as many words;
 *   - honouring an extra field a server volunteered risks nothing. Contrast
 *     keep-alive `ping`, which IS suppressed on a modern session — SENDING a method
 *     the era lacks can be rejected, which is a different hazard.
 *
 *  So the non-conformance is reported instead of acted on, once per session. Silence
 *  was the only outcome worth avoiding.
 *
 *  (Upstream additionally era-scopes its cache keys, so an entry written under one
 *  era is never served under another. Deliberately NOT copied: see
 *  `McpClient.cacheKeyFor` — the hazard is unreachable here, and the first attempt at
 *  the guard silently broke invalidation.)
 */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import { McpClient } from '../../../../src/plugins/mcp/client';
import { McpError, McpErrorCode } from '../../../../src/plugins/mcp/jsonrpc';
import type { IncomingMcpHandlers, McpTransport } from '../../../../src/plugins/mcp/transport';

const HINTS = { ttlMs: 60_000 };

// ─── through the client ─────────────────────────────────────────────────────

/** Minimal scripted transport, same shape as the one in `client-api.test.ts`. */
class Scripted implements McpTransport {
  readonly calls: string[] = [];
  handlers: IncomingMcpHandlers = {};
  constructor(private readonly routes: Record<string, (p: unknown) => unknown>) {}
  async start(): Promise<void> {}
  setHandlers(h: IncomingMcpHandlers): void {
    this.handlers = h;
  }
  setProtocolVersion(): void {}
  setEra(): void {}
  listen(): void {}
  async notify(): Promise<void> {}
  async close(): Promise<void> {}
  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push(method);
    const route = this.routes[method];
    if (!route) {
      throw new McpError({ code: McpErrorCode.MethodNotFound, message: `no route: ${method}` });
    }
    return route(params);
  }
  countOf(method: string): number {
    return this.calls.filter((m) => m === method).length;
  }
}

const HINTED_LIST = {
  'tools/list': () => ({ tools: [{ name: 'a', inputSchema: {} }], ttlMs: 60_000 }),
};
const HANDSHAKE = {
  initialize: () => ({
    protocolVersion: '2025-11-25',
    capabilities: {},
    serverInfo: { name: 's', version: '1' },
  }),
};
const DISCOVER = {
  'server/discover': () => ({ capabilities: {}, supportedVersions: ['2026-07-28'], _meta: {} }),
};

async function connected(
  era: 'legacy' | '2026-07-28',
  routes: Record<string, (p: unknown) => unknown>,
) {
  const hooks = new HookBus();
  const warnings: Array<Record<string, unknown>> = [];
  hooks.on('onWarning', (w) => {
    warnings.push(w as unknown as Record<string, unknown>);
  });
  const t = new Scripted({ ...(era === 'legacy' ? HANDSHAKE : DISCOVER), ...routes });
  const client = new McpClient(t, {
    protocolMode: era,
    cacheResults: true,
    hooks,
    server: 'test',
  } as never);
  await client.connect();
  return { client, t, warnings };
}

describe('the client scopes its own keys by era', () => {
  it('caches a list, so a second call does not refetch', async () => {
    // The baseline the era-scoping must not break: without it this test cannot tell
    // a working cache from a key nobody can look up.
    const { client, t } = await connected('2026-07-28', HINTED_LIST);
    await client.listTools();
    await client.listTools();
    expect(t.countOf('tools/list')).toBe(1);
  });

  it('still invalidates on the matching notification', async () => {
    // The half the era prefix nearly broke, now asserted through the client rather
    // than against the cache class alone.
    const { client, t } = await connected('2026-07-28', HINTED_LIST);
    await client.listTools();
    client.invalidateCache('tools/list');
    await client.listTools();
    expect(t.countOf('tools/list')).toBe(2);
  });
});

describe('cache hints from a later revision', () => {
  it('are HONOURED on a 2025-11-25 session', async () => {
    // Ignoring them would silently disable a cache the operator opted into, against
    // a server that asked for it in as many words.
    const { client, t } = await connected('legacy', HINTED_LIST);
    await client.listTools();
    await client.listTools();
    expect(t.countOf('tools/list')).toBe(1);
  });

  it('and REPORTED, so the non-conformance is not silent', async () => {
    const { client, warnings } = await connected('legacy', HINTED_LIST);
    await client.listTools();
    const w = warnings.find((x) => x.code === 'mcp_hint_before_era');
    expect(w).toBeDefined();
    expect(w?.details).toMatchObject({ protocolVersion: '2025-11-25', era: 'handshake' });
  });

  it('are reported once per session, not once per call', async () => {
    // A cached list would otherwise warn on every call, which trains a reader to
    // filter the channel.
    const { client, warnings } = await connected('legacy', HINTED_LIST);
    await client.listTools();
    client.invalidateCache('tools/list');
    await client.listTools();
    expect(warnings.filter((w) => w.code === 'mcp_hint_before_era')).toHaveLength(1);
  });

  it('say nothing on a modern session, where the fields belong', async () => {
    const { client, warnings } = await connected('2026-07-28', HINTED_LIST);
    await client.listTools();
    expect(warnings.filter((w) => w.code === 'mcp_hint_before_era')).toHaveLength(0);
  });

  it('say nothing on a legacy session that sends no hints', async () => {
    const { client, warnings } = await connected('legacy', {
      'tools/list': () => ({ tools: [{ name: 'a', inputSchema: {} }] }),
    });
    await client.listTools();
    expect(warnings.filter((w) => w.code === 'mcp_hint_before_era')).toHaveLength(0);
  });
});
