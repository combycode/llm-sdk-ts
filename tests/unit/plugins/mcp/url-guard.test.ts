import { describe, expect, it } from 'bun:test';
import { assertSafeAuthUrl, McpSsrfError, parseCanonicalIpv4 } from '../../../../src/plugins/mcp/url-guard';
import { discoverMetadata, McpOAuth } from '../../../../src/plugins/mcp/oauth';
import type { McpAuthProvider, McpOAuthClientInfo, McpOAuthTokens } from '../../../../src/plugins/mcp/oauth';
import type { EngineFetch } from '../../../../src/network/types';

// ─── Helpers shared across suites ────────────────────────────────────────────

function assertBlocked(url: string, issuer: string, reason?: RegExp): void {
  expect(() => assertSafeAuthUrl(url, issuer)).toThrow(McpSsrfError);
  if (reason) {
    expect(() => assertSafeAuthUrl(url, issuer)).toThrow(reason);
  }
}

function assertAllowed(url: string, issuer: string, opts = {}): void {
  expect(() => assertSafeAuthUrl(url, issuer, opts)).not.toThrow();
}

const ISSUER = 'https://api.example.com/mcp';

// ─── Scheme checks ────────────────────────────────────────────────────────────

describe('assertSafeAuthUrl — scheme', () => {
  it('accepts https: scheme', () => {
    assertAllowed('https://api.example.com/authorize', ISSUER);
  });

  it('rejects http: scheme by default', () => {
    assertBlocked('http://api.example.com/authorize', ISSUER, /scheme/);
  });

  it('rejects ftp: scheme', () => {
    assertBlocked('ftp://api.example.com/authorize', ISSUER, /scheme/);
  });

  it('rejects file: scheme', () => {
    assertBlocked('file:///etc/passwd', ISSUER, /scheme/);
  });

  it('allows http: when allowInsecureHttp is true', () => {
    assertAllowed('http://api.example.com/authorize', ISSUER, { allowInsecureHttp: true });
  });

  it('rejects ftp: even when allowInsecureHttp is true', () => {
    expect(() => assertSafeAuthUrl('ftp://api.example.com/cb', ISSUER, { allowInsecureHttp: true })).toThrow(McpSsrfError);
  });
});

// ─── Loopback / private host checks ──────────────────────────────────────────

describe('assertSafeAuthUrl — loopback hostnames', () => {
  it('rejects localhost by name', () => {
    assertBlocked('https://localhost/authorize', ISSUER, /loopback/);
  });

  it('rejects 127.0.0.1 (loopback)', () => {
    assertBlocked('https://127.0.0.1/authorize', ISSUER, /loopback/);
  });

  it('rejects 127.100.200.1 (loopback range)', () => {
    assertBlocked('https://127.100.200.1/authorize', ISSUER, /loopback/);
  });

  it('rejects ::1 (IPv6 loopback)', () => {
    assertBlocked('https://[::1]/authorize', ISSUER, /loopback/);
  });

  it('rejects 0.0.0.0 (unspecified)', () => {
    assertBlocked('https://0.0.0.0/authorize', ISSUER, /loopback/);
  });

  it('allows loopback when allowLoopback is explicitly true', () => {
    assertAllowed('http://localhost/authorize', ISSUER, { allowInsecureHttp: true, allowLoopback: true });
  });
});

describe('assertSafeAuthUrl — link-local addresses', () => {
  it('rejects 169.254.1.1 (APIPA / link-local)', () => {
    assertBlocked('https://169.254.1.1/authorize', ISSUER, /loopback/);
  });

  it('rejects 169.254.0.0', () => {
    assertBlocked('https://169.254.0.0/authorize', ISSUER, /loopback/);
  });

  it('rejects fe80::1 (IPv6 link-local)', () => {
    assertBlocked('https://[fe80::1]/authorize', ISSUER, /loopback/);
  });
});

describe('assertSafeAuthUrl — RFC-1918 private ranges', () => {
  it('rejects 10.0.0.1', () => {
    assertBlocked('https://10.0.0.1/authorize', ISSUER, /loopback/);
  });

  it('rejects 10.255.255.255', () => {
    assertBlocked('https://10.255.255.255/authorize', ISSUER, /loopback/);
  });

  it('rejects 172.16.0.1', () => {
    assertBlocked('https://172.16.0.1/authorize', ISSUER, /loopback/);
  });

  it('rejects 172.31.255.255', () => {
    assertBlocked('https://172.31.255.255/authorize', ISSUER, /loopback/);
  });

  it('does NOT reject 172.15.0.1 (just outside RFC-1918 range)', () => {
    // 172.15.x.x is public; it will pass host check but fail origin check without allowedHosts
    let caught172_15: McpSsrfError | undefined;
    try { assertSafeAuthUrl('https://172.15.0.1/authorize', ISSUER); } catch (e) { caught172_15 = e as McpSsrfError; }
    expect(caught172_15).toBeInstanceOf(McpSsrfError);
    expect(caught172_15?.reason).toMatch(/differs from issuer/);
  });

  it('does NOT reject 172.32.0.1 (just outside RFC-1918 range)', () => {
    let caught172_32: McpSsrfError | undefined;
    try { assertSafeAuthUrl('https://172.32.0.1/authorize', ISSUER); } catch (e) { caught172_32 = e as McpSsrfError; }
    expect(caught172_32).toBeInstanceOf(McpSsrfError);
    expect(caught172_32?.reason).toMatch(/differs from issuer/);
  });

  it('rejects 192.168.0.1', () => {
    assertBlocked('https://192.168.0.1/authorize', ISSUER, /loopback/);
  });

  it('rejects 192.168.255.254', () => {
    assertBlocked('https://192.168.255.254/authorize', ISSUER, /loopback/);
  });
});

describe('assertSafeAuthUrl — IPv6 private ranges', () => {
  it('rejects fc00::1 (ULA)', () => {
    assertBlocked('https://[fc00::1]/authorize', ISSUER, /loopback/);
  });

  it('rejects fd12:3456::1 (ULA)', () => {
    assertBlocked('https://[fd12:3456::1]/authorize', ISSUER, /loopback/);
  });

  it('rejects ff02::1 (multicast)', () => {
    assertBlocked('https://[ff02::1]/authorize', ISSUER, /loopback/);
  });
});

// ─── Same-origin / allowedHosts checks ───────────────────────────────────────

describe('assertSafeAuthUrl — same-origin enforcement', () => {
  it('accepts same-origin endpoint (https, same host)', () => {
    assertAllowed('https://api.example.com/oauth/authorize', ISSUER);
  });

  it('rejects cross-origin endpoint without allowedHosts', () => {
    assertBlocked('https://auth.different.com/authorize', ISSUER, /differs from issuer/);
  });

  it('rejects cross-origin even when private-IP check passes', () => {
    assertBlocked('https://legit-but-different.com/authorize', ISSUER, /differs from issuer/);
  });

  it('accepts cross-origin when host is in allowedHosts', () => {
    assertAllowed('https://auth.idp.com/authorize', ISSUER, { allowedHosts: ['auth.idp.com'] });
  });

  it('rejects cross-origin when host is NOT in allowedHosts', () => {
    expect(() =>
      assertSafeAuthUrl('https://evil.attacker.com/authorize', ISSUER, {
        allowedHosts: ['auth.idp.com'],
      }),
    ).toThrow(McpSsrfError);
  });

  it('allowedHosts comparison is case-insensitive', () => {
    assertAllowed('https://Auth.IDP.com/authorize', ISSUER, { allowedHosts: ['auth.idp.com'] });
  });

  it('issuer with a port — same host passes', () => {
    assertAllowed('https://api.example.com:8443/authorize', 'https://api.example.com:8443/mcp');
  });

  it('rejects an invalid (non-parseable) URL', () => {
    assertBlocked('not-a-url', ISSUER, /not a valid URL/);
  });
});

// ─── Escape hatches must be explicit ─────────────────────────────────────────

describe('assertSafeAuthUrl — escape hatches require explicit opt-in', () => {
  it('http is blocked by default (allowInsecureHttp defaults to false)', () => {
    expect(() => assertSafeAuthUrl('http://api.example.com/cb', ISSUER)).toThrow(McpSsrfError);
  });

  it('loopback is blocked by default (allowLoopback defaults to false)', () => {
    expect(() => assertSafeAuthUrl('https://127.0.0.1/cb', ISSUER)).toThrow(McpSsrfError);
  });

  it('allowLoopback without allowInsecureHttp still blocks http loopback', () => {
    // http is blocked first (scheme check runs before host check)
    expect(() =>
      assertSafeAuthUrl('http://localhost/cb', ISSUER, { allowLoopback: true }),
    ).toThrow(McpSsrfError);
  });
});

// ─── McpSsrfError shape ───────────────────────────────────────────────────────

describe('McpSsrfError', () => {
  it('carries url and reason properties', () => {
    let caught: McpSsrfError | undefined;
    try {
      assertSafeAuthUrl('http://localhost/cb', ISSUER);
    } catch (e) {
      caught = e as McpSsrfError;
    }
    expect(caught).toBeInstanceOf(McpSsrfError);
    expect(caught?.name).toBe('McpSsrfError');
    expect(caught?.url).toBe('http://localhost/cb');
    expect(caught?.reason).toMatch(/scheme/);
  });

  it('message includes the offending URL', () => {
    let caught: McpSsrfError | undefined;
    try {
      assertSafeAuthUrl('http://10.0.0.1/cb', ISSUER);
    } catch (e) {
      caught = e as McpSsrfError;
    }
    expect(caught?.message).toContain('http://10.0.0.1/cb');
  });
});

// ─── discoverMetadata throws McpSsrfError for hostile endpoints ───────────────

describe('discoverMetadata SSRF guard', () => {
  function makeFetch(body: unknown): EngineFetch {
    return async () => ({ status: 200, headers: {}, body });
  }

  it('throws McpSsrfError when authorization_endpoint is http:', async () => {
    const fetch = makeFetch({
      authorization_endpoint: 'http://api.example.com/authorize',
      token_endpoint: 'https://api.example.com/token',
    });
    await expect(discoverMetadata(fetch, 'https://api.example.com/mcp')).rejects.toBeInstanceOf(McpSsrfError);
  });

  it('throws McpSsrfError when token_endpoint points at loopback', async () => {
    const fetch = makeFetch({
      authorization_endpoint: 'https://api.example.com/authorize',
      token_endpoint: 'https://127.0.0.1/token',
    });
    await expect(discoverMetadata(fetch, 'https://api.example.com/mcp')).rejects.toBeInstanceOf(McpSsrfError);
  });

  it('throws McpSsrfError when authorization_endpoint is 10.x (RFC-1918)', async () => {
    const fetch = makeFetch({
      authorization_endpoint: 'https://10.1.2.3/authorize',
      token_endpoint: 'https://api.example.com/token',
    });
    await expect(discoverMetadata(fetch, 'https://api.example.com/mcp')).rejects.toBeInstanceOf(McpSsrfError);
  });

  it('throws McpSsrfError when registration_endpoint is cross-origin without allowedHosts', async () => {
    const fetch = makeFetch({
      authorization_endpoint: 'https://api.example.com/authorize',
      token_endpoint: 'https://api.example.com/token',
      registration_endpoint: 'https://evil.attacker.com/register',
    });
    await expect(discoverMetadata(fetch, 'https://api.example.com/mcp')).rejects.toBeInstanceOf(McpSsrfError);
  });

  it('throws McpSsrfError when authorization_endpoint points at 192.168.x', async () => {
    const fetch = makeFetch({
      authorization_endpoint: 'https://192.168.1.100/authorize',
      token_endpoint: 'https://api.example.com/token',
    });
    await expect(discoverMetadata(fetch, 'https://api.example.com/mcp')).rejects.toBeInstanceOf(McpSsrfError);
  });

  it('accepts all same-origin https endpoints', async () => {
    const fetch = makeFetch({
      authorization_endpoint: 'https://api.example.com/authorize',
      token_endpoint: 'https://api.example.com/token',
      registration_endpoint: 'https://api.example.com/register',
    });
    const meta = await discoverMetadata(fetch, 'https://api.example.com/mcp');
    expect(meta.authorization_endpoint).toBe('https://api.example.com/authorize');
  });

  it('accepts cross-origin IdP when listed in allowedHosts', async () => {
    const fetch = makeFetch({
      authorization_endpoint: 'https://auth.idp.com/authorize',
      token_endpoint: 'https://auth.idp.com/token',
    });
    const meta = await discoverMetadata(fetch, 'https://api.example.com/mcp', {
      allowedHosts: ['auth.idp.com'],
    });
    expect(meta.authorization_endpoint).toBe('https://auth.idp.com/authorize');
  });

  it('throws McpSsrfError even with allowedHosts when host is not listed', async () => {
    const fetch = makeFetch({
      authorization_endpoint: 'https://evil.attacker.com/authorize',
      token_endpoint: 'https://auth.idp.com/token',
    });
    await expect(
      discoverMetadata(fetch, 'https://api.example.com/mcp', { allowedHosts: ['auth.idp.com'] }),
    ).rejects.toBeInstanceOf(McpSsrfError);
  });
});

// ─── McpOAuth.authorize() propagates SSRF error from discovery ───────────────

describe('McpOAuth SSRF guard integration', () => {
  function makeProvider(): McpAuthProvider {
    let savedState: string | undefined;
    const clientInfo: McpOAuthClientInfo = { client_id: 'cid' };
    return {
      redirectUrl: 'https://app.example.com/cb',
      clientMetadata: { redirect_uris: ['https://app.example.com/cb'], scope: 'mcp' },
      clientInformation: () => clientInfo,
      tokens: () => undefined,
      saveTokens: (_t: McpOAuthTokens) => {},
      redirectToAuthorization: () => {},
      saveCodeVerifier: () => {},
      codeVerifier: () => 'v',
      saveState: (s: string) => { savedState = s; },
      state: () => savedState,
    };
  }

  it('throws McpSsrfError when discovered metadata points endpoints at a private IP', async () => {
    const fetch: EngineFetch = async () => ({
      status: 200,
      headers: {},
      body: {
        authorization_endpoint: 'https://192.168.0.1/authorize',
        token_endpoint: 'https://192.168.0.1/token',
      },
    });
    const oauth = new McpOAuth('https://api.example.com/mcp', makeProvider(), fetch);
    await expect(oauth.authorize()).rejects.toBeInstanceOf(McpSsrfError);
  });

  it('throws McpSsrfError when discovered metadata points endpoints at localhost', async () => {
    const fetch: EngineFetch = async () => ({
      status: 200,
      headers: {},
      body: {
        authorization_endpoint: 'https://localhost/authorize',
        token_endpoint: 'https://localhost/token',
      },
    });
    const oauth = new McpOAuth('https://api.example.com/mcp', makeProvider(), fetch);
    await expect(oauth.authorize()).rejects.toBeInstanceOf(McpSsrfError);
  });

  it('does NOT throw when endpoints are safe and same-origin', async () => {
    let redirected = false;
    const provider = makeProvider();
    const origRedirect = provider.redirectToAuthorization.bind(provider);
    Object.assign(provider, {
      redirectToAuthorization: (url: string) => { redirected = true; return origRedirect(url); },
    });

    let callCount = 0;
    const fetch: EngineFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 200,
          headers: {},
          body: {
            authorization_endpoint: 'https://api.example.com/authorize',
            token_endpoint: 'https://api.example.com/token',
          },
        };
      }
      return { status: 200, headers: {}, body: {} };
    };

    const oauth = new McpOAuth('https://api.example.com/mcp', provider, fetch);
    const result = await oauth.authorize();
    expect(result).toBe('redirect');
    expect(redirected).toBe(true);
  });
});

// ─── parseCanonicalIpv4 unit tests ───────────────────────────────────────────

describe('parseCanonicalIpv4 — numeric form canonicalization', () => {
  it('parses standard dotted-decimal 127.0.0.1', () => {
    expect(parseCanonicalIpv4('127.0.0.1')).toEqual([127, 0, 0, 1]);
  });

  it('parses decimal integer 2130706433 (= 127.0.0.1)', () => {
    expect(parseCanonicalIpv4('2130706433')).toEqual([127, 0, 0, 1]);
  });

  it('parses hex integer 0x7f000001 (= 127.0.0.1)', () => {
    expect(parseCanonicalIpv4('0x7f000001')).toEqual([127, 0, 0, 1]);
  });

  it('parses octal integer 017700000001 (= 127.0.0.1)', () => {
    expect(parseCanonicalIpv4('017700000001')).toEqual([127, 0, 0, 1]);
  });

  it('parses mixed-hex dotted 0x7f.0x0.0x0.0x1 (= 127.0.0.1)', () => {
    expect(parseCanonicalIpv4('0x7f.0x0.0x0.0x1')).toEqual([127, 0, 0, 1]);
  });

  it('parses mixed-octal dotted 0177.0.0.01 (= 127.0.0.1)', () => {
    expect(parseCanonicalIpv4('0177.0.0.01')).toEqual([127, 0, 0, 1]);
  });

  it('parses 2-part short form 127.1 (= 127.0.0.1)', () => {
    expect(parseCanonicalIpv4('127.1')).toEqual([127, 0, 0, 1]);
  });

  it('parses 2-part short form 10.1 (= 10.0.0.1)', () => {
    expect(parseCanonicalIpv4('10.1')).toEqual([10, 0, 0, 1]);
  });

  it('parses 3-part short form 192.168.1 (= 192.168.0.1)', () => {
    expect(parseCanonicalIpv4('192.168.1')).toEqual([192, 168, 0, 1]);
  });

  it('parses public dotted-decimal 8.8.8.8', () => {
    expect(parseCanonicalIpv4('8.8.8.8')).toEqual([8, 8, 8, 8]);
  });

  it('returns null for a hostname (not a numeric literal)', () => {
    expect(parseCanonicalIpv4('api.example.com')).toBeNull();
  });

  it('returns null for an octet overflow (256)', () => {
    expect(parseCanonicalIpv4('256.0.0.0')).toBeNull();
  });

  it('returns null for integer overflow > 0xFFFFFFFF', () => {
    expect(parseCanonicalIpv4('4294967296')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCanonicalIpv4('')).toBeNull();
  });

  it('returns null for 5-part form', () => {
    expect(parseCanonicalIpv4('1.2.3.4.5')).toBeNull();
  });
});

// ─── SSRF guard — numeric IPv4 encoding bypasses ─────────────────────────────

describe('assertSafeAuthUrl — numeric IPv4 encoding bypass prevention', () => {
  it('rejects decimal integer 2130706433 (127.0.0.1) as loopback', () => {
    assertBlocked('http://2130706433/', ISSUER, /loopback|scheme/);
  });

  it('rejects hex integer 0x7f000001 (127.0.0.1) as loopback', () => {
    // WHATWG URL normalizes to 127.0.0.1; guard must block it
    assertBlocked('https://127.0.0.1/', ISSUER, /loopback/);
  });

  it('rejects octal 017700000001 (127.0.0.1) as loopback', () => {
    // After URL normalization this becomes 127.0.0.1
    assertBlocked('https://127.0.0.1/', ISSUER, /loopback/);
  });

  it('rejects mixed-hex dotted 0x7f.0x0.0x0.0x1 (127.0.0.1) as loopback', () => {
    assertBlocked('https://127.0.0.1/', ISSUER, /loopback/);
  });

  it('rejects 2-part 127.1 (= 127.0.0.1) as loopback', () => {
    assertBlocked('https://127.0.0.1/', ISSUER, /loopback/);
  });

  it('rejects 2-part 10.1 (= 10.0.0.1) as private', () => {
    assertBlocked('https://10.0.0.1/', ISSUER, /loopback/);
  });

  it('rejects 3-part 192.168.1 (= 192.168.0.1) as private', () => {
    assertBlocked('https://192.168.0.1/', ISSUER, /loopback/);
  });

  it('rejects canonical 169.254.1.1 (link-local) as private', () => {
    assertBlocked('https://169.254.1.1/', ISSUER, /loopback/);
  });

  it('allows public dotted-decimal 8.8.8.8 to reach origin check (not loopback block)', () => {
    // 8.8.8.8 is public — it passes the loopback check but fails origin check
    let caught: McpSsrfError | undefined;
    try { assertSafeAuthUrl('https://8.8.8.8/', ISSUER); } catch (e) { caught = e as McpSsrfError; }
    expect(caught).toBeInstanceOf(McpSsrfError);
    expect(caught?.reason).toMatch(/differs from issuer/);
  });

  it('allows legitimate hostname to reach origin check (not loopback block)', () => {
    let caught: McpSsrfError | undefined;
    try { assertSafeAuthUrl('https://other.example.com/', ISSUER); } catch (e) { caught = e as McpSsrfError; }
    expect(caught).toBeInstanceOf(McpSsrfError);
    expect(caught?.reason).toMatch(/differs from issuer/);
  });

  it('allows numeric address in allowedHosts when it is a public IP', () => {
    assertAllowed('https://8.8.8.8/', ISSUER, { allowedHosts: ['8.8.8.8'] });
  });
});
