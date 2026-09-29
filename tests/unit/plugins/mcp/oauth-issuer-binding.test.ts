/** Stored MCP OAuth credentials are bound to the authorization server that
 *  issued them, and a refresh names the resource it is for.
 *
 *  What this defends: the MCP server tells the client where to authorize. Store
 *  a registration or a token without recording WHICH server it came from, and a
 *  server that later points somewhere else is handed credentials minted for
 *  somebody else — quietly, and by us. Both official MCP SDKs bind stored
 *  credentials for exactly this reason (mcp-py cites SEP-2352).
 *
 *  Two failure modes, two different answers, and the difference is deliberate:
 *
 *    a client REGISTRATION bound elsewhere throws. Re-registering silently
 *    would leave the caller with two registrations and no idea the server
 *    moved, and presenting the old one is the attack itself.
 *
 *    TOKENS bound elsewhere are treated as absent. They are disposable, so the
 *    honest recovery is to authorize again rather than to fail.
 */

import { describe, expect, it } from 'bun:test';
import { McpOAuth, issuersMatch } from '../../../../src/plugins/mcp/oauth';
import type {
  McpAuthProvider,
  McpOAuthClientInfo,
  McpOAuthTokens,
} from '../../../../src/plugins/mcp/oauth';
import type { EngineFetch } from '../../../../src/network/types';

const SERVER = 'https://srv.example.com/mcp';
const ORIGIN = 'https://srv.example.com';
const OTHER = 'https://evil.example.net';

const META_DOC = {
  authorization_endpoint: `${ORIGIN}/authorize`,
  token_endpoint: `${ORIGIN}/token`,
  registration_endpoint: `${ORIGIN}/register`,
};

type Seen = { url: string; body?: unknown };

function makeFetch(routes: Record<string, { status: number; body: unknown }>) {
  const seen: Seen[] = [];
  const fetch = (async (req: { url: string; body?: unknown }) => {
    seen.push({ url: req.url, body: req.body });
    const key = Object.keys(routes).find((k) => req.url.includes(k));
    if (!key) return { status: 404, headers: {}, body: {} };
    return { status: routes[key]!.status, headers: {}, body: routes[key]!.body };
  }) as unknown as EngineFetch;
  return { fetch, seen };
}

interface TestProvider extends McpAuthProvider {
  readonly saved: { tokens: McpOAuthTokens[]; clients: McpOAuthClientInfo[] };
  readonly redirects: string[];
}

function makeProvider(init: {
  tokens?: McpOAuthTokens;
  client?: McpOAuthClientInfo;
}): TestProvider {
  let tokens = init.tokens;
  let client = init.client;
  const saved = { tokens: [] as McpOAuthTokens[], clients: [] as McpOAuthClientInfo[] };
  const redirects: string[] = [];
  return {
    redirectUrl: 'http://127.0.0.1:8765/cb',
    clientMetadata: { redirect_uris: ['http://127.0.0.1:8765/cb'] },
    saved,
    redirects,
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
    saveCodeVerifier: () => {},
    codeVerifier: () => 'seed-verifier',
    saveState: () => {},
    state: () => 'seed-state',
  };
}

describe('issuersMatch: lenient ON PURPOSE, and not the RFC 9207 check', () => {
  it('tolerates the trailing slash `new URL()` adds', () => {
    // `String(new URL('https://as.example.com'))` is slash-suffixed; an
    // advertised issuer usually is not. A strict compare here would discard a
    // valid registration on every other run.
    expect(issuersMatch('https://as.example.com', 'https://as.example.com/')).toBe(true);
  });

  it('ignores spellings a URL parser normalises', () => {
    expect(issuersMatch('https://AS.example.com', 'https://as.example.com')).toBe(true);
    expect(issuersMatch('https://as.example.com:443', 'https://as.example.com')).toBe(true);
  });

  it('still separates different servers', () => {
    expect(issuersMatch('https://as.example.com', 'https://as.example.net')).toBe(false);
    expect(issuersMatch('https://as.example.com', 'https://as.example.com/tenant')).toBe(false);
  });

  it('compares non-URLs as written', () => {
    expect(issuersMatch('urn:example:as', 'urn:example:as')).toBe(true);
    expect(issuersMatch('urn:example:as', 'urn:example:other')).toBe(false);
  });
});

describe('a client registration is bound to the server that issued it', () => {
  const routes = {
    '/.well-known': { status: 200, body: META_DOC },
    '/register': { status: 201, body: { client_id: 'dcr-id' } },
  };

  it('refuses to present one server’s registration to another', async () => {
    const provider = makeProvider({
      client: { client_id: 'elsewhere-id', issuer: OTHER },
      tokens: undefined,
    });
    const { fetch } = makeFetch(routes);
    await expect(new McpOAuth(SERVER, provider, fetch).authorize()).rejects.toThrow(
      /belongs to https:\/\/evil\.example\.net/,
    );
  });

  it('uses an unstamped registration, and stamps it for next time', async () => {
    // Stored before the binding existed. It says nothing about where it came
    // from, so there is nothing to enforce — but the NEXT run should be bound.
    const provider = makeProvider({ client: { client_id: 'legacy-id' }, tokens: undefined });
    const { fetch } = makeFetch(routes);
    await new McpOAuth(SERVER, provider, fetch).authorize();
    expect(provider.saved.clients).toEqual([{ client_id: 'legacy-id', issuer: ORIGIN }]);
  });

  it('accepts its own stamp', async () => {
    const provider = makeProvider({ client: { client_id: 'ours', issuer: ORIGIN }, tokens: undefined });
    const { fetch } = makeFetch(routes);
    await new McpOAuth(SERVER, provider, fetch).authorize();
    // Nothing re-saved: it was already bound to this server.
    expect(provider.saved.clients).toEqual([]);
  });

  it('stamps a fresh registration', async () => {
    const provider = makeProvider({ client: undefined, tokens: undefined });
    const { fetch } = makeFetch(routes);
    await new McpOAuth(SERVER, provider, fetch).authorize();
    expect(provider.saved.clients).toEqual([{ client_id: 'dcr-id', issuer: ORIGIN }]);
  });
});

describe('tokens bound elsewhere read as no tokens at all', () => {
  const routes = {
    '/.well-known': { status: 200, body: META_DOC },
    '/register': { status: 201, body: { client_id: 'dcr-id' } },
  };

  const future = () => ({ access_token: 'at', expires_in: 3600, obtained_at: Date.now() });
  /** An hour old with a one-second lifetime. NOT `obtained_at: 0` -- `isExpired`
   *  reads a falsy stamp as an unknown lifetime and assumes the token is good. */
  const stale = () => ({ access_token: 'stale', obtained_at: Date.now() - 3_600_000, expires_in: 1 });

  it('ignores a token minted by a different server', async () => {
    const provider = makeProvider({
      client: { client_id: 'cid', issuer: ORIGIN },
      tokens: { ...future(), issuer: OTHER },
    });
    const { fetch } = makeFetch(routes);
    // Not 'authorized': the stored token is not ours to use, so the flow starts
    // over rather than sending it.
    expect(await new McpOAuth(SERVER, provider, fetch).authorize()).toBe('redirect');
  });

  it('uses a token stamped with this server', async () => {
    const provider = makeProvider({
      client: { client_id: 'cid', issuer: ORIGIN },
      tokens: { ...future(), issuer: ORIGIN },
    });
    const { fetch } = makeFetch(routes);
    expect(await new McpOAuth(SERVER, provider, fetch).authorize()).toBe('authorized');
  });

  it('uses an unstamped token, which predates the binding', async () => {
    const provider = makeProvider({
      client: { client_id: 'cid', issuer: ORIGIN },
      tokens: future(),
    });
    const { fetch } = makeFetch(routes);
    expect(await new McpOAuth(SERVER, provider, fetch).authorize()).toBe('authorized');
  });

  it('does not let a foreign token be spent via refresh either', async () => {
    const provider = makeProvider({
      client: { client_id: 'cid', issuer: ORIGIN },
      tokens: { ...stale(), refresh_token: 'rt', issuer: OTHER },
    });
    const { fetch, seen } = makeFetch(routes);
    await new McpOAuth(SERVER, provider, fetch).authorize();
    expect(seen.some((s) => s.url.includes('/token'))).toBe(false);
  });
});

const STALE = { access_token: 'stale', obtained_at: Date.now() - 3_600_000, expires_in: 1 };

describe('a refresh names the resource it is for', () => {
  it('sends `resource`, which only the exchange used to', async () => {
    // RFC 8707. Without it an authorization server that scopes tokens per
    // resource hands back one scoped to nothing, and the retry 401s with a
    // token that looks perfectly valid.
    const provider = makeProvider({
      client: { client_id: 'cid', issuer: ORIGIN },
      tokens: { ...STALE, refresh_token: 'rt', issuer: ORIGIN },
    });
    const { fetch, seen } = makeFetch({
      '/.well-known': { status: 200, body: META_DOC },
      '/token': { status: 200, body: { access_token: 'fresh', expires_in: 3600 } },
    });
    expect(await new McpOAuth(SERVER, provider, fetch).authorize()).toBe('authorized');

    const refresh = seen.find((s) => s.url.includes('/token'));
    const body = String(refresh?.body ?? '');
    expect(body).toContain('grant_type=refresh_token');
    // Verbatim, and the whole server URL — not its origin, and with no trailing
    // slash added: an exact-match authorization server rejects a resource that
    // gained one.
    expect(body).toContain(`resource=${encodeURIComponent(SERVER)}`);
  });

  it('stamps the refreshed tokens too', async () => {
    const provider = makeProvider({
      client: { client_id: 'cid', issuer: ORIGIN },
      tokens: { ...STALE, refresh_token: 'rt', issuer: ORIGIN },
    });
    const { fetch } = makeFetch({
      '/.well-known': { status: 200, body: META_DOC },
      '/token': { status: 200, body: { access_token: 'fresh', expires_in: 3600 } },
    });
    await new McpOAuth(SERVER, provider, fetch).authorize();
    expect(provider.saved.tokens.at(-1)?.issuer).toBe(ORIGIN);
    expect(provider.saved.tokens.at(-1)?.refresh_token).toBe('rt');
  });
});

describe('a refresh that returns no new refresh token keeps the old one', () => {
  it('does not wipe what the server did not replace', async () => {
    // RFC 6749 §6: the authorization server MAY issue a new refresh token, and
    // most do not. `toTokens` always sets the key — to undefined when the
    // response omits it — so spreading the response over a carried-forward value
    // erased it. After one refresh we held no refresh token, and the next expiry
    // fell back to interactive authorization with nothing said. For a headless
    // client that is a dead end.
    const provider = makeProvider({
      client: { client_id: 'cid', issuer: ORIGIN },
      tokens: { ...STALE, refresh_token: 'rt', issuer: ORIGIN },
    });
    const { fetch } = makeFetch({
      '/.well-known': { status: 200, body: META_DOC },
      // No refresh_token in the reply — the ordinary case.
      '/token': { status: 200, body: { access_token: 'fresh', expires_in: 3600 } },
    });
    await new McpOAuth(SERVER, provider, fetch).authorize();

    const saved = provider.saved.tokens.at(-1);
    expect(saved?.access_token).toBe('fresh');
    expect(saved?.refresh_token).toBe('rt');
  });

  it('takes a rotated refresh token when the server sends one', async () => {
    const provider = makeProvider({
      client: { client_id: 'cid', issuer: ORIGIN },
      tokens: { ...STALE, refresh_token: 'rt-old', issuer: ORIGIN },
    });
    const { fetch } = makeFetch({
      '/.well-known': { status: 200, body: META_DOC },
      '/token': {
        status: 200,
        body: { access_token: 'fresh', expires_in: 3600, refresh_token: 'rt-new' },
      },
    });
    await new McpOAuth(SERVER, provider, fetch).authorize();
    expect(provider.saved.tokens.at(-1)?.refresh_token).toBe('rt-new');
  });
});

describe('the resource indicator goes out exactly as given', () => {
  it('does not gain a trailing slash on a pathless server URL', async () => {
    // The case that bites: `String(new URL('https://mcp.example.com'))` is
    // `https://mcp.example.com/`, and an authorization server that exact-matches
    // its resource indicators rejects the slashed form. Nothing here parses the
    // URL — the string the caller gave is the string that is sent.
    const pathless = 'https://mcp.example.com';
    const provider = makeProvider({
      client: { client_id: 'cid', issuer: pathless },
      tokens: { ...STALE, refresh_token: 'rt', issuer: pathless },
    });
    const { fetch, seen } = makeFetch({
      '/.well-known': {
        status: 200,
        body: {
          authorization_endpoint: `${pathless}/authorize`,
          token_endpoint: `${pathless}/token`,
        },
      },
      '/token': { status: 200, body: { access_token: 'fresh', expires_in: 3600 } },
    });
    await new McpOAuth(pathless, provider, fetch).authorize();

    const body = String(seen.find((s) => s.url.includes('/token'))?.body ?? '');
    expect(body).toContain(`resource=${encodeURIComponent(pathless)}`);
    expect(body).not.toContain(encodeURIComponent(`${pathless}/`));
  });
});
