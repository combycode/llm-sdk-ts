import { describe, expect, it } from 'bun:test';
import { buildAuthorizationUrl, generatePkce, generateState, McpOAuth } from '../../../../src/plugins/mcp/oauth';
import type { McpAuthProvider, McpOAuthClientInfo, McpOAuthTokens } from '../../../../src/plugins/mcp/oauth';
import type { EngineFetch } from '../../../../src/network/types';

describe('generatePkce', () => {
  it('produces a base64url verifier and an S256 challenge', async () => {
    const { verifier, challenge } = await generatePkce();
    expect(/^[A-Za-z0-9_-]+$/.test(verifier)).toBe(true);
    expect(/^[A-Za-z0-9_-]+$/.test(challenge)).toBe(true);
    expect(challenge).not.toBe(verifier);

    // challenge MUST equal base64url(sha256(verifier))
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const expected = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });
});

describe('generateState', () => {
  it('produces a base64url string of sufficient entropy', () => {
    const state = generateState();
    expect(/^[A-Za-z0-9_-]+$/.test(state)).toBe(true);
    expect(state.length).toBeGreaterThan(20);
  });

  it('produces unique values each call', () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});

describe('buildAuthorizationUrl', () => {
  it('sets the code-flow + PKCE query params', () => {
    const url = new URL(
      buildAuthorizationUrl('https://auth.example/authorize', {
        client_id: 'cid',
        redirect_uri: 'http://localhost/cb',
        code_challenge: 'chal',
        scope: 'mcp',
        resource: 'https://srv/mcp',
      }),
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/cb');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('mcp');
    expect(url.searchParams.get('resource')).toBe('https://srv/mcp');
  });

  it('includes the state param when provided', () => {
    const url = new URL(
      buildAuthorizationUrl('https://auth.example/authorize', {
        client_id: 'cid',
        redirect_uri: 'http://localhost/cb',
        code_challenge: 'chal',
        state: 'csrf-token-abc',
      }),
    );
    expect(url.searchParams.get('state')).toBe('csrf-token-abc');
  });
});

// ─── CSRF state validation via McpOAuth.finish() ──────────────────────────────

function makeFakeFetch(tokenResponse: Record<string, unknown>): EngineFetch {
  return async () => ({
    status: 200,
    headers: {},
    body: tokenResponse,
  });
}

function makeProvider(overrides: Partial<McpAuthProvider> = {}): McpAuthProvider & {
  _state: string | undefined;
  _verifier: string;
  _tokens: McpOAuthTokens | undefined;
} {
  let savedState: string | undefined;
  let savedVerifier = 'test-verifier';
  let savedTokens: McpOAuthTokens | undefined;
  const clientInfo: McpOAuthClientInfo = { client_id: 'cid' };
  return {
    redirectUrl: 'http://localhost/cb',
    clientMetadata: { redirect_uris: ['http://localhost/cb'], scope: 'mcp' },
    clientInformation: () => clientInfo,
    tokens: () => savedTokens,
    saveTokens: (t) => { savedTokens = t; },
    redirectToAuthorization: () => {},
    saveCodeVerifier: (v) => { savedVerifier = v; },
    codeVerifier: () => savedVerifier,
    saveState: (s) => { savedState = s; },
    state: () => savedState,
    get _state() { return savedState; },
    get _verifier() { return savedVerifier; },
    get _tokens() { return savedTokens; },
    ...overrides,
  };
}

describe('McpOAuth CSRF state validation', () => {
  // Endpoints are same-origin with the MCP server (https://srv) — the default
  // secure-by-default posture requires this; cross-origin IdPs need allowedHosts.
  const metaResponse = {
    authorization_endpoint: 'https://srv/authorize',
    token_endpoint: 'https://srv/token',
    registration_endpoint: 'https://srv/register',
  };

  function makeFetchSequence(responses: Array<{ status: number; body: unknown }>): EngineFetch {
    let idx = 0;
    return async () => {
      const resp = responses[idx] ?? responses[responses.length - 1];
      idx++;
      return { status: resp.status, headers: {}, body: resp.body };
    };
  }

  it('finish() rejects when state is missing (no prior redirect)', async () => {
    const provider = makeProvider();
    const fetch = makeFakeFetch({ access_token: 'tok' });
    const oauth = new McpOAuth('https://srv/mcp', provider, fetch);
    await expect(oauth.finish('code', 'any-state')).rejects.toThrow('no state found');
  });

  it('finish() rejects when state does not match (CSRF attempt)', async () => {
    const provider = makeProvider();
    const fetch = makeFetchSequence([
      { status: 200, body: metaResponse },
      { status: 200, body: { client_id: 'cid' } },
      { status: 200, body: { access_token: 'tok' } },
    ]);
    const oauth = new McpOAuth('https://srv/mcp', provider, fetch);
    // Simulate a prior redirect that saved a state
    await provider.saveState('correct-state');
    await expect(oauth.finish('code', 'wrong-state')).rejects.toThrow('state mismatch');
  });

  it('finish() succeeds when state matches', async () => {
    const provider = makeProvider();
    // fetch[0] = metadata discovery; clientInformation() returns existing info (no registration);
    // fetch[1] = token exchange
    const fetch = makeFetchSequence([
      { status: 200, body: metaResponse },
      { status: 200, body: { access_token: 'tok', token_type: 'Bearer' } },
    ]);
    const oauth = new McpOAuth('https://srv/mcp', provider, fetch);
    await provider.saveState('correct-state');
    await oauth.finish('code', 'correct-state');
    expect(provider._tokens?.access_token).toBe('tok');
  });
});
