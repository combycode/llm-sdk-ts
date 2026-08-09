/** `subscriptions/listen` over Streamable HTTP.
 *
 *  The listen POST is not an ordinary call: the server holds the RESPONSE BODY open and writes
 *  notification frames into it, closing only when the subscription ends. It therefore goes through
 *  the streaming fetch rather than the buffered POST path — with the buffered path the frames would
 *  surface only after the stream closed, i.e. never for a healthy subscription. */

import { describe, expect, it } from 'bun:test';
import { HttpTransport } from '../../../../src/plugins/mcp/transport-http';
import { McpClient } from '../../../../src/plugins/mcp/client';
import { MCP_SUBSCRIPTION_ID_META_KEY } from '../../../../src/plugins/mcp/protocol-version';
import type { McpServerEvent } from '../../../../src/plugins/mcp/subscriptions';
import type { SSEEvent } from '../../../../src/network/types';

/** A streaming fetch under test control: frames are pushed in, the stream ends on demand. */
function makeStreamFetch() {
  const seen: Array<{ method?: string; headers: Record<string, string>; body: unknown }> = [];
  let push!: (ev: SSEEvent) => void;
  let end!: (err?: unknown) => void;
  const queue: SSEEvent[] = [];
  let resolveNext: (() => void) | null = null;
  let finished: { error?: unknown } | null = null;

  push = (ev) => {
    queue.push(ev);
    resolveNext?.();
    resolveNext = null;
  };
  end = (err) => {
    finished = { error: err };
    resolveNext?.();
    resolveNext = null;
  };

  const fetchStream = ((req: {
    method?: string;
    headers: Record<string, string>;
    body: unknown;
    signal?: AbortSignal;
  }) => {
    seen.push({ method: req.method, headers: req.headers, body: req.body });
    // A real streaming fetch stops when the caller aborts — the harness has to as well, or a
    // teardown test passes/fails for the wrong reason.
    req.signal?.addEventListener('abort', () => end());
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift() as SSEEvent;
          if (finished) {
            if (finished.error) throw finished.error;
            return;
          }
          await new Promise<void>((r) => {
            resolveNext = r;
          });
        }
      },
    };
  }) as never;

  return { fetchStream, seen, push, end };
}

const deps = (fetchStream: never) =>
  ({
    fetch: (() => Promise.resolve({ status: 200, headers: {}, body: {}, text: '{}' })) as never,
    fetchStream,
  }) as never;

describe('subscriptions/listen over Streamable HTTP', () => {
  it('opens a streaming POST, not a buffered one, and delivers frames as they arrive', async () => {
    const { fetchStream, seen, push } = makeStreamFetch();
    const transport = new HttpTransport({ url: 'https://mcp.example.com/rpc' }, deps(fetchStream));
    transport.setEra('modern');

    const notifications: Array<{ method: string; params: unknown }> = [];
    transport.setHandlers({
      onNotification: (method, params) => notifications.push({ method, params }),
    });

    const id = await transport.sendLongLivedRequest('subscriptions/listen', {
      notifications: { toolsListChanged: true },
    });

    // The request went out as a streaming POST carrying the JSON-RPC body...
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    // BOTH media types: `text/event-stream` alone is 406 Not Acceptable on a modern server.
    expect(seen[0]?.headers.accept).toBe('application/json, text/event-stream');
    expect((seen[0]?.body as { method: string }).method).toBe('subscriptions/listen');
    // ...and the modern routing header rides along.
    expect(seen[0]?.headers['mcp-method']).toBe('subscriptions/listen');
    expect(typeof id).toBe('number');

    // A frame arriving mid-stream is routed immediately — the point of the whole exercise.
    push({ data: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} }) });
    await new Promise((r) => setTimeout(r, 5));

    expect(notifications).toEqual([{ method: 'notifications/tools/list_changed', params: {} }]);
  });

  it('reports a clean end-of-stream through onEnd', async () => {
    const { fetchStream, end } = makeStreamFetch();
    const transport = new HttpTransport({ url: 'https://mcp.example.com/rpc' }, deps(fetchStream));
    transport.setEra('modern');

    let ended = false;
    let endError: unknown = 'unset';
    await transport.sendLongLivedRequest('subscriptions/listen', {}, (err) => {
      ended = true;
      endError = err;
    });

    end();
    await new Promise((r) => setTimeout(r, 5));

    expect(ended).toBe(true);
    expect(endError).toBeUndefined();
  });

  it('reports a rejected or dropped stream through onEnd instead of swallowing it', async () => {
    const { fetchStream, end } = makeStreamFetch();
    const transport = new HttpTransport({ url: 'https://mcp.example.com/rpc' }, deps(fetchStream));
    transport.setEra('modern');

    let endError: unknown;
    await transport.sendLongLivedRequest('subscriptions/listen', {}, (err) => {
      endError = err;
    });

    end(new Error('403 subscription refused'));
    await new Promise((r) => setTimeout(r, 5));

    // A subscription that silently stopped delivering is the failure mode this prevents.
    expect((endError as Error)?.message).toBe('403 subscription refused');
  });

  it('drives a full McpClient.listen over HTTP, end to end', async () => {
    const { fetchStream, push } = makeStreamFetch();
    const transport = new HttpTransport({ url: 'https://mcp.example.com/rpc' }, deps(fetchStream));
    // Pretend negotiation already settled on the modern wire.
    transport.setEra('modern');
    transport.setProtocolVersion('2026-07-28');

    const client = new McpClient(transport, { protocolMode: '2026-07-28' });
    // connect() would issue a real discover through the buffered path; install the era directly.
    (client as unknown as { negotiatedVersion: string }).negotiatedVersion = '2026-07-28';
    transport.setHandlers({
      onNotification: (m, p) => {
        for (const sub of (client as unknown as { subscriptions: Map<unknown, { handleFrame(m: string, p: unknown): boolean }> }).subscriptions.values()) {
          sub.handleFrame(m, p);
        }
      },
    });

    const events: McpServerEvent[] = [];
    const sub = await client.listen({ resourceSubscriptions: ['file:///a'] }, (e) => events.push(e));

    push({
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: { uri: 'file:///a', _meta: { [MCP_SUBSCRIPTION_ID_META_KEY]: sub.id } },
      }),
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(events).toEqual([{ type: 'resource_updated', uri: 'file:///a' }]);
    expect(sub.active).toBe(true);
  });

  it('marks the subscription ended when the stream dies', async () => {
    const { fetchStream, end } = makeStreamFetch();
    const transport = new HttpTransport({ url: 'https://mcp.example.com/rpc' }, deps(fetchStream));
    transport.setEra('modern');

    const client = new McpClient(transport, { protocolMode: '2026-07-28' });
    (client as unknown as { negotiatedVersion: string }).negotiatedVersion = '2026-07-28';

    const sub = await client.listen({ toolsListChanged: true }, () => {});
    expect(sub.active).toBe(true);

    end(new Error('connection reset'));
    await new Promise((r) => setTimeout(r, 5));

    // Otherwise the caller holds a handle to a stream that will never deliver again.
    expect(sub.active).toBe(false);
    expect((sub.ended?.error as Error)?.message).toBe('connection reset');
  });

  it('tears the stream down on close()', async () => {
    const { fetchStream } = makeStreamFetch();
    const transport = new HttpTransport({ url: 'https://mcp.example.com/rpc' }, deps(fetchStream));
    transport.setEra('modern');

    let ended = false;
    await transport.sendLongLivedRequest('subscriptions/listen', {}, () => {
      ended = true;
    });

    await transport.close();
    await new Promise((r) => setTimeout(r, 5));

    // Without this the POST would hang until the server gave up on it.
    expect(ended).toBe(true);
  });
});

// ─── what the modern HTTP wire requires of us ─────────────────────────────────

import { MCP_METHOD_HEADER, MCP_PROTOCOL_VERSION_HEADER } from '../../../../src/plugins/mcp/protocol-version';

/** Three HTTP-only rules, each found against a real mcp-py 2.0.0 Streamable HTTP server
 *  (2026-08-09) and each invisible over stdio, which has no headers and a duplex pipe. */
describe('modern Streamable HTTP request shape', () => {
  function transportWithCapture() {
    const posts: Array<{ headers: Record<string, string>; body: unknown }> = [];
    const streams: Array<{ headers: Record<string, string>; body: unknown }> = [];
    const transport = new HttpTransport(
      { url: 'https://example.test/mcp', name: 's' },
      {
        fetch: async (req: { headers: Record<string, string>; body: unknown }) => {
          posts.push({ headers: req.headers, body: req.body });
          const msg = req.body as { id: number; method: string };
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { capabilities: {}, supportedVersions: ['2026-07-28'], resultType: 'complete' },
            }),
          };
        },
        fetchStream: ((req: { headers: Record<string, string>; body: unknown }) => {
          streams.push({ headers: req.headers, body: req.body });
          return (async function* () {})();
        }) as never,
        timeoutMs: 1000,
      } as never,
    );
    return { transport, posts, streams };
  }

  it('sends MCP-Protocol-Version and a matching Mcp-Method on the discover PROBE', async () => {
    // A modern server routes by the version header; without it the probe lands on the
    // legacy handler and is refused with "400 Missing session ID". And the modern handler
    // rejects a request whose Mcp-Method does not match the body — a MISSING one included.
    const { transport, posts } = transportWithCapture();
    const client = new McpClient(transport, {});
    await client.connect();

    const probe = posts.find(
      (p) => (p.body as { method?: string }).method === 'server/discover',
    );
    expect(probe).toBeDefined();
    expect(probe?.headers[MCP_PROTOCOL_VERSION_HEADER]).toBe('2026-07-28');
    expect(probe?.headers[MCP_METHOD_HEADER]).toBe('server/discover');
  });

  it('accepts BOTH media types on the long-lived listen POST', async () => {
    // `text/event-stream` alone gets 406 Not Acceptable with an empty body, so the
    // subscription is dead before it starts and listen() returns a stream that can never
    // deliver.
    const { transport, streams } = transportWithCapture();
    const client = new McpClient(transport, {});
    await client.connect();
    await client.listen({ toolsListChanged: true }, () => {});

    const listen = streams.find(
      (s2) => (s2.body as { method?: string } | undefined)?.method === 'subscriptions/listen',
    );
    expect(listen).toBeDefined();
    const accept = listen?.headers.accept ?? listen?.headers.Accept;
    expect(accept).toContain('text/event-stream');
    expect(accept).toContain('application/json');
    expect(listen?.headers[MCP_METHOD_HEADER]).toBe('subscriptions/listen');
  });
});

// ─── resumption after a dropped stream ────────────────────────────────────────

/** A stream that ends on its own is a DROP, not a close: the client never asked for it,
 *  so it must reconnect and ask the server to replay from the last id it saw. Verified
 *  against a real replaying mcp-py server: closing the stream, firing changes, and
 *  reopening with `last-event-id` returns exactly the missed events. */
describe('Last-Event-ID resumption', () => {
  function transportWithStreams(streams: Array<Array<{ id?: string; data?: string }>>) {
    const requests: Array<{ method?: string; headers: Record<string, string>; body: unknown }> = [];
    let n = 0;
    const transport = new HttpTransport(
      { url: 'https://example.test/mcp', name: 's' },
      {
        fetch: async (req: { body: unknown }) => {
          const msg = req.body as { id: number };
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { capabilities: {}, supportedVersions: ['2026-07-28'], resultType: 'complete' },
            }),
          };
        },
        fetchStream: ((req: { method?: string; headers: Record<string, string>; body: unknown }) => {
          requests.push({ method: req.method, headers: req.headers, body: req.body });
          const frames = streams[n++] ?? [];
          return (async function* () {
            for (const f of frames) yield f;
          })();
        }) as never,
        timeoutMs: 1000,
      } as never,
    );
    return { transport, requests };
  }

  const note = (m: string) => ({ id: undefined, data: JSON.stringify({ jsonrpc: '2.0', method: m }) });
  const withId = (id: string, m: string) => ({ id, data: JSON.stringify({ jsonrpc: '2.0', method: m }) });

  it('reconnects the GET stream with the last id and delivers the replay', async () => {
    const { transport, requests } = transportWithStreams([
      [withId('1', 'notifications/one'), withId('2', 'notifications/two')], // then drops
      [withId('3', 'notifications/three')], // the replay
      [],
    ]);
    const routed: string[] = [];
    transport.setHandlers({ onRequest: async () => ({}), onNotification: (m) => void routed.push(m) });

    transport.listen();
    await new Promise((r) => setTimeout(r, 3000));
    await transport.close();

    const gets = requests.filter((r) => r.method === 'GET');
    expect(gets.length).toBeGreaterThanOrEqual(2);
    expect(gets[0].headers['last-event-id']).toBeUndefined();
    expect(gets[1].headers['last-event-id']).toBe('2'); // resumes from the last id seen
    expect(routed).toContain('notifications/three'); // and the replay reaches the caller
  });

  it('resumes a dropped subscriptions/listen stream too', async () => {
    // The long-lived POST is the ONLY notification channel on the 2026-07-28 wire, so a
    // blip that ends it permanently would silently stop all change delivery.
    const { transport, requests } = transportWithStreams([
      [withId('10', 'notifications/tools/list_changed')], // listen POST, then drops
      [withId('11', 'notifications/resources/updated')], // replay on reconnect
      [],
    ]);
    const routed: string[] = [];
    transport.setHandlers({ onRequest: async () => ({}), onNotification: (m) => void routed.push(m) });

    await transport.sendLongLivedRequest('subscriptions/listen', { notifications: {} });
    await new Promise((r) => setTimeout(r, 3000));
    await transport.close();

    const resumeGet = requests.find((r) => r.method === 'GET' && r.headers['last-event-id'] === '10');
    expect(resumeGet).toBeDefined();
    expect(routed).toContain('notifications/resources/updated');
  });

  // NOT unit-tested: exhausting the retry budget takes ~15s of real backoff, too slow for
  // this suite. The `finally` in sendLongLivedRequest fires `onEnd` on every path, so the
  // caller is always settled; the give-up branch itself is covered by inspection.

  void note;
});
