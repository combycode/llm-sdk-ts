/** A 403 that means "your token is too narrow" is not a dead end.
 *
 *  Two refusals send a client back through authorization, and conflating them
 *  costs you one of the two:
 *
 *  - **401** — the token is missing, expired or rejected. A refresh usually
 *    fixes it and the scope does not change.
 *  - **403 with `error="insufficient_scope"`** (SEP-2350) — the token is
 *    perfectly valid and simply not broad enough. A refresh is useless: it mints
 *    another token carrying the scope that was just refused.
 *
 *  We handled only the 401, so a step-up surfaced as a plain failure and the
 *  operation could never succeed no matter how many times it was tried.
 *
 *  The scope asked for on a step-up is the UNION of what was already requested,
 *  what the stored token was granted, and what the server now demands. Asking
 *  for the challenged scope alone is the failure SEP-2350 exists to describe:
 *  the new grant REPLACES the old one, so escalating one operation silently
 *  revokes the permissions another was relying on.
 */

import { describe, expect, it } from 'bun:test';
import { parseBearerChallenge, unionScopes } from '../../../../src/plugins/mcp/oauth';
import { HttpTransport } from '../../../../src/plugins/mcp/transport-http';

describe('parseBearerChallenge', () => {
  it('reads the parameters a step-up needs', () => {
    expect(
      parseBearerChallenge('Bearer realm="mcp", error="insufficient_scope", scope="repo:write admin"'),
    ).toEqual({ realm: 'mcp', error: 'insufficient_scope', scope: 'repo:write admin' });
  });

  it('accepts bare values as well as quoted ones', () => {
    expect(parseBearerChallenge('Bearer error=insufficient_scope, scope=read')).toEqual({
      error: 'insufficient_scope',
      scope: 'read',
    });
  });

  it('reads resource_metadata, which a 403 may carry too', () => {
    // SEP-985. Carried on both refusals, which is why it is parsed here rather
    // than only on the unauthorized path.
    expect(
      parseBearerChallenge('Bearer resource_metadata="https://a.test/.well-known/oauth-protected-resource"')
        ?.resource_metadata,
    ).toBe('https://a.test/.well-known/oauth-protected-resource');
  });

  it('is undefined for another scheme, or no header', () => {
    expect(parseBearerChallenge('Basic realm="x"')).toBeUndefined();
    expect(parseBearerChallenge(undefined)).toBeUndefined();
  });

  it('is an empty challenge, not undefined, when Bearer carries no parameters', () => {
    // "there was a Bearer challenge" and "there was none" are different answers.
    expect(parseBearerChallenge('Bearer')).toEqual({});
  });
});

describe('unionScopes', () => {
  it('keeps order and drops repeats', () => {
    expect(unionScopes('a b', 'b c')).toBe('a b c');
  });

  it('survives either side being absent', () => {
    expect(unionScopes(undefined, 'c')).toBe('c');
    expect(unionScopes('a', undefined)).toBe('a');
    expect(unionScopes(undefined, undefined)).toBeUndefined();
  });
});

/** A transport whose fetch answers from a script, recording re-auth calls. */
function transportThatAnswers(steps: Array<{ status: number; wwwAuth?: string }>) {
  const reauth: Array<string | undefined> = [];
  const queue = [...steps];
  const fetch = (async (req: { body?: { id?: number } }) => {
    const step = queue.shift() ?? { status: 200 };
    return {
      status: step.status,
      headers: {
        'content-type': 'application/json',
        ...(step.wwwAuth ? { 'www-authenticate': step.wwwAuth } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: req.body?.id ?? 0, result: { ok: true } }),
    };
  }) as never;

  const transport = new HttpTransport(
    { url: 'https://a.test/mcp', name: 's' },
    {
      fetch,
      fetchStream: (() => (async function* () {})()) as never,
      onUnauthorized: async (scope?: string) => {
        reauth.push(scope);
        return true;
      },
    } as never,
  );
  return { transport, reauth };
}

describe('the transport re-authorizes on the refusals that mean it', () => {
  it('a 403 insufficient_scope re-authorizes, passing the challenged scope', async () => {
    const { transport, reauth } = transportThatAnswers([
      { status: 403, wwwAuth: 'Bearer error="insufficient_scope", scope="repo:write"' },
      { status: 200 },
    ]);
    await transport.request('tools/list');
    expect(reauth).toEqual(['repo:write']);
  });

  it('a 401 still re-authorizes, with no scope', async () => {
    // Nothing about the existing path changes: a 401 is not a scope problem.
    const { transport, reauth } = transportThatAnswers([{ status: 401 }, { status: 200 }]);
    await transport.request('tools/list');
    expect(reauth).toEqual([undefined]);
  });

  it('a plain 403 does NOT re-authorize', async () => {
    // A real authorization failure: the caller may not do this whatever token
    // they hold, and re-authorizing would only loop.
    const { transport, reauth } = transportThatAnswers([{ status: 403 }, { status: 200 }]);
    await transport.request('tools/list').catch(() => undefined);
    expect(reauth).toEqual([]);
  });

  it('nor does a 403 whose challenge names a different error', async () => {
    const { transport, reauth } = transportThatAnswers([
      { status: 403, wwwAuth: 'Bearer error="invalid_token"' },
      { status: 200 },
    ]);
    await transport.request('tools/list').catch(() => undefined);
    expect(reauth).toEqual([]);
  });

  it('retries ONCE — a server that keeps refusing is not retried forever', async () => {
    const { transport, reauth } = transportThatAnswers([
      { status: 403, wwwAuth: 'Bearer error="insufficient_scope", scope="a"' },
      { status: 403, wwwAuth: 'Bearer error="insufficient_scope", scope="a"' },
    ]);
    await transport.request('tools/list').catch(() => undefined);
    expect(reauth).toHaveLength(1);
  });
});

/** The union has to reach the authorization URL, not just exist as a helper.
 *
 *  This is the seam: `unionScopes` could be perfect and `reauthorize` could
 *  still send only what the server challenged for, which is the exact failure
 *  SEP-2350 is about.
 */
describe('the scope that reaches the authorization URL', () => {
  async function authorizeUrlFor(challenged?: string): Promise<URL | null> {
    const { McpOAuth } = await import('../../../../src/plugins/mcp/oauth');
    let redirected = '';
    const provider = {
      redirectUrl: 'https://app.test/cb',
      clientMetadata: {
        client_name: 'x',
        redirect_uris: ['https://app.test/cb'],
        // What THIS process was configured with.
        scope: 'read',
      },
      // What the user actually consented to, which after a restart is the only
      // record of it.
      tokens: async () => ({ access_token: 't', scope: 'read profile', issuer: 'https://a.test' }),
      saveTokens: async () => {},
      clientInformation: async () => ({ client_id: 'cid', issuer: 'https://a.test' }),
      saveClientInformation: async () => {},
      state: async () => 's',
      saveState: async () => {},
      codeVerifier: async () => 'v',
      saveCodeVerifier: async () => {},
      redirectToAuthorization: async (u: string) => {
        redirected = u;
      },
    };
    const fetch = (async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        issuer: 'https://a.test',
        authorization_endpoint: 'https://a.test/authorize',
        token_endpoint: 'https://a.test/token',
      },
    })) as never;
    const oauth = new McpOAuth('https://a.test/mcp', provider as never, fetch);
    await oauth.reauthorize(challenged);
    return redirected ? new URL(redirected) : null;
  }

  it('is the union of configured, granted and challenged', async () => {
    const url = await authorizeUrlFor('repo:write admin');
    expect(url?.searchParams.get('scope')).toBe('read profile repo:write admin');
  });

  it('is unchanged for a plain 401 — no step-up, no widening', async () => {
    const url = await authorizeUrlFor(undefined);
    expect(url?.searchParams.get('scope')).toBe('read');
  });
});
