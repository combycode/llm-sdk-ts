/** A session the server has forgotten is rebuilt, not reported as dead.
 *
 *  A stateful MCP server answers 404 to a session id it no longer holds — it
 *  restarted, evicted the session, or let it expire. We turned that into
 *  `ConnectionClosed`, and since the id is held for the life of the transport,
 *  every subsequent request failed exactly the same way. The connection was
 *  fine; only the session was gone, and nothing tried to get a new one.
 *
 *  Three conditions before recovering, each there to avoid making things worse:
 *
 *  - a session id must be HELD. A 404 without one is an ordinary wrong URL, and
 *    re-initializing against it turns one clear error into two confusing ones.
 *  - the id is dropped BEFORE re-initializing, so the new handshake does not
 *    present the dead one.
 *  - it does not recurse. Re-initializing goes back through this transport, and
 *    a 404 on that must not try to recover again.
 */

import { describe, expect, it } from 'bun:test';
import { HttpTransport } from '../../../../src/plugins/mcp/transport-http';

type Step = { status: number; sessionId?: string };

/** A transport whose fetch answers from a script, recording what it was asked. */
function scripted(steps: Step[], opts: { recover?: () => Promise<boolean> } = {}) {
  const sent: Array<{ session?: string }> = [];
  const queue = [...steps];
  const fetch = (async (req: { headers?: Record<string, string>; body?: { id?: number } }) => {
    sent.push({ session: req.headers?.['mcp-session-id'] });
    const step = queue.shift() ?? { status: 200 };
    return {
      status: step.status,
      headers: {
        'content-type': 'application/json',
        ...(step.sessionId ? { 'mcp-session-id': step.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: req.body?.id ?? 0, result: { ok: true } }),
    };
  }) as never;

  const transport = new HttpTransport(
    { url: 'https://a.test/mcp', name: 's' },
    { fetch, fetchStream: (() => (async function* () {})()) as never } as never,
  );
  if (opts.recover) transport.setOnSessionLost(opts.recover);
  return { transport, sent };
}

/** Give the transport a session id the way a real server does: in a response. */
async function withSession(t: ReturnType<typeof scripted>) {
  await t.transport.request('tools/list');
  return t;
}

describe('a 404 while holding a session id', () => {
  it('re-initializes and replays the request', async () => {
    let recovered = 0;
    const t = scripted(
      [
        { status: 200, sessionId: 'sess-1' }, // first call establishes the session
        { status: 404 }, // the server forgot it
        { status: 200, sessionId: 'sess-2' }, // the replay, on a new session
      ],
      {
        recover: async () => {
          recovered++;
          return true;
        },
      },
    );
    await withSession(t);
    await t.transport.request('tools/list');

    expect(recovered).toBe(1);
    // Three calls: the original, the one that 404'd, and the replay.
    expect(t.sent).toHaveLength(3);
    // The replay does NOT carry the dead id — it was dropped before recovery.
    expect(t.sent[2]?.session).toBeUndefined();
  });

  it('does not recover when no session is held', async () => {
    // An ordinary 404: wrong URL. Re-initializing would add a second failure to
    // a perfectly clear first one.
    let recovered = 0;
    const t = scripted([{ status: 404 }], {
      recover: async () => {
        recovered++;
        return true;
      },
    });
    await t.transport.request('tools/list').catch(() => undefined);
    expect(recovered).toBe(0);
    expect(t.sent).toHaveLength(1);
  });

  it('surfaces the original error when recovery fails', async () => {
    // The 404 is the better error to report; a failed recovery must not replace
    // it with its own.
    const t = scripted([{ status: 200, sessionId: 'sess-1' }, { status: 404 }], {
      recover: async () => false,
    });
    await withSession(t);
    await expect(t.transport.request('tools/list')).rejects.toThrow();
    expect(t.sent).toHaveLength(2);
  });

  it('recovers at most once per request', async () => {
    let recovered = 0;
    const t = scripted(
      [{ status: 200, sessionId: 'sess-1' }, { status: 404 }, { status: 404 }],
      {
        recover: async () => {
          recovered++;
          return true;
        },
      },
    );
    await withSession(t);
    await t.transport.request('tools/list').catch(() => undefined);
    expect(recovered).toBe(1);
  });

  it('does nothing at all when no recovery was installed', async () => {
    // stdio has no sessions; a transport without the hook behaves as before.
    const t = scripted([{ status: 200, sessionId: 'sess-1' }, { status: 404 }]);
    await withSession(t);
    await expect(t.transport.request('tools/list')).rejects.toThrow();
    expect(t.sent).toHaveLength(2);
  });
});

describe('the version we tell a server', () => {
  it('is the library version, not a placeholder', async () => {
    // Was `1.0.0`, hard-coded, for every release — so every MCP server we ever
    // spoke to was told the wrong client version.
    const { SDK_VERSION } = await import('../../../../src/version');
    const sent: Array<Record<string, unknown>> = [];
    const fetch = (async (req: { body?: { id?: number; params?: Record<string, unknown> } }) => {
      if (req.body?.params) sent.push(req.body.params);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: req.body?.id ?? 0,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's', version: '1' } },
        }),
      };
    }) as never;

    const { McpClient } = await import('../../../../src/plugins/mcp/client');
    const transport = new HttpTransport(
      { url: 'https://a.test/mcp', name: 's' },
      { fetch, fetchStream: (() => (async function* () {})()) as never } as never,
    );
    const client = new McpClient(transport, { protocolMode: 'legacy' });
    await client.connect().catch(() => undefined);

    const init = sent.find((p) => p.clientInfo);
    expect((init?.clientInfo as { version?: string } | undefined)?.version).toBe(SDK_VERSION);
    expect((init?.clientInfo as { version?: string } | undefined)?.version).not.toBe('1.0.0');
  });
});

describe('recovery does not recurse', () => {
  it('a 404 during the re-initialize does not start another recovery', async () => {
    // Re-initializing goes back through THIS transport. A server that answers
    // that call with a 404 — and hands out a session header on the error, which
    // is enough to re-arm the "a session is held" condition — would otherwise
    // put the transport in a loop it never leaves.
    let recovered = 0;
    let transportRef: HttpTransport;
    const t = scripted(
      [
        { status: 200, sessionId: 'sess-1' }, // establish
        { status: 404 }, // the server forgot it
        { status: 404, sessionId: 'sess-2' }, // the re-initialize fails, WITH an id
      ],
      {
        recover: async () => {
          recovered++;
          // What the client's recoverSession does: re-run the handshake over
          // the same transport.
          await transportRef.request('initialize').catch(() => undefined);
          return false;
        },
      },
    );
    transportRef = t.transport;
    await withSession(t);
    await t.transport.request('tools/list').catch(() => undefined);

    expect(recovered).toBe(1);
    expect(t.sent).toHaveLength(3);
  });
});

describe('the client only rebuilds what a session IS', () => {
  /** A client over a transport that records whether recovery was installed and
   *  what re-running it costs, without a real server behind it. */
  async function clientAt(era: 'handshake' | 'modern') {
    const { McpClient } = await import('../../../../src/plugins/mcp/client');
    let recover: (() => Promise<boolean>) | undefined;
    let initializes = 0;
    const transport = {
      start: async () => undefined,
      close: async () => undefined,
      setHandlers: () => undefined,
      setProtocolVersion: () => undefined,
      setEra: () => undefined,
      setOnSessionLost: (r: () => Promise<boolean>) => {
        recover = r;
      },
      request: async (method: string) => {
        if (method === 'initialize') {
          initializes++;
          return { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's', version: '1' } };
        }
        if (method === 'server/discover') {
          return { protocolVersion: '2026-07-28', capabilities: {}, serverInfo: { name: 's', version: '1' } };
        }
        return {};
      },
      notify: async () => undefined,
    };
    const client = new McpClient(transport as never, {
      protocolMode: era === 'modern' ? '2026-07-28' : 'legacy',
    });
    await client.connect();
    return { recover, initializes: () => initializes };
  }

  it('re-runs the handshake, and nothing more, in the handshake era', async () => {
    // Not the FULL negotiation: the version question is already settled with
    // this server, and re-probing it would ask again on every dropped session.
    const c = await clientAt('handshake');
    expect(c.initializes()).toBe(1);
    expect(await c.recover?.()).toBe(true);
    expect(c.initializes()).toBe(2);
  });

  it('declines in the modern era, where there is no session to rebuild', async () => {
    const c = await clientAt('modern');
    expect(await c.recover?.()).toBe(false);
    expect(c.initializes()).toBe(0);
  });
});
