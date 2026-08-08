/** OAuth 2.1 + PKCE for MCP servers that require authorization (zero-dep).
 *
 *  The library owns the non-interactive machinery — metadata discovery, PKCE,
 *  dynamic client registration, authorization-code exchange, and token refresh —
 *  and delegates the inherently-interactive bits (storing tokens, redirecting
 *  the user, capturing the callback code) to an `McpAuthProvider` the consumer
 *  implements. All HTTP goes through the engine's fetch. */

import type { EngineFetch } from '../../network/types';
import { bytesToBase64 } from '../../util/base64';
import { assertSafeAuthUrl } from './url-guard';
import type { SsrfGuardOptions } from './url-guard';

// ─── Types ────────────────────────────────────────────────────────────────

export interface McpOAuthTokens {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  /** Stamped by us when the tokens were obtained (for expiry math). */
  obtained_at?: number;
}

export interface McpOAuthClientInfo {
  client_id: string;
  client_secret?: string;
}

export interface McpOAuthClientMetadata {
  redirect_uris: string[];
  client_name?: string;
  scope?: string;
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  /** OIDC Registration §2 application type (SEP-837). Defaults to `'native'` at registration, since
   *  an MCP client is normally a local process with a loopback redirect. Set explicitly to override. */
  application_type?: 'web' | 'native';
}

/** Consumer-implemented storage + interactive redirect. */
export interface McpAuthProvider {
  /** Where the authorization server redirects back to. */
  readonly redirectUrl: string;
  /** Metadata used for dynamic client registration. */
  readonly clientMetadata: McpOAuthClientMetadata;
  clientInformation(): McpOAuthClientInfo | undefined | Promise<McpOAuthClientInfo | undefined>;
  saveClientInformation?(info: McpOAuthClientInfo): void | Promise<void>;
  tokens(): McpOAuthTokens | undefined | Promise<McpOAuthTokens | undefined>;
  saveTokens(tokens: McpOAuthTokens): void | Promise<void>;
  /** Open / navigate to the authorization URL. */
  redirectToAuthorization(authorizationUrl: string): void | Promise<void>;
  saveCodeVerifier(verifier: string): void | Promise<void>;
  codeVerifier(): string | Promise<string>;
  /** Persist the CSRF state token generated during redirect (required for validation). */
  saveState(state: string): void | Promise<void>;
  /** Retrieve the persisted state token for comparison on callback. */
  state(): string | undefined | Promise<string | undefined>;
}

export interface AuthServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  /** The authorization server's issuer identifier (RFC 8414), used to validate the RFC 9207 `iss`
   *  returned with the authorization code. */
  issuer?: string;
  /** RFC 9207: the server states it returns `iss` on authorization responses. When true, a response
   *  WITHOUT `iss` is rejected — otherwise an attacker could simply strip the parameter to dodge
   *  the check. */
  authorization_response_iss_parameter_supported?: boolean;
}

/** Validate the RFC 9207 authorization-response issuer.
 *
 *  This is the mix-up-attack defence: without it a malicious authorization server can hand back a
 *  code minted by a DIFFERENT server, and the client will dutifully redeem it — replaying the
 *  user's credentials against a party they never intended to authorize.
 *
 *  Comparison is **exact string equality** per RFC 9207 §2.4 (RFC 3986 §6.2.1) — deliberately NOT
 *  URL-normalised. Normalising would make `https://as.example.com` and `https://as.example.com/`
 *  compare equal, and that leniency is precisely what an attacker looks for. */
export function validateAuthorizationResponseIss(
  iss: string | undefined,
  meta: Pick<AuthServerMetadata, 'issuer' | 'authorization_response_iss_parameter_supported'>,
): void {
  if (iss !== undefined) {
    if (iss !== meta.issuer) {
      throw new Error(
        `MCP OAuth: authorization response iss mismatch — got "${iss}", expected ` +
          `"${meta.issuer ?? '(unknown)'}". Refusing to exchange a code that may have been minted ` +
          `by a different authorization server.`,
      );
    }
    return;
  }
  if (meta.authorization_response_iss_parameter_supported) {
    throw new Error(
      'MCP OAuth: authorization response is missing the iss parameter, which this authorization ' +
        'server advertises that it sends. Refusing to exchange the code.',
    );
  }
}

/** Security options for the OAuth flow.  All fields default to the most
 *  restrictive posture.  Re-exported from `url-guard` for consumer convenience. */
export type { SsrfGuardOptions as McpOAuthSecurityOptions };

/** Thrown when an interactive authorization is required (the provider's
 *  `redirectToAuthorization` has been called; finish via `finishMcpAuth`). */
export class McpUnauthorizedError extends Error {
  constructor(message = 'MCP authorization required') {
    super(message);
    this.name = 'McpUnauthorizedError';
  }
}

// ─── PKCE ─────────────────────────────────────────────────────────────────

function base64url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

/** Generate a PKCE code verifier + S256 challenge. */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const verifier = base64url(random);
  return { verifier, challenge: base64url(await sha256(verifier)) };
}

/** Generate a cryptographically-random CSRF state token (32 bytes, base64url). */
export function generateState(): string {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  return base64url(random);
}

/** Constant-time-safe string comparison to prevent timing attacks on state tokens. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// ─── HTTP primitives (through the engine) ──────────────────────────────────

async function getJson(fetch: EngineFetch, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(
      { url, method: 'GET', headers: { accept: 'application/json' }, body: undefined, provider: 'mcp', model: 'oauth', responseType: 'json' },
      { queueName: 'mcp/oauth' },
    );
    return res.status < 400 ? (res.body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function postForm(fetch: EngineFetch, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(form).toString();
  const res = await fetch(
    { url, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, provider: 'mcp', model: 'oauth', responseType: 'json' },
    { queueName: 'mcp/oauth' },
  );
  if (res.status >= 400) throw new Error(`OAuth token endpoint returned ${res.status}`);
  return res.body as Record<string, unknown>;
}

// ─── Discovery / DCR / token ops ───────────────────────────────────────────

/** Discover the authorization-server metadata for an MCP server URL.
 *  All discovered endpoint URLs are validated against the SSRF guard before
 *  being returned; pass `security` to configure the allowlist or escape hatches. */
export async function discoverMetadata(
  fetch: EngineFetch,
  serverUrl: string,
  security: SsrfGuardOptions = {},
): Promise<AuthServerMetadata> {
  const origin = new URL(serverUrl).origin;
  const doc =
    (await getJson(fetch, `${origin}/.well-known/oauth-authorization-server`)) ??
    (await getJson(fetch, `${origin}/.well-known/openid-configuration`));
  if (!doc?.authorization_endpoint || !doc?.token_endpoint) {
    throw new Error(`MCP OAuth: no authorization-server metadata at ${origin}`);
  }
  const authorizationEndpoint = String(doc.authorization_endpoint);
  const tokenEndpoint = String(doc.token_endpoint);
  const registrationEndpoint = doc.registration_endpoint ? String(doc.registration_endpoint) : undefined;
  const issuer = typeof doc.issuer === 'string' ? doc.issuer : undefined;
  const issSupported = doc.authorization_response_iss_parameter_supported === true;

  // Guard every endpoint URL returned by the server against SSRF.
  assertSafeAuthUrl(authorizationEndpoint, serverUrl, security);
  assertSafeAuthUrl(tokenEndpoint, serverUrl, security);
  if (registrationEndpoint) assertSafeAuthUrl(registrationEndpoint, serverUrl, security);

  return {
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    registration_endpoint: registrationEndpoint,
    issuer,
    authorization_response_iss_parameter_supported: issSupported,
  };
}

/** Dynamic Client Registration (RFC 7591).
 *  The `serverUrl` anchor is required so the SSRF guard can check the endpoint origin. */
export async function registerClient(
  fetch: EngineFetch,
  registrationEndpoint: string,
  metadata: McpOAuthClientMetadata,
  serverUrl: string,
  security: SsrfGuardOptions = {},
): Promise<McpOAuthClientInfo> {
  assertSafeAuthUrl(registrationEndpoint, serverUrl, security);
  // SEP-837: declare the OIDC `application_type`. MCP clients are overwhelmingly native (a local
  // process or desktop app with a loopback redirect), and some authorization servers apply
  // stricter redirect-URI rules to `web` clients — omitting it lets the server guess, and the
  // guess is usually `web`. An explicit value from the caller always wins.
  const body: McpOAuthClientMetadata = { application_type: 'native', ...metadata };
  const res = await fetch(
    { url: registrationEndpoint, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body, provider: 'mcp', model: 'oauth', responseType: 'json' },
    { queueName: 'mcp/oauth' },
  );
  if (res.status >= 400) throw new Error(`MCP OAuth: client registration returned ${res.status}`);
  const doc = res.body as { client_id?: string; client_secret?: string };
  if (!doc.client_id) throw new Error('MCP OAuth: registration response missing client_id');
  return { client_id: doc.client_id, client_secret: doc.client_secret };
}

/** Build the authorization URL (code flow + PKCE). */
export function buildAuthorizationUrl(
  authorizationEndpoint: string,
  params: { client_id: string; redirect_uri: string; code_challenge: string; scope?: string; state?: string; resource?: string },
): string {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.client_id);
  url.searchParams.set('redirect_uri', params.redirect_uri);
  url.searchParams.set('code_challenge', params.code_challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (params.scope) url.searchParams.set('scope', params.scope);
  if (params.state) url.searchParams.set('state', params.state);
  if (params.resource) url.searchParams.set('resource', params.resource);
  return url.toString();
}

function toTokens(doc: Record<string, unknown>): McpOAuthTokens {
  return {
    access_token: String(doc.access_token),
    token_type: doc.token_type ? String(doc.token_type) : undefined,
    expires_in: typeof doc.expires_in === 'number' ? doc.expires_in : undefined,
    refresh_token: doc.refresh_token ? String(doc.refresh_token) : undefined,
    scope: doc.scope ? String(doc.scope) : undefined,
    obtained_at: Date.now(),
  };
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(
  fetch: EngineFetch,
  tokenEndpoint: string,
  p: { code: string; code_verifier: string; client_id: string; client_secret?: string; redirect_uri: string; resource?: string },
): Promise<McpOAuthTokens> {
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code: p.code,
    code_verifier: p.code_verifier,
    client_id: p.client_id,
    redirect_uri: p.redirect_uri,
  };
  if (p.client_secret) form.client_secret = p.client_secret;
  if (p.resource) form.resource = p.resource;
  return toTokens(await postForm(fetch, tokenEndpoint, form));
}

/** Refresh tokens with a refresh_token. */
export async function refreshTokens(
  fetch: EngineFetch,
  tokenEndpoint: string,
  p: { refresh_token: string; client_id: string; client_secret?: string },
): Promise<McpOAuthTokens> {
  const form: Record<string, string> = { grant_type: 'refresh_token', refresh_token: p.refresh_token, client_id: p.client_id };
  if (p.client_secret) form.client_secret = p.client_secret;
  return toTokens(await postForm(fetch, tokenEndpoint, form));
}

function isExpired(tokens: McpOAuthTokens): boolean {
  if (!tokens.expires_in || !tokens.obtained_at) return false; // unknown lifetime -> assume valid
  return Date.now() > tokens.obtained_at + tokens.expires_in * 1000 - 60_000; // 60s buffer
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

export class McpOAuth {
  private metadata: AuthServerMetadata | null = null;

  constructor(
    private readonly serverUrl: string,
    private readonly provider: McpAuthProvider,
    private readonly fetch: EngineFetch,
    private readonly security: SsrfGuardOptions = {},
  ) {}

  /** Ensure a usable access token exists. Returns 'redirect' if the user must
   *  authorize interactively (the provider has been asked to redirect). */
  async authorize(): Promise<'authorized' | 'redirect'> {
    const tokens = await this.provider.tokens();
    if (tokens?.access_token && !isExpired(tokens)) return 'authorized';
    if (tokens?.refresh_token && (await this.tryRefresh(tokens.refresh_token))) return 'authorized';
    await this.startRedirect();
    return 'redirect';
  }

  /** Bearer header for a request (refreshing a stale token if possible). */
  async authHeader(): Promise<Record<string, string>> {
    let tokens = await this.provider.tokens();
    if (tokens?.access_token && isExpired(tokens) && tokens.refresh_token) {
      if (await this.tryRefresh(tokens.refresh_token)) tokens = await this.provider.tokens();
    }
    return tokens?.access_token ? { authorization: `Bearer ${tokens.access_token}` } : {};
  }

  /** Handle a 401: refresh if we can (return true -> retry), else start a redirect. */
  async reauthorize(): Promise<boolean> {
    const tokens = await this.provider.tokens();
    if (tokens?.refresh_token && (await this.tryRefresh(tokens.refresh_token))) return true;
    await this.startRedirect();
    return false;
  }

  /** Finish the interactive flow: exchange the callback code for tokens.
   *  The `returnedState` MUST match the state persisted during redirect (CSRF guard). */
  async finish(code: string, returnedState: string, iss?: string): Promise<void> {
    const expectedState = await this.provider.state();
    if (!expectedState) {
      throw new Error('MCP OAuth: no state found — authorization was not started via this client');
    }
    if (!safeEqual(expectedState, returnedState)) {
      throw new Error('MCP OAuth: state mismatch — possible CSRF attack');
    }
    const meta = await this.ensureMetadata();
    // RFC 9207 — run BEFORE the code reaches the token endpoint. Validating afterwards would mean
    // the credentials have already been replayed, which is the attack this prevents.
    validateAuthorizationResponseIss(iss, meta);
    const client = await this.ensureClient(meta);
    const verifier = await this.provider.codeVerifier();
    const tokens = await exchangeCode(this.fetch, meta.token_endpoint, {
      code,
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: this.provider.redirectUrl,
      resource: this.serverUrl,
    });
    await this.provider.saveTokens(tokens);
  }

  private async startRedirect(): Promise<void> {
    const meta = await this.ensureMetadata();
    const client = await this.ensureClient(meta);
    const { verifier, challenge } = await generatePkce();
    const state = generateState();
    await this.provider.saveCodeVerifier(verifier);
    await this.provider.saveState(state);
    const url = buildAuthorizationUrl(meta.authorization_endpoint, {
      client_id: client.client_id,
      redirect_uri: this.provider.redirectUrl,
      code_challenge: challenge,
      scope: this.provider.clientMetadata.scope,
      state,
      resource: this.serverUrl,
    });
    await this.provider.redirectToAuthorization(url);
  }

  private async tryRefresh(refreshToken: string): Promise<boolean> {
    try {
      const meta = await this.ensureMetadata();
      const client = await this.ensureClient(meta);
      const tokens = await refreshTokens(this.fetch, meta.token_endpoint, {
        refresh_token: refreshToken,
        client_id: client.client_id,
        client_secret: client.client_secret,
      });
      await this.provider.saveTokens({ refresh_token: refreshToken, ...tokens });
      return true;
    } catch {
      return false;
    }
  }

  private async ensureMetadata(): Promise<AuthServerMetadata> {
    if (!this.metadata) this.metadata = await discoverMetadata(this.fetch, this.serverUrl, this.security);
    return this.metadata;
  }

  private async ensureClient(meta: AuthServerMetadata): Promise<McpOAuthClientInfo> {
    const existing = await this.provider.clientInformation();
    if (existing) return existing;
    if (!meta.registration_endpoint) {
      throw new Error('MCP OAuth: no client registered and the server has no registration endpoint');
    }
    const info = await registerClient(this.fetch, meta.registration_endpoint, this.provider.clientMetadata, this.serverUrl, this.security);
    await this.provider.saveClientInformation?.(info);
    return info;
  }
}
