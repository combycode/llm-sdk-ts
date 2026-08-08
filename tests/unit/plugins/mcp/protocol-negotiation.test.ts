/** MCP dual-era negotiation (2025-11-25 handshake ↔ 2026-07-28 modern).
 *
 *  The whole point is that BOTH wires keep working: real servers overwhelmingly still speak
 *  2025-11-25, so every path that is not positive evidence of a modern server must land back on the
 *  handshake, byte-identical to pre-2.0 behaviour. The one exception is a server that speaks only
 *  modern versions we do not share — a real incompatibility that must surface, not be papered over.
 *
 *  Algorithm mirrors mcp-py 2.0.0 `client/_probe.py`. */

import { describe, expect, it } from 'bun:test';
import { McpClient } from '../../../../src/plugins/mcp/client';
import { McpError, McpErrorCode } from '../../../../src/plugins/mcp/jsonrpc';
import type { IncomingMcpHandlers, McpTransport } from '../../../../src/plugins/mcp/transport';
import { MCP_SERVER_INFO_META_KEY } from '../../../../src/plugins/mcp/protocol-version';

type Responder = (params: unknown) => unknown;

class FakeTransport implements McpTransport {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly notifications: string[] = [];
  protocolVersion: string | null = null;
  era: 'handshake' | 'modern' | null = null;
  listened = false;

  constructor(private readonly routes: Record<string, Responder>) {}

  async start(): Promise<void> {}
  setHandlers(_h: IncomingMcpHandlers): void {}
  setProtocolVersion(v: string): void {
    this.protocolVersion = v;
  }
  setEra(e: 'handshake' | 'modern'): void {
    this.era = e;
  }
  listen(): void {
    this.listened = true;
  }
  async close(): Promise<void> {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    const route = this.routes[method];
    if (!route) {
      throw new McpError({ code: McpErrorCode.MethodNotFound, message: `no route for ${method}` });
    }
    const out = route(params);
    if (out instanceof Error) throw out;
    return out;
  }

  async notify(method: string): Promise<void> {
    this.notifications.push(method);
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

const INITIALIZE_RESULT = {
  protocolVersion: '2025-11-25',
  capabilities: { tools: {} },
  serverInfo: { name: 'legacy-server', version: '1.2.3' },
};

const legacyRoutes = (): Record<string, Responder> => ({
  initialize: () => INITIALIZE_RESULT,
});

const modernDiscover = (over: Record<string, unknown> = {}) => ({
  capabilities: { tools: {} },
  supportedVersions: ['2025-11-25', '2026-07-28'],
  ttlMs: 60_000,
  cacheScope: 'private',
  resultType: 'complete',
  _meta: { [MCP_SERVER_INFO_META_KEY]: { name: 'modern-server', version: '2.0.0' } },
  ...over,
});

const unsupported = (supported: string[]) =>
  new McpError({
    code: McpErrorCode.UnsupportedProtocolVersion,
    message: 'unsupported protocol version',
    data: { supported },
  });

// ─── explicit modes ───────────────────────────────────────────────────────────

describe("protocolMode: 'legacy'", () => {
  it('runs the handshake and never probes', async () => {
    const t = new FakeTransport(legacyRoutes());
    const client = new McpClient(t, { protocolMode: 'legacy' });
    const info = await client.connect();

    expect(t.methods()).toEqual(['initialize']);
    expect(t.notifications).toEqual(['notifications/initialized']);
    expect(client.era).toBe('handshake');
    expect(client.protocolVersion).toBe('2025-11-25');
    expect(info.serverInfo.name).toBe('legacy-server');
  });
});

describe('protocolMode: a pinned modern version', () => {
  it('adopts it with a single discover and no handshake', async () => {
    const t = new FakeTransport({ 'server/discover': () => modernDiscover() });
    const client = new McpClient(t, { protocolMode: '2026-07-28' });
    await client.connect();

    expect(t.methods()).toEqual(['server/discover']);
    expect(client.era).toBe('modern');
    expect(t.era).toBe('modern');
  });
});

// ─── auto: the modern path ────────────────────────────────────────────────────

describe("protocolMode: 'auto' — modern server", () => {
  it('adopts modern and synthesises an initialize-shaped result', async () => {
    const t = new FakeTransport({ 'server/discover': () => modernDiscover() });
    const client = new McpClient(t, {});
    const info = await client.connect();

    expect(client.era).toBe('modern');
    expect(client.protocolVersion).toBe('2026-07-28');
    // R2: the caller reads the same shape regardless of which wire was negotiated.
    expect(info.protocolVersion).toBe('2026-07-28');
    expect(info.serverInfo.name).toBe('modern-server');
    expect(info.capabilities).toEqual({ tools: {} });
    expect(client.discoverResult?.ttlMs).toBe(60_000);
    expect(t.notifications).toEqual([]); // no notifications/initialized on the modern wire
  });

  it('sends the required _meta identity on the probe', async () => {
    const t = new FakeTransport({ 'server/discover': () => modernDiscover() });
    await new McpClient(t, { capabilities: { sampling: {} } }).connect();

    const meta = (t.calls[0]?.params as { _meta: Record<string, unknown> })._meta;
    expect(meta['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
    expect(meta['io.modelcontextprotocol/clientCapabilities']).toEqual({ sampling: {} });
    expect(meta['io.modelcontextprotocol/clientInfo']).toBeDefined();
  });

  it('degrades to a placeholder identity when the serverInfo stamp is missing', async () => {
    const t = new FakeTransport({ 'server/discover': () => modernDiscover({ _meta: {} }) });
    const client = new McpClient(t, {});
    const info = await client.connect();
    // Display-only per spec: a missing or malformed stamp must not fail the connection.
    expect(info.serverInfo.name).toBe('unknown');
    expect(info.serverInfo.version).toBe('0.0.0');
    expect(client.era).toBe('modern');
  });

  it('degrades the same way when the stamp is malformed rather than absent', async () => {
    const t = new FakeTransport({
      'server/discover': () =>
        modernDiscover({ _meta: { [MCP_SERVER_INFO_META_KEY]: 'not-an-object' } }),
    });
    const info = await new McpClient(t, {}).connect();
    expect(info.serverInfo.name).toBe('unknown');
  });
});

// ─── auto: every fallback path ────────────────────────────────────────────────

describe("protocolMode: 'auto' — falls back to the handshake", () => {
  it('when the server does not know server/discover (the common legacy case)', async () => {
    const t = new FakeTransport(legacyRoutes()); // no discover route → MethodNotFound
    const client = new McpClient(t, {});
    await client.connect();

    expect(t.methods()).toEqual(['server/discover', 'initialize']);
    expect(client.era).toBe('handshake');
    expect(t.notifications).toEqual(['notifications/initialized']);
  });

  it('when discover answers but advertises no modern version', async () => {
    const t = new FakeTransport({
      'server/discover': () => modernDiscover({ supportedVersions: ['2025-11-25'] }),
      ...legacyRoutes(),
    });
    const client = new McpClient(t, {});
    await client.connect();

    expect(client.era).toBe('handshake');
    expect(t.methods()).toContain('initialize');
  });

  it('when -32022 lists handshake versions', async () => {
    const t = new FakeTransport({
      'server/discover': () => unsupported(['2025-06-18', '2025-11-25']),
      ...legacyRoutes(),
    });
    const client = new McpClient(t, {});
    await client.connect();
    expect(client.era).toBe('handshake');
  });

  it('on any other JSON-RPC error (denylist, not allowlist)', async () => {
    const t = new FakeTransport({
      'server/discover': () => new McpError({ code: McpErrorCode.InvalidRequest, message: 'nope' }),
      ...legacyRoutes(),
    });
    await new McpClient(t, {}).connect();
    expect(t.methods()).toEqual(['server/discover', 'initialize']);
  });
});

// ─── auto: the cases that must NOT fall back ──────────────────────────────────

describe("protocolMode: 'auto' — refuses to guess", () => {
  it('propagates a transport/network error instead of downgrading the wire', async () => {
    const t = new FakeTransport({
      'server/discover': () => new TypeError('socket hang up'),
      ...legacyRoutes(),
    });
    // An outage is not an era verdict — silently dropping to the legacy wire because a socket
    // blipped would be the worst possible failure mode.
    await expect(new McpClient(t, {}).connect()).rejects.toThrow('socket hang up');
    expect(t.methods()).toEqual(['server/discover']);
  });

  it('surfaces a modern-only server that shares no version with us', async () => {
    const t = new FakeTransport({
      'server/discover': () => unsupported(['2027-01-01']),
      ...legacyRoutes(),
    });
    await expect(new McpClient(t, {}).connect()).rejects.toThrow(/unsupported protocol version/i);
  });
});

// ─── auto: the corrective re-probe ────────────────────────────────────────────

describe("protocolMode: 'auto' — the corrective re-probe", () => {
  it('re-probes when the HANDSHAKE is answered with -32022 naming a modern version', async () => {
    // The documented race: our probe timed out client-side but landed on a slow-starting server,
    // which locked the connection modern before the fallback `initialize` arrived. The handshake's
    // -32022 is itself modern evidence, so one re-probe settles it instead of failing the connect.
    let probes = 0;
    const t = new FakeTransport({
      'server/discover': () => {
        probes++;
        if (probes === 1) return new McpError({ code: McpErrorCode.RequestTimeout, message: 'timed out' });
        return modernDiscover();
      },
      initialize: () => unsupported(['2026-07-28']),
    });

    const client = new McpClient(t, {});
    await client.connect();

    expect(t.methods()).toEqual(['server/discover', 'initialize', 'server/discover']);
    expect(probes).toBe(2);
    expect(client.era).toBe('modern');
  });

  it('gives up rather than looping when the handshake -32022 names nothing we speak', async () => {
    const t = new FakeTransport({
      'server/discover': () => new McpError({ code: McpErrorCode.RequestTimeout, message: 'timed out' }),
      initialize: () => unsupported(['1999-01-01']),
    });
    await expect(new McpClient(t, {}).connect()).rejects.toThrow(/unsupported protocol version/i);
  });
});

// ─── era gating of the methods 2026-07-28 removed ─────────────────────────────

describe('methods removed at 2026-07-28', () => {
  it('setLogLevel and subscribeResource throw on a modern session, naming the replacement', async () => {
    const t = new FakeTransport({ 'server/discover': () => modernDiscover() });
    const client = new McpClient(t, {});
    await client.connect();

    await expect(client.setLogLevel('debug')).rejects.toThrow(/does not exist at protocol version/);
    await expect(client.subscribeResource('file:///x')).rejects.toThrow(/subscriptions\/listen/);
    // Never reached the wire.
    expect(t.methods()).toEqual(['server/discover']);
  });

  it('both still work on a handshake session', async () => {
    const t = new FakeTransport({
      ...legacyRoutes(),
      'logging/setLevel': () => ({}),
      'resources/subscribe': () => ({}),
    });
    const client = new McpClient(t, { protocolMode: 'legacy' });
    await client.connect();

    await client.setLogLevel('debug');
    await client.subscribeResource('file:///x');
    expect(t.methods()).toEqual(['initialize', 'logging/setLevel', 'resources/subscribe']);
  });

  it('does not start the ping keep-alive on a modern session', async () => {
    const modern = new FakeTransport({ 'server/discover': () => modernDiscover() });
    const client = new McpClient(modern, { keepAliveMs: 1 });
    await client.connect();
    await new Promise((r) => setTimeout(r, 20));
    await client.close();
    // `ping` does not exist at 2026-07-28 — a keep-alive would send a method the server may reject.
    expect(modern.methods()).toEqual(['server/discover']);
  });
});
