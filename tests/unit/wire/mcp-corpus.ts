/** The corpus for the MCP Streamable-HTTP transport.
 *
 *  MCP is not a provider API, but it is still networking: a JSON-RPC envelope, a
 *  set of headers whose presence depends on the negotiated era, and five distinct
 *  requests (POST call, POST notification, POST long-lived stream, GET event
 *  stream, DELETE session). All of it was assembled by hand.
 *
 *  The era matters more here than anywhere else in the library. `Mcp-Method` and
 *  `Mcp-Name` are sent only on the 2026-07-28 wire, and a modern server rejects a
 *  request whose `Mcp-Method` disagrees with its body — while the public server the
 *  live example reaches is handshake-era, so the modern headers are exactly the
 *  part no live run covers. They are frozen here instead.
 */

import { HttpTransport } from '../../../src/plugins/mcp/transport-http';
import type { SSEEvent } from '../../../src/network/types';

export const MCP_URL = 'https://mcp.example.com/mcp';
export const SESSION_ID = 'sess-abc123';
export const MODERN_VERSION = '2026-07-28';
export const HANDSHAKE_VERSION = '2025-11-25';

export type McpOp = 'request' | 'notify' | 'close' | 'listen' | 'longLived';

export interface McpCase {
  name: string;
  op: McpOp;
  method?: string;
  params?: unknown;
  /** Which wire the transport thinks it is on. */
  era?: 'handshake' | 'modern';
  protocolVersion?: string;
  /** Hand back an `mcp-session-id` on the first response, so the NEXT request
   *  carries it. This is how a session actually starts. */
  withSession?: boolean;
  /** Static headers the caller configured on the server entry. */
  configHeaders?: Record<string, string>;
  /** A resolved OAuth bearer, as `getAuthHeaders()` would return it. */
  authHeaders?: Record<string, string>;
  /** listen/longLived: emit one event carrying an id, so the resumption GET fires. */
  emitEventId?: string;
}

export const MCP_CASES: McpCase[] = [
  // ── handshake era: what every server on the wire today speaks ──────────────
  { name: 'request.bare', op: 'request', method: 'tools/list' },
  {
    name: 'request.versioned',
    op: 'request',
    method: 'tools/list',
    protocolVersion: HANDSHAKE_VERSION,
  },
  {
    // The session id arrives on a response header and must appear on the NEXT
    // request — on the handshake wire only.
    name: 'request.session',
    op: 'request',
    method: 'tools/call',
    params: { name: 'search', arguments: { q: 'hi' } },
    protocolVersion: HANDSHAKE_VERSION,
    withSession: true,
  },
  {
    name: 'request.configuredHeaders',
    op: 'request',
    method: 'tools/list',
    configHeaders: { 'x-tenant': 'acme', accept: 'application/json' },
    authHeaders: { authorization: 'Bearer tok-1' },
  },
  { name: 'notify.noParams', op: 'notify', method: 'notifications/initialized' },
  { name: 'notify.params', op: 'notify', method: 'notifications/cancelled', params: { requestId: 7 } },
  { name: 'close.session', op: 'close', withSession: true, protocolVersion: HANDSHAKE_VERSION },
  { name: 'listen.events', op: 'listen' },
  { name: 'listen.resume', op: 'listen', emitEventId: 'ev-42' },

  // ── modern era: the routing headers no live server exercises ───────────────
  {
    name: 'request.modern',
    op: 'request',
    method: 'tools/list',
    era: 'modern',
    protocolVersion: MODERN_VERSION,
  },
  {
    // `Mcp-Name` carries the method's SUBJECT, read from a different param per
    // method: `name` for tools/call and prompts/get, `uri` for resources/read.
    name: 'request.modern.toolName',
    op: 'request',
    method: 'tools/call',
    params: { name: 'search', arguments: { q: 'hi' } },
    era: 'modern',
    protocolVersion: MODERN_VERSION,
  },
  {
    name: 'request.modern.promptName',
    op: 'request',
    method: 'prompts/get',
    params: { name: 'summarise' },
    era: 'modern',
    protocolVersion: MODERN_VERSION,
  },
  {
    name: 'request.modern.resourceUri',
    op: 'request',
    method: 'resources/read',
    params: { uri: 'file:///readme.md' },
    era: 'modern',
    protocolVersion: MODERN_VERSION,
  },
  {
    // A header value must be ASCII. A tool name that is not gets percent-encoded
    // rather than emitted as a header the runtime rejects.
    name: 'request.modern.nonAsciiName',
    op: 'request',
    method: 'tools/call',
    params: { name: 'поиск', arguments: {} },
    era: 'modern',
    protocolVersion: MODERN_VERSION,
  },
  {
    // Era is set only AFTER discovery succeeds, so the probe itself is judged by
    // the version it declares. Keying on era alone left it half-modern.
    name: 'request.modernByVersionOnly',
    op: 'request',
    method: 'server/discover',
    protocolVersion: MODERN_VERSION,
  },
  {
    // The stateless 2026 wire has no session to identify: sending a stale id
    // invites a header/body mismatch (-32020).
    name: 'request.modern.noSessionEcho',
    op: 'request',
    method: 'tools/list',
    era: 'modern',
    protocolVersion: MODERN_VERSION,
    withSession: true,
  },
  { name: 'notify.modern', op: 'notify', method: 'notifications/initialized', era: 'modern', protocolVersion: MODERN_VERSION },
  {
    name: 'longLived.subscribe',
    op: 'longLived',
    method: 'subscriptions/listen',
    params: { filter: { toolsListChanged: true } },
    era: 'modern',
    protocolVersion: MODERN_VERSION,
  },
  {
    name: 'longLived.resume',
    op: 'longLived',
    method: 'subscriptions/listen',
    params: { filter: { toolsListChanged: true } },
    era: 'modern',
    protocolVersion: MODERN_VERSION,
    emitEventId: 'ev-7',
  },
];

/** How long to wait for a background resumption attempt. The two paths back off
 *  differently — the long-lived POST retries after 500ms, the GET event loop after
 *  1000ms — so this clears the slower of the two. Only the cases that ask for an
 *  event id pay it. */
const RESUME_WAIT_MS = 1400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run one case against capturing transports and return every request it made. */
export async function driveMcp(c: McpCase): Promise<unknown[]> {
  const seen: unknown[] = [];

  const fetch = (async (req: unknown) => {
    seen.push(req);
    return {
      status: 200,
      headers: {
        'content-type': 'application/json',
        ...(c.withSession ? { 'mcp-session-id': SESSION_ID } : {}),
      },
      // Answer the JSON-RPC id the transport just allocated, so `request()` settles
      // instead of throwing before the next call is made.
      body: JSON.stringify({ jsonrpc: '2.0', id: (req as { body?: { id?: number } }).body?.id ?? 0, result: {} }),
    };
  }) as never;

  const fetchStream = ((req: unknown) => {
    seen.push(req);
    return (async function* (): AsyncGenerator<SSEEvent> {
      if (c.emitEventId) yield { id: c.emitEventId, data: '' } as SSEEvent;
    })();
  }) as never;

  const transport = new HttpTransport(
    { url: MCP_URL, name: 'example', headers: c.configHeaders },
    {
      fetch,
      fetchStream,
      ...(c.authHeaders ? { getAuthHeaders: async () => c.authHeaders! } : {}),
    },
  );

  if (c.protocolVersion) transport.setProtocolVersion(c.protocolVersion);
  if (c.era) transport.setEra(c.era);

  // A session id only exists after a response carried one, so the cases that want
  // one make a throwaway call first and freeze only what came after it.
  if (c.withSession && c.op !== 'listen') {
    await transport.request('ping');
    seen.length = 0;
  }

  try {
    switch (c.op) {
      case 'request':
        await transport.request(c.method!, c.params);
        break;
      case 'notify':
        await transport.notify(c.method!, c.params);
        break;
      case 'close':
        await transport.close();
        break;
      case 'listen':
        transport.listen();
        await sleep(c.emitEventId ? RESUME_WAIT_MS : 50);
        break;
      case 'longLived':
        await transport.sendLongLivedRequest(c.method!, c.params);
        await sleep(c.emitEventId ? RESUME_WAIT_MS : 50);
        break;
    }
  } catch {
    /* a fake response may not satisfy the caller; the requests are already captured */
  }
  await transport.close().catch(() => {});
  return seen;
}

export const mcpKey = (c: McpCase, i: number): string => `mcp/${c.op}.${c.name}${i ? `.${i}` : ''}`;
