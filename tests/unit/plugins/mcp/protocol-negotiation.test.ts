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

// ─── the per-request identity envelope ────────────────────────────────────────

describe('modern-era `_meta` identity on every request', () => {
  const modernRoutes = (): Record<string, Responder> => ({
    'server/discover': () => modernDiscover(),
    'tools/list': () => ({ tools: [{ name: 'add', inputSchema: {} }] }),
    'tools/call': () => ({ content: [{ type: 'text', text: '42' }] }),
  });

  /** At 2026-07-28 there is no handshake and no session id, so identity travels per
   *  request. Only `server/discover` used to build the envelope, so every later call was
   *  rejected by a real server:
   *
   *    -32602 params._meta must be an object carrying the required
   *           'io.modelcontextprotocol/protocolVersion' and
   *           'io.modelcontextprotocol/clientCapabilities' envelope keys
   *
   *  No public 2026-07-28 server exists, so this was invisible until mcp-py 2.0.0 was run
   *  over stdio (2026-08-09). */
  it('stamps version + capabilities on requests made AFTER discovery', async () => {
    const t = new FakeTransport(modernRoutes());
    const client = new McpClient(t, { capabilities: { sampling: {} } });
    await client.connect();
    await client.listTools();
    await client.callTool('add', { a: 2, b: 40 });

    const after = t.calls.filter((c) => c.method !== 'server/discover');
    expect(after.length).toBeGreaterThan(0);
    for (const call of after) {
      const meta = (call.params as { _meta?: Record<string, unknown> })._meta;
      expect(meta?.['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
      expect(meta?.['io.modelcontextprotocol/clientCapabilities']).toEqual({ sampling: {} });
    }
  });

  it('keeps the real params alongside the envelope', async () => {
    const t = new FakeTransport(modernRoutes());
    const client = new McpClient(t, {});
    await client.connect();
    await client.callTool('add', { a: 1 });

    const call = t.calls.find((c) => c.method === 'tools/call');
    expect((call?.params as { name?: string }).name).toBe('add');
    expect((call?.params as { arguments?: unknown }).arguments).toEqual({ a: 1 });
  });

  it('sends NO envelope on a handshake session', async () => {
    // An older server can legitimately reject unknown `_meta`, and identity there lives in
    // `initialize` — so the legacy wire must stay byte-identical to pre-2.0.
    const t = new FakeTransport({ ...legacyRoutes(), 'tools/list': () => ({ tools: [] }) });
    const client = new McpClient(t, { protocolMode: 'legacy' });
    await client.connect();
    await client.listTools();

    const list = t.calls.find((c) => c.method === 'tools/list');
    expect((list?.params as { _meta?: unknown })?._meta).toBeUndefined();
  });
});

// ─── the long-lived path needs the envelope too ───────────────────────────────

describe('subscriptions/listen carries the identity envelope', () => {
  /** `listen()` goes through `sendLongLivedRequest`, which bypassed the request funnel.
   *  The server answered -32602, and because the rejection arrives as the STREAM'S END
   *  rather than a thrown error, `listen()` returned a subscription that looked alive and
   *  delivered nothing — a silent no-op. Caught against mcp-py 2.0.0 (2026-08-09). */
  it('stamps version + capabilities on the long-lived request', async () => {
    const t = new FakeTransport({ 'server/discover': () => modernDiscover() });
    let sentParams: unknown;
    (t as unknown as { sendLongLivedRequest: unknown }).sendLongLivedRequest = async (
      _m: string,
      params: unknown,
    ) => {
      sentParams = params;
      return 7;
    };

    const client = new McpClient(t, { capabilities: { elicitation: {} } });
    await client.connect();
    await client.listen({ toolsListChanged: true }, () => {});

    const meta = (sentParams as { _meta?: Record<string, unknown> })._meta;
    expect(meta?.['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
    expect(meta?.['io.modelcontextprotocol/clientCapabilities']).toEqual({ elicitation: {} });
    // …without losing the filter itself.
    expect((sentParams as { notifications?: unknown }).notifications).toEqual({
      toolsListChanged: true,
    });
  });
});

// ─── the probe header cuts both ways ──────────────────────────────────────────

describe('HTTP 4xx to the probe means "legacy server", not "outage"', () => {
  class RejectingTransport extends FakeTransport {
    constructor(
      private readonly probeError: unknown,
      routes: Record<string, Responder>,
    ) {
      super(routes);
    }
    override async request(method: string, params?: unknown): Promise<unknown> {
      if (method === 'server/discover') {
        this.calls.push({ method, params });
        throw this.probeError;
      }
      return super.request(method, params);
    }
  }

  /** The probe must carry `MCP-Protocol-Version: 2026-07-28` or a modern HTTP server routes
   *  it to the legacy handler. A 2025-era server answers that same header with a plain HTTP
   *  400 before any JSON-RPC exists — so one probe cannot satisfy both, and the 400 has to be
   *  read as evidence. Live: DeepWiki replies "400 Unsupported protocol version: 2026-07-28.
   *  Supported versions: …2025-11-25". */
  it('falls back to the handshake on a 4xx', async () => {
    const t = new RejectingTransport(
      Object.assign(new Error('Bad Request: Unsupported protocol version: 2026-07-28'), { status: 400 }),
      legacyRoutes(),
    );
    const client = new McpClient(t, {});
    const info = await client.connect();

    expect(client.era).toBe('handshake');
    expect(info.serverInfo.name).toBe('legacy-server');
    expect(t.methods()).toEqual(['server/discover', 'initialize']);
  });

  it('rethrows a 5xx instead of downgrading the wire', async () => {
    // E4: a transient is not a verdict. Silently dropping to the legacy protocol because a
    // gateway blipped would be the worst possible failure mode.
    const t = new RejectingTransport(
      Object.assign(new Error('Bad Gateway'), { status: 502 }),
      legacyRoutes(),
    );
    await expect(new McpClient(t, {}).connect()).rejects.toThrow(/Bad Gateway/);
  });

  it('rethrows a network error with no status', async () => {
    const t = new RejectingTransport(new Error('socket hang up'), legacyRoutes());
    await expect(new McpClient(t, {}).connect()).rejects.toThrow(/socket hang up/);
  });
});
