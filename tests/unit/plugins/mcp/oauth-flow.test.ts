/** The `McpOAuth` orchestrator: token lifetime, refresh, the interactive redirect, and the
 *  security checks that gate `finish()`.
 *
 *  Every HTTP call goes through an injected `EngineFetch` fake keyed by URL — nothing leaves the
 *  process. These are the behaviours a port must reproduce exactly: a port that re-derives the
 *  expiry buffer, the iss rule, or the order of the CSRF/iss checks ships a client that looks
 *  authorized and is not. */

import { describe, expect, it } from 'bun:test';
import {
  McpOAuth,
  McpUnauthorizedError,
  discoverMetadata,
  registerClient,
} from '../../../../src/plugins/mcp/oauth';
import type { McpAuthProvider, McpOAuthClientInfo, McpOAuthTokens } from '../../../../src/plugins/mcp/oauth';
import type { EngineFetch } from '../../../../src/network/types';

const SERVER = 'https://srv.example.com/mcp';
const ORIGIN = 'https://srv.example.com';

/** Same-origin endpoints: the default SSRF posture requires the authorization server to share the
 *  MCP server's origin unless `allowedHosts` says otherwise. */
const META_DOC = {
  authorization_endpoint: `${ORIGIN}/authorize`,
  token_endpoint: `${ORIGIN}/token`,
  registration_endpoint: `${ORIGIN}/register`,
};

type Reply = { status: number; body: unknown };
type Seen = { url: string; method?: string; body?: unknown };

/** An EngineFetch that answers per URL suffix and records every request. */
function makeFetch(routes: Record<string, Reply | (() => Reply)>) {
  const seen: Seen[] = [];
  const fetch = (async (req: { url: string; method?: string; body?: unknown }) => {
    seen.push({ url: req.url, method: req.method, body: req.body });
    const key = Object.keys(routes).find((k) => req.url.includes(k));
    if (!key) return { status: 404, headers: {}, body: {} };
    const r = routes[key];
    const reply = typeof r === 'function' ? r() : r;
    return { status: reply.status, headers: {}, body: reply.body };
  }) as unknown as EngineFetch;
  return { fetch, seen };
}

interface TestProvider extends McpAuthProvider {
  readonly saved: { tokens: McpOAuthTokens[]; verifiers: string[]; states: string[]; clients: McpOAuthClientInfo[] };
  readonly redirects: string[];
}

function makeProvider(init: { tokens?: McpOAuthTokens; client?: McpOAuthClientInfo | undefined } = {}): TestProvider {
  let tokens = init.tokens;
  let client: McpOAuthClientInfo | undefined = 'client' in init ? init.client : { client_id: 'cid' };
  let verifier = 'seed-verifier';
  let state: string | undefined;
  const saved = { tokens: [] as McpOAuthTokens[], verifiers: [] as string[], states: [] as string[], clients: [] as McpOAuthClientInfo[] };
  const redirects: string[] = [];
  return {
    redirectUrl: 'http://127.0.0.1:8765/cb',
    clientMetadata: { redirect_uris: ['http://127.0.0.1:8765/cb'], scope: 'mcp:read' },
    clientInformation: () => client,
    saveClientInformation: (info) => {
      client = info;
      saved.clients.push(info);
    },
    tokens: () => tokens,
    saveTokens: (t) => {
      tokens = t;
      saved.tokens.push(t);
    },
    redirectToAuthorization: (url) => {
      redirects.push(url);
    },
    saveCodeVerifier: (v) => {
      verifier = v;
      saved.verifiers.push(v);
    },
    codeVerifier: () => verifier,
    saveState: (s) => {
      state = s;
      saved.states.push(s);
    },
    state: () => state,
    saved,
    redirects,
  };
}

const fresh = (over: Partial<McpOAuthTokens> = {}): McpOAuthTokens => ({
  access_token: 'good-token',
  expires_in: 3600,
  obtained_at: Date.now(),
  ...over,
});

describe('McpUnauthorizedError', () => {
  it('carries a default message and its own name so callers can branch on it', () => {
    const e = new McpUnauthorizedError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('McpUnauthorizedError');
    expect(e.message).toBe('MCP authorization required');
  });

  it('keeps a caller-supplied message', () => {
    expect(new McpUnauthorizedError('go to /authorize').message).toBe('go to /authorize');
  });
});

describe('McpOAuth.authorize: token lifetime', () => {
  it('accepts a live token without touching the network', async () => {
    const { fetch, seen } = makeFetch({});
    const oauth = new McpOAuth(SERVER, makeProvider({ tokens: fresh() }), fetch);
    expect(await oauth.authorize()).toBe('authorized');
    expect(seen).toEqual([]);
  });

  it('treats a token with no stated lifetime as usable', async () => {
    // An opaque token with no `expires_in` is common; guessing it expired would force a pointless
    // interactive round trip on every call.
    const { fetch, seen } = makeFetch({});
    const oauth = new McpOAuth(SERVER, makeProvider({ tokens: { access_token: 'opaque' } }), fetch);
    expect(await oauth.authorize()).toBe('authorized');
    expect(seen).toEqual([]);
  });

  it('treats a token expiring within the 60s buffer as already expired', async () => {
    // The buffer exists so a token does not die in flight. A token with 30s left must be refreshed
    // now, not used and rejected by the resource server.
    const provider = makeProvider({ tokens: fresh({ expires_in: 3600, obtained_at: Date.now() - 3_570_000, refresh_token: 'rt' }) });
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': { status: 200, body: META_DOC },
      '/token': { status: 200, body: { access_token: 'refreshed', expires_in: 3600 } },
    });
    const oauth = new McpOAuth(SERVER, provider, fetch);
    expect(await oauth.authorize()).toBe('authorized');
    expect(provider.saved.tokens.at(-1)?.access_token).toBe('refreshed');
  });

  it('refreshes an outright expired token rather than redirecting the user', async () => {
    const provider = makeProvider({ tokens: fresh({ obtained_at: Date.now() - 7_200_000, refresh_token: 'rt' }) });
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': { status: 200, body: META_DOC },
      '/token': { status: 200, body: { access_token: 'refreshed', token_type: 'Bearer', expires_in: 3600 } },
    });
    const oauth = new McpOAuth(SERVER, provider, fetch);
    expect(await oauth.authorize()).toBe('authorized');
    expect(provider.redirects).toEqual([]);
  });
});

describe('McpOAuth.authorize: the interactive redirect', () => {
  it('sends the user to a PKCE S256 authorization URL and persists what finish() will need', async () => {
    // The verifier and state MUST be persisted BEFORE the user leaves, or the callback cannot be
    // validated and the code cannot be redeemed.
    const provider = makeProvider();
    const { fetch } = makeFetch({ '/.well-known/oauth-authorization-server': { status: 200, body: META_DOC } });
    const oauth = new McpOAuth(SERVER, provider, fetch);

    expect(await oauth.authorize()).toBe('redirect');

    expect(provider.redirects).toHaveLength(1);
    const url = new URL(provider.redirects[0]);
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8765/cb');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('mcp:read');
    // RFC 8707: the token is bound to this MCP server, not to whatever else the client can reach.
    expect(url.searchParams.get('resource')).toBe(SERVER);

    // The challenge in the URL is the S256 hash of the verifier we stored — not the verifier.
    const verifier = provider.saved.verifiers.at(-1) as string;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const expected = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(url.searchParams.get('code_challenge')).toBe(expected);
    expect(url.searchParams.get('code_challenge')).not.toBe(verifier);

    // The state in the URL is exactly the one persisted for the CSRF check.
    expect(url.searchParams.get('state')).toBe(provider.saved.states.at(-1)!);
    expect(await provider.state()).toBe(url.searchParams.get('state')!);
  });

  it('registers a client on the fly when the provider has none, and saves it', async () => {
    const provider = makeProvider({ client: undefined });
    const { fetch, seen } = makeFetch({
      '/.well-known/oauth-authorization-server': { status: 200, body: META_DOC },
      '/register': { status: 201, body: { client_id: 'dcr-id', client_secret: 'dcr-secret' } },
    });
    const oauth = new McpOAuth(SERVER, provider, fetch);
    await oauth.authorize();

    expect(provider.saved.clients).toEqual([{ client_id: 'dcr-id', client_secret: 'dcr-secret' }]);
    expect(new URL(provider.redirects[0]).searchParams.get('client_id')).toBe('dcr-id');
    // SEP-837: MCP clients are native, and some servers apply stricter redirect rules to `web`.
    const registerBody = seen.find((s) => s.url.includes('/register'))?.body as Record<string, unknown>;
    expect(registerBody.application_type).toBe('native');
  });

  it('discovers metadata once and reuses it across calls', async () => {
    let discoveries = 0;
    const provider = makeProvider();
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': () => {
        discoveries++;
        return { status: 200, body: META_DOC };
      },
    });
    const oauth = new McpOAuth(SERVER, provider, fetch);
    await oauth.authorize();
    await oauth.authorize();
    expect(discoveries).toBe(1);
  });
});

describe('McpOAuth.authHeader', () => {
  it('returns a Bearer header for a live token', async () => {
    const { fetch } = makeFetch({});
    const oauth = new McpOAuth(SERVER, makeProvider({ tokens: fresh() }), fetch);
    expect(await oauth.authHeader()).toEqual({ authorization: 'Bearer good-token' });
  });

  it('returns no header at all when there is no token — never a `Bearer undefined`', async () => {
    const { fetch } = makeFetch({});
    const oauth = new McpOAuth(SERVER, makeProvider(), fetch);
    expect(await oauth.authHeader()).toEqual({});
  });

  it('refreshes a stale token first and returns the NEW one', async () => {
    const provider = makeProvider({ tokens: fresh({ access_token: 'stale', obtained_at: Date.now() - 7_200_000, refresh_token: 'rt' }) });
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': { status: 200, body: META_DOC },
      '/token': { status: 200, body: { access_token: 'brand-new', expires_in: 3600 } },
    });
    const oauth = new McpOAuth(SERVER, provider, fetch);
    expect(await oauth.authHeader()).toEqual({ authorization: 'Bearer brand-new' });
  });

  it('falls back to the stale token when the refresh fails, rather than sending nothing', async () => {
    // The request is going to 401, and that 401 is what drives reauthorize(). Dropping the header
    // instead would make the failure look like an anonymous request.
    const provider = makeProvider({ tokens: fresh({ access_token: 'stale', obtained_at: Date.now() - 7_200_000, refresh_token: 'rt' }) });
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': { status: 200, body: META_DOC },
      '/token': { status: 400, body: { error: 'invalid_grant' } },
    });
    const oauth = new McpOAuth(SERVER, provider, fetch);
    expect(await oauth.authHeader()).toEqual({ authorization: 'Bearer stale' });
  });

  it('does not attempt a refresh when the expired token has no refresh_token', async () => {
    const provider = makeProvider({ tokens: fresh({ access_token: 'stale', obtained_at: Date.now() - 7_200_000 }) });
    const { fetch, seen } = makeFetch({});
    const oauth = new McpOAuth(SERVER, provider, fetch);
    expect(await oauth.authHeader()).toEqual({ authorization: 'Bearer stale' });
    expect(seen).toEqual([]);
  });
});

describe('McpOAuth.reauthorize (handling a 401)', () => {
  it('returns true after a successful refresh so the caller can retry the request', async () => {
    const provider = makeProvider({ tokens: fresh({ refresh_token: 'rt' }) });
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': { status: 200, body: META_DOC },
      '/token': { status: 200, body: { access_token: 'second-wind', expires_in: 3600 } },
    });
    const oauth = new McpOAuth(SERVER, provider, fetch);
    expect(await oauth.reauthorize()).toBe(true);
    expect(provider.saved.tokens.at(-1)?.access_token).toBe('second-wind');
    expect(provider.redirects).toEqual([]);
  });

  it('returns false and starts an interactive redirect when the refresh is rejected', async () => {
    const provider = makeProvider({ tokens: fresh({ refresh_token: 'revoked' }) });
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': { status: 200, body: META_DOC },
      '/token': { status: 400, body: { error: 'invalid_grant' } },
    });
    const oauth = new McpOAuth(SERVER, provider, fetch);
    expect(await oauth.reauthorize()).toBe(false);
    expect(provider.redirects).toHaveLength(1);
  });

  it('redirects straight away when there is no refresh token to try', async () => {
    const provider = makeProvider({ tokens: { access_token: 'only-this' } });
    const { fetch } = makeFetch({ '/.well-known/oauth-authorization-server': { status: 200, body: META_DOC } });
    const oauth = new McpOAuth(SERVER, provider, fetch);
    expect(await oauth.reauthorize()).toBe(false);
    expect(provider.redirects).toHaveLength(1);
  });

  it('a refresh that throws is a false, not an exception escaping to the caller', async () => {
    // `tryRefresh` swallows everything: a network blip during refresh must degrade to "go
    // reauthorize", not blow up the request that hit the 401.
    const provider = makeProvider({ tokens: fresh({ refresh_token: 'rt' }) });
    const fetch = (async () => {
      throw new Error('network down');
    }) as unknown as EngineFetch;
    const oauth = new McpOAuth(SERVER, provider, fetch);
    // Discovery also fails, so the redirect cannot be built either — the error surfaces from
    // startRedirect, proving tryRefresh itself did not throw.
    await expect(oauth.reauthorize()).rejects.toThrow(/no authorization-server metadata/);
  });
});

describe('McpOAuth.finish: security gates', () => {
  const withState = async (provider: TestProvider, fetch: EngineFetch) => {
    const oauth = new McpOAuth(SERVER, provider, fetch);
    await oauth.authorize(); // performs the redirect, persisting state + verifier
    return { oauth, state: provider.saved.states.at(-1) as string };
  };

  it('exchanges the code with the stored verifier once state matches', async () => {
    const provider = makeProvider();
    const { fetch, seen } = makeFetch({
      '/.well-known/oauth-authorization-server': { status: 200, body: META_DOC },
      '/token': { status: 200, body: { access_token: 'final', token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read' } },
    });
    const { oauth, state } = await withState(provider, fetch);

    await oauth.finish('the-code', state);

    const body = String(seen.find((s) => s.url.includes('/token'))?.body);
    const form = new URLSearchParams(body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('code_verifier')).toBe(provider.saved.verifiers.at(-1)!);
    expect(form.get('redirect_uri')).toBe('http://127.0.0.1:8765/cb');
    expect(form.get('resource')).toBe(SERVER);
    expect(provider.saved.tokens.at(-1)?.access_token).toBe('final');
    expect(provider.saved.tokens.at(-1)?.obtained_at).toBeGreaterThan(0); // stamped for expiry math
  });

  it('rejects a mismatched iss even when discovery published NO issuer', async () => {
    // The regression this exists to prevent: treating a missing `issuer` as "nothing to compare
    // against" disables the RFC 9207 mix-up defence exactly when the metadata is weakest. A code
    // that claims to come from some authorization server we never learned about is not redeemable.
    const provider = makeProvider();
    const { fetch, seen } = makeFetch({
      '/.well-known/oauth-authorization-server': { status: 200, body: META_DOC }, // no `issuer`
      '/token': { status: 200, body: { access_token: 'must-not-happen' } },
    });
    const { oauth, state } = await withState(provider, fetch);

    await expect(oauth.finish('the-code', state, 'https://evil.example.com')).rejects.toThrow(/iss mismatch/);
    // And the code never reached the token endpoint — validating after the exchange would mean the
    // credentials had already been replayed.
    expect(seen.some((s) => s.url.includes('/token'))).toBe(false);
    expect(provider.saved.tokens).toEqual([]);
  });

  it('accepts an iss that matches the discovered issuer', async () => {
    const provider = makeProvider();
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': { status: 200, body: { ...META_DOC, issuer: ORIGIN } },
      '/token': { status: 200, body: { access_token: 'final' } },
    });
    const { oauth, state } = await withState(provider, fetch);
    await oauth.finish('the-code', state, ORIGIN);
    expect(provider.saved.tokens.at(-1)?.access_token).toBe('final');
  });

  it('rejects a MISSING iss when discovery said the server always sends one', async () => {
    // Otherwise stripping the parameter is enough to skip the check.
    const provider = makeProvider();
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': {
        status: 200,
        body: { ...META_DOC, issuer: ORIGIN, authorization_response_iss_parameter_supported: true },
      },
      '/token': { status: 200, body: { access_token: 'must-not-happen' } },
    });
    const { oauth, state } = await withState(provider, fetch);
    await expect(oauth.finish('the-code', state)).rejects.toThrow(/missing the iss/);
  });

  it('the CSRF state check runs before anything else — a wrong state never reaches discovery', async () => {
    const provider = makeProvider();
    const { fetch, seen } = makeFetch({
      '/.well-known/oauth-authorization-server': { status: 200, body: META_DOC },
      '/token': { status: 200, body: { access_token: 'must-not-happen' } },
    });
    await provider.saveState('the-real-state');
    const oauth = new McpOAuth(SERVER, provider, fetch);
    await expect(oauth.finish('the-code', 'attacker-state')).rejects.toThrow(/state mismatch/);
    expect(seen).toEqual([]);
  });

  it('a state that merely STARTS with the real one is a mismatch', async () => {
    // The constant-time comparison walks the shorter string, so without an explicit length check
    // any value beginning with the real state would compare equal — a CSRF token that only has to
    // be guessed as a prefix is no token at all.
    const provider = makeProvider();
    const { fetch } = makeFetch({});
    await provider.saveState('real-state');
    const oauth = new McpOAuth(SERVER, provider, fetch);
    await expect(oauth.finish('the-code', 'real-stateAND-MORE')).rejects.toThrow(/state mismatch/);
  });

  it('a truncated state is a mismatch too', async () => {
    const provider = makeProvider();
    const { fetch } = makeFetch({});
    await provider.saveState('real-state-value');
    const oauth = new McpOAuth(SERVER, provider, fetch);
    await expect(oauth.finish('the-code', 'real')).rejects.toThrow(/state mismatch/);
  });
});

describe('discoverMetadata', () => {
  it('falls back to the OIDC document when the OAuth one is absent', async () => {
    const { fetch, seen } = makeFetch({
      '/.well-known/openid-configuration': { status: 200, body: { ...META_DOC, issuer: ORIGIN } },
    });
    const meta = await discoverMetadata(fetch, SERVER);
    expect(meta.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]);
  });

  it('reads both RFC 9207 fields off the document', async () => {
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': {
        status: 200,
        body: { ...META_DOC, issuer: ORIGIN, authorization_response_iss_parameter_supported: true },
      },
    });
    const meta = await discoverMetadata(fetch, SERVER);
    expect(meta.issuer).toBe(ORIGIN);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
  });

  it('defaults iss support to false — only an explicit `true` counts', async () => {
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': {
        status: 200,
        body: { ...META_DOC, authorization_response_iss_parameter_supported: 'yes' },
      },
    });
    const meta = await discoverMetadata(fetch, SERVER);
    expect(meta.authorization_response_iss_parameter_supported).toBe(false);
    expect(meta.issuer).toBeUndefined();
  });

  it('throws when neither document names both endpoints', async () => {
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': { status: 200, body: { authorization_endpoint: `${ORIGIN}/a` } },
    });
    await expect(discoverMetadata(fetch, SERVER)).rejects.toThrow(/no authorization-server metadata/);
  });

  it('refuses a cross-origin endpoint the server tried to hand us', async () => {
    // SSRF: the discovery document is server-controlled, so every URL it names is guarded before
    // we will send a credential to it.
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': {
        status: 200,
        body: { ...META_DOC, token_endpoint: 'https://evil.example.com/token' },
      },
    });
    await expect(discoverMetadata(fetch, SERVER)).rejects.toThrow();
  });
});

describe('registerClient', () => {
  it('throws on a rejected registration rather than returning a half-built client', async () => {
    const { fetch } = makeFetch({ '/register': { status: 403, body: { error: 'forbidden' } } });
    await expect(
      registerClient(fetch, `${ORIGIN}/register`, { redirect_uris: ['http://127.0.0.1/cb'] }, SERVER),
    ).rejects.toThrow(/registration returned 403/);
  });

  it('throws when the response omits client_id', async () => {
    const { fetch } = makeFetch({ '/register': { status: 200, body: { client_secret: 'only-secret' } } });
    await expect(
      registerClient(fetch, `${ORIGIN}/register`, { redirect_uris: ['http://127.0.0.1/cb'] }, SERVER),
    ).rejects.toThrow(/missing client_id/);
  });

  it("lets a caller override application_type away from 'native'", async () => {
    const { fetch, seen } = makeFetch({ '/register': { status: 200, body: { client_id: 'x' } } });
    await registerClient(
      fetch,
      `${ORIGIN}/register`,
      { redirect_uris: ['https://app.example.com/cb'], application_type: 'web' },
      SERVER,
    );
    expect((seen[0].body as Record<string, unknown>).application_type).toBe('web');
  });

  it('guards the registration endpoint against SSRF before posting metadata to it', async () => {
    const { fetch, seen } = makeFetch({ '/register': { status: 200, body: { client_id: 'x' } } });
    await expect(
      registerClient(fetch, 'https://evil.example.com/register', { redirect_uris: ['http://127.0.0.1/cb'] }, SERVER),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});

describe('McpOAuth: no registration endpoint', () => {
  it('says so plainly instead of failing later at the authorize URL', async () => {
    const provider = makeProvider({ client: undefined });
    const { fetch } = makeFetch({
      '/.well-known/oauth-authorization-server': {
        status: 200,
        body: { authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/token` },
      },
    });
    const oauth = new McpOAuth(SERVER, provider, fetch);
    await expect(oauth.authorize()).rejects.toThrow(/no client registered/);
  });
});
