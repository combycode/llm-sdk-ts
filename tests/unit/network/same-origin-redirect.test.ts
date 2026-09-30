/** A redirect is a credential-leak primitive, so MCP does not follow one blindly.
 *
 *  Everything on an MCP request was configured for ONE endpoint: the bearer
 *  token, the session header, the JSON-RPC body. The platform default follows a
 *  redirect and sends all of it to wherever `Location` points — including another
 *  origin, chosen by whoever can set that header. And a 301, 302 or 303 turns the
 *  POST into a body-less GET, so even a same-origin redirect silently drops the
 *  message and the server answers a question nobody asked.
 *
 *  So MCP transport and OAuth requests follow a redirect only when the method
 *  survives AND the origin does not change AND the target introduces no
 *  credentials of its own. Anything else is returned as the non-success it is,
 *  which is what the platform does with redirects off.
 *
 *  Provider calls are untouched: they stay on `'follow'`, the default.
 */

import { describe, expect, it } from 'bun:test';
import { createEngine } from '../../../src/helpers/engine';
import { followSameOrigin } from '../../../src/util/http';

// ── the rule itself ────────────────────────────────────────────────────────

describe('followSameOrigin', () => {
  const at = (status: number, location: string | null, method = 'POST', from = 'https://a.test/mcp') =>
    followSameOrigin(from, method, status, location);

  it('follows a method-preserving redirect within the origin', () => {
    expect(at(307, 'https://a.test/mcp/')).toBe('https://a.test/mcp/');
    expect(at(308, '/mcp/v2')).toBe('https://a.test/mcp/v2');
  });

  it('refuses 301/302/303 for a POST, which would become a body-less GET', () => {
    // The message IS the body. A GET to the same URL is not a smaller version of
    // the request; it is a different request that loses the JSON-RPC call.
    for (const status of [301, 302, 303]) {
      expect(at(status, 'https://a.test/mcp/')).toBeNull();
    }
  });

  it('allows them for a GET, which has no method or body to lose', () => {
    for (const status of [301, 302, 303]) {
      expect(at(status, 'https://a.test/mcp/', 'GET')).toBe('https://a.test/mcp/');
    }
  });

  it('refuses another origin, which is the leak', () => {
    expect(at(307, 'https://evil.test/mcp')).toBeNull();
    expect(at(307, 'https://a.test.evil.test/mcp')).toBeNull();
    expect(at(307, 'https://a.test:8443/mcp')).toBeNull();
  });

  it('allows the http → https upgrade on default ports', () => {
    // Strictly an improvement to the same host, and the one exception the
    // reference implementations make.
    expect(followSameOrigin('http://a.test/mcp', 'POST', 307, 'https://a.test/mcp')).toBe(
      'https://a.test/mcp',
    );
  });

  it('refuses the reverse, https → http', () => {
    expect(followSameOrigin('https://a.test/mcp', 'POST', 307, 'http://a.test/mcp')).toBeNull();
  });

  it('refuses a Location that introduces credentials', () => {
    // `https://x@host/` is sent as Basic auth by the platform, so this is a
    // redirect that changes who we authenticate as.
    expect(at(307, 'https://attacker@a.test/mcp')).toBeNull();
  });

  it('keeps userinfo the configured url already had', () => {
    expect(followSameOrigin('https://u:p@a.test/mcp', 'POST', 307, '/mcp/')).toBe(
      'https://u:p@a.test/mcp/',
    );
  });

  it('refuses a redirect with no Location', () => {
    expect(at(307, null)).toBeNull();
    expect(at(307, '')).toBeNull();
  });

  it('refuses a Location that will not parse at all', () => {
    expect(at(307, 'http://[')).toBeNull();
  });

  it('but a merely ODD Location that resolves on-origin is followed', () => {
    // `ht!tp://nonsense` is not a scheme, so it resolves as a relative path and
    // stays on a.test. Nothing leaks, so there is nothing to refuse — the rule
    // is about WHERE a redirect goes, not about how tidy it looks.
    expect(at(307, 'ht!tp://nonsense')).toBe('https://a.test/ht!tp://nonsense');
  });

  it('refuses a non-redirect status outright', () => {
    expect(at(200, 'https://a.test/mcp/')).toBeNull();
    expect(at(404, 'https://a.test/mcp/')).toBeNull();
  });
});

// ── and what the queue does with it ────────────────────────────────────────

/** A fetch that answers from a script and records where it was called. */
function scripted(steps: Array<{ status: number; location?: string; body?: string }>) {
  const calls: Array<{ url: string; redirect?: string }> = [];
  const queue = [...steps];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, redirect: init.redirect });
    const step = queue.shift() ?? { status: 200, body: '{}' };
    return new Response(step.body ?? '{}', {
      status: step.status,
      headers: step.location ? { location: step.location } : {},
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

async function send(
  steps: Array<{ status: number; location?: string; body?: string }>,
  redirect: 'follow' | 'same-origin',
) {
  const { fetch, calls } = scripted(steps);
  const engine = createEngine({
    fetch,
    registerAsDefault: false,
    retry: { perKind: { server_error: { retryable: false }, invalid_request: { retryable: false } } },
  });
  let status = 0;
  try {
    const res = await engine.fetch({
      url: 'https://a.test/mcp',
      method: 'POST',
      headers: { authorization: 'Bearer secret' },
      body: { jsonrpc: '2.0', method: 'ping' },
      provider: 'mcp',
      model: 'server',
      responseType: 'text',
      redirect,
    } as never);
    status = res.status;
  } catch {
    // A refused redirect surfaces as the non-success it is; the call list is the
    // assertion either way.
  }
  await engine.destroy();
  return { calls, status };
}

describe('the queue follows one only when the rule allows it', () => {
  it('follows a same-origin 307 and lands on the target', async () => {
    const { calls, status } = await send(
      [
        { status: 307, location: 'https://a.test/mcp/' },
        { status: 200, body: '{"ok":true}' },
      ],
      'same-origin',
    );
    expect(calls.map((c) => c.url)).toEqual(['https://a.test/mcp', 'https://a.test/mcp/']);
    expect(status).toBe(200);
  });

  it('asks the platform NOT to follow, so the decision is ours', async () => {
    const { calls } = await send([{ status: 200, body: '{}' }], 'same-origin');
    expect(calls[0]?.redirect).toBe('manual');
  });

  it('does not follow cross-origin: one call, and the 307 comes back', async () => {
    // The point of the whole row: the bearer token is never sent to evil.test.
    const { calls } = await send([{ status: 307, location: 'https://evil.test/mcp' }], 'same-origin');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://a.test/mcp');
  });

  it('does not follow a 302 on a POST', async () => {
    const { calls } = await send([{ status: 302, location: 'https://a.test/mcp/' }], 'same-origin');
    expect(calls).toHaveLength(1);
  });

  it('stops after a bounded number of hops rather than looping', async () => {
    // A legitimate endpoint needs one or two; a longer budget only buys patience
    // for a loop.
    const loop = Array.from({ length: 10 }, () => ({
      status: 307,
      location: 'https://a.test/mcp',
    }));
    const { calls } = await send(loop, 'same-origin');
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it('leaves a provider call on the platform default', async () => {
    // Nothing about provider traffic changes: no `redirect` on the init at all.
    const { calls } = await send([{ status: 200, body: '{}' }], 'follow');
    expect(calls[0]?.redirect).toBeUndefined();
  });
});

// ── and that the two MCP paths actually opted in ────────────────────────────

/** The rule above is worth nothing if the call sites do not reach it. This is the
 *  seam the rest of this file cannot check: a correct rule nobody uses. Asserted
 *  through what arrives at the platform `fetch`, not through an internal helper,
 *  because the init is what the security property actually depends on. */
describe('the MCP paths ask for it', () => {
  /** Every url the platform fetch saw, with the redirect mode it was given. */
  async function inits(run: (engine: ReturnType<typeof createEngine>) => Promise<unknown>) {
    const seen: Array<{ url: string; redirect?: string }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, redirect: init.redirect });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const engine = createEngine({ fetch, registerAsDefault: false });
    try {
      await run(engine);
    } catch {
      // The scripted answers are not a real conversation; the inits are the point.
    }
    await engine.destroy();
    return seen;
  }

  it('the transport sends every request with redirects off', async () => {
    const { connectMcp } = await import('../../../src/helpers/mcp');
    const seen = await inits((engine) =>
      connectMcp({ url: 'https://a.test/mcp', name: 's' }, { engine } as never),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.redirect === 'manual')).toBe(true);
  });

  it('so does the token request, which carries the client secret', async () => {
    const { refreshTokens } = await import('../../../src/plugins/mcp/oauth');
    const seen = await inits((engine) =>
      refreshTokens(engine.fetch, 'https://as.test/token', {
        refresh_token: 'refresh-token',
        client_id: 'client-id',
        client_secret: 'shh',
      }),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.redirect === 'manual')).toBe(true);
  });
});
