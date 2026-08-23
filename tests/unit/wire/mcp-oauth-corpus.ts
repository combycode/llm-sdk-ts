/** The corpus for the MCP OAuth flow.
 *
 *  Five requests and one URL: two well-known discovery probes, dynamic client
 *  registration, the code exchange, the refresh, and the authorization URL the
 *  user's browser opens. The last one is not a request this library sends, but it
 *  is a URL this library BUILDS, and getting a parameter wrong there fails in the
 *  same way.
 *
 *  Unlike the transport, none of this has live coverage: exercising it needs a real
 *  authorization server and a browser round-trip. The freeze is the oracle, and it
 *  is the only one — a migration here is verified against what the code sent
 *  before, not against what a server accepted.
 */

import {
  buildAuthorizationUrl,
  discoverMetadata,
  exchangeCode,
  refreshTokens,
  registerClient,
} from '../../../src/plugins/mcp/oauth';

export const SERVER_URL = 'https://mcp.example.com/mcp';
export const TOKEN_ENDPOINT = 'https://auth.example.com/oauth/token';
// Same origin as the MCP server: the SSRF guard rejects a cross-origin registration
// endpoint before the request is ever built, so a cross-origin case would freeze
// nothing at all rather than freezing the request it looks like it froze.
export const REGISTRATION_ENDPOINT = 'https://mcp.example.com/oauth/register';
export const AUTHORIZATION_ENDPOINT = 'https://auth.example.com/oauth/authorize';

export type OauthOp = 'discover' | 'register' | 'exchange' | 'refresh' | 'authorizeUrl';

export interface OauthCase {
  name: string;
  op: OauthOp;
  /** discover: answer the FIRST well-known probe with a 404, so the OIDC fallback
   *  is exercised too. */
  firstProbeMisses?: boolean;
  metadata?: Record<string, unknown>;
  exchange?: {
    code: string;
    code_verifier: string;
    client_id: string;
    client_secret?: string;
    redirect_uri: string;
    resource?: string;
  };
  refresh?: { refresh_token: string; client_id: string; client_secret?: string };
  authorize?: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    scope?: string;
    state?: string;
    resource?: string;
  };
}

export const OAUTH_CASES: OauthCase[] = [
  { name: 'discover.oauthFirst', op: 'discover' },
  { name: 'discover.oidcFallback', op: 'discover', firstProbeMisses: true },
  {
    // `application_type: native` is sent unless the caller overrides it: some
    // authorization servers apply stricter redirect rules to a `web` client, and
    // omitting the field lets the server guess `web`.
    name: 'register.default',
    op: 'register',
    metadata: { client_name: 'test', redirect_uris: ['http://127.0.0.1:8976/callback'] },
  },
  {
    name: 'register.explicitType',
    op: 'register',
    metadata: { client_name: 'test', redirect_uris: ['https://app.example.com/cb'], application_type: 'web' },
  },
  {
    name: 'exchange.public',
    op: 'exchange',
    exchange: {
      code: 'auth-code-1',
      code_verifier: 'ver-1',
      client_id: 'client-1',
      redirect_uri: 'http://127.0.0.1:8976/callback',
    },
  },
  {
    name: 'exchange.confidentialWithResource',
    op: 'exchange',
    exchange: {
      code: 'auth code/2+3',
      code_verifier: 'ver-2',
      client_id: 'client-2',
      client_secret: 'shh secret',
      redirect_uri: 'http://127.0.0.1:8976/callback',
      resource: 'https://mcp.example.com/mcp',
    },
  },
  { name: 'refresh.public', op: 'refresh', refresh: { refresh_token: 'rt-1', client_id: 'client-1' } },
  {
    name: 'refresh.confidential',
    op: 'refresh',
    refresh: { refresh_token: 'rt-2', client_id: 'client-2', client_secret: 'shh secret' },
  },
  {
    name: 'authorize.minimal',
    op: 'authorizeUrl',
    authorize: { client_id: 'client-1', redirect_uri: 'http://127.0.0.1:8976/callback', code_challenge: 'chal-1' },
  },
  {
    name: 'authorize.full',
    op: 'authorizeUrl',
    authorize: {
      client_id: 'client-1',
      redirect_uri: 'http://127.0.0.1:8976/callback',
      code_challenge: 'chal-1',
      scope: 'mcp:read mcp:write',
      state: 'st-1',
      resource: 'https://mcp.example.com/mcp',
    },
  },
];

const METADATA_DOC = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: AUTHORIZATION_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
  registration_endpoint: REGISTRATION_ENDPOINT,
  authorization_response_iss_parameter_supported: true,
};

const TOKEN_DOC = {
  access_token: 'at-1',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'rt-next',
  scope: 'mcp:read',
};

/** Run one case against a capturing fetch and return every request it made.
 *  `authorizeUrl` makes no request; its URL is returned as the artifact instead. */
export async function driveOauth(c: OauthCase): Promise<unknown[]> {
  if (c.op === 'authorizeUrl') {
    return [{ __url: buildAuthorizationUrl(AUTHORIZATION_ENDPOINT, c.authorize as never) }];
  }

  const seen: unknown[] = [];
  let call = 0;
  const fetch = (async (req: unknown) => {
    seen.push(req);
    const missed = c.firstProbeMisses && call === 0;
    call++;
    return {
      status: missed ? 404 : 200,
      headers: { 'content-type': 'application/json' },
      body: missed ? {} : c.op === 'register' ? { client_id: 'client-new' } : c.op === 'discover' ? METADATA_DOC : TOKEN_DOC,
    };
  }) as never;

  try {
    switch (c.op) {
      case 'discover':
        await discoverMetadata(fetch, SERVER_URL);
        break;
      case 'register':
        await registerClient(fetch, REGISTRATION_ENDPOINT, c.metadata as never, SERVER_URL);
        break;
      case 'exchange':
        await exchangeCode(fetch, TOKEN_ENDPOINT, c.exchange as never);
        break;
      case 'refresh':
        await refreshTokens(fetch, TOKEN_ENDPOINT, c.refresh as never);
        break;
    }
  } catch {
    /* the fake document may not satisfy the caller; the requests are already captured */
  }
  return seen;
}

export const oauthKey = (c: OauthCase, i: number): string => `mcp-oauth/${c.op}.${c.name}${i ? `.${i}` : ''}`;
