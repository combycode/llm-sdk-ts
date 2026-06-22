/** SSRF guard for OAuth/MCP discovered endpoints.
 *
 *  All URLs derived from server-controlled discovery metadata (authorization_endpoint,
 *  token_endpoint, registration_endpoint, the issuer URL itself) MUST pass
 *  `assertSafeAuthUrl` before any fetch is made through the engine.
 *
 *  Secure by default:
 *  - Only `https:` is allowed (opt-in `allowInsecureHttp` for explicit local-dev only).
 *  - Loopback / link-local / private / reserved hosts are blocked by default
 *    (opt-in `allowLoopback` for explicit local-dev only).
 *  - The discovered endpoint must be same-origin as the issuer unless the caller
 *    supplies an explicit `allowedHosts` allowlist.
 *
 *  Cross-env: pure URL / IP-literal parsing only — no DNS, no node: imports. */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Options that relax the SSRF guard. All fields default to the most restrictive
 *  posture. Escape hatches are intentionally verbose to signal risk at the call site. */
export interface SsrfGuardOptions {
  /**
   * When set, a discovered endpoint is accepted if its hostname matches ANY entry
   * in this list (case-insensitive, exact match on the registered domain / host).
   * Without this, same-origin with the issuer is enforced.
   *
   * Use this for real IdPs hosted on a separate domain from the MCP server
   * (e.g. issuer = `https://api.example.com`, auth server = `https://auth.example.com`).
   */
  allowedHosts?: readonly string[];

  /**
   * Set to `true` ONLY for explicit local development to allow `http:` scheme.
   * NEVER set in production. Defaults to `false`.
   */
  allowInsecureHttp?: boolean;

  /**
   * Set to `true` ONLY for explicit local development to allow loopback addresses
   * (localhost, 127.x, ::1) and private/reserved ranges.
   * NEVER set in production. Defaults to `false`.
   */
  allowLoopback?: boolean;
}

// ─── Error ────────────────────────────────────────────────────────────────────

/** Thrown when a server-controlled URL fails the SSRF safety check. */
export class McpSsrfError extends Error {
  /** The offending URL (as a string). */
  readonly url: string;
  /** Human-readable reason the URL was blocked. */
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`MCP SSRF guard: rejected URL "${url}" — ${reason}`);
    this.name = 'McpSsrfError';
    this.url = url;
    this.reason = reason;
  }
}

// ─── Blocked range constants ───────────────────────────────────────────────────

/** Hostnames that are always loopback / internal regardless of resolution. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '0.0.0.0', 'ip6-localhost', 'ip6-loopback']);

/** IPv6 loopback and unspecified address literals. */
const IPV6_LOOPBACK_LITERALS: ReadonlySet<string> = new Set(['::1', '::', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0']);

/** IPv4 private / reserved prefix blocks checked against the first octets.
 *  Each entry: [prefix octets to check, bits of those octets that are fixed].
 *  We implement them as simple numeric range checks for cross-env correctness
 *  without importing any library. */

// Private/reserved IPv4 ranges checked via `isPrivateIpv4`:
// 127.0.0.0/8    — loopback
// 10.0.0.0/8     — RFC-1918 private
// 172.16.0.0/12  — RFC-1918 private (172.16–172.31)
// 192.168.0.0/16 — RFC-1918 private
// 169.254.0.0/16 — link-local (APIPA)
// 100.64.0.0/10  — IANA shared address space (Carrier-Grade NAT)
// 0.0.0.0/8      — "This" network (invalid source)
// 240.0.0.0/4    — Reserved (Class E)
// 192.0.0.0/24   — IETF Protocol Assignments
// 192.0.2.0/24   — TEST-NET-1 (documentation)
// 198.51.100.0/24 — TEST-NET-2
// 203.0.113.0/24 — TEST-NET-3
// 198.18.0.0/15  — benchmarking

/** IPv6 private/link-local prefixes (checked as lowercased hex strings). */
const IPV6_PRIVATE_PREFIXES: readonly string[] = [
  'fc', 'fd',          // fc00::/7  — Unique local (ULA)
  'fe80',              // fe80::/10 — Link-local
  'fec0',              // fec0::/10 — Site-local (deprecated but block anyway)
  'ff',                // ff00::/8  — Multicast
  '64:ff9b',           // 64:ff9b::/96 — IPv4-mapped
  '::ffff:',           // ::ffff:0:0/96 — IPv4-mapped (bracket notation)
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Maximum value for a valid 32-bit IPv4 address (0xFFFFFFFF). */
const MAX_IPV4_INT = 0xffffffff;

/** Parse a single IPv4 part string (decimal / octal / hex) to a number.
 *  Returns null on parse failure or overflow. */
function parseIpv4Part(part: string): number | null {
  if (part === '' || part === null) return null;
  let val: number;
  if (part.startsWith('0x') || part.startsWith('0X')) {
    val = parseInt(part, 16);
  } else if (part.startsWith('0') && part.length > 1) {
    val = parseInt(part, 8);
  } else {
    val = parseInt(part, 10);
  }
  if (!Number.isFinite(val) || val < 0 || !Number.isInteger(val)) return null;
  return val;
}

/** Canonical IPv4 parser: accepts 1-, 2-, 3-, and 4-part forms with each part
 *  in decimal, octal (0-prefix), or hex (0x-prefix). Converts to 4 octets.
 *
 *  RFC 3986 / POSIX inet_aton support these short forms:
 *    1-part:  entire address as a 32-bit integer (e.g. 2130706433 = 127.0.0.1)
 *    2-part:  first octet + 24-bit remainder  (e.g. 127.1 = 127.0.0.1)
 *    3-part:  first two octets + 16-bit remainder
 *    4-part:  standard dotted-decimal / hex / octal
 *
 *  Returns null if the host is not a parseable IPv4 literal (e.g. a hostname). */
export function parseCanonicalIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;

  const parsed = parts.map(parseIpv4Part);
  if (parsed.some((v) => v === null)) return null;
  const vals = parsed as number[];

  let addr32: number;
  switch (vals.length) {
    case 1: {
      if (vals[0] > MAX_IPV4_INT) return null;
      addr32 = vals[0];
      break;
    }
    case 2: {
      if (vals[0] > 255 || vals[1] > 0xffffff) return null;
      addr32 = (vals[0] << 24) | vals[1];
      break;
    }
    case 3: {
      if (vals[0] > 255 || vals[1] > 255 || vals[2] > 0xffff) return null;
      addr32 = (vals[0] << 24) | (vals[1] << 16) | vals[2];
      break;
    }
    case 4: {
      if (vals.some((v) => v > 255)) return null;
      addr32 = (vals[0] << 24) | (vals[1] << 16) | (vals[2] << 8) | vals[3];
      break;
    }
    default:
      return null;
  }

  // Convert the 32-bit integer to 4 octets.
  // Use >>> 0 to treat the value as unsigned before masking.
  addr32 = addr32 >>> 0;
  return [
    (addr32 >>> 24) & 0xff,
    (addr32 >>> 16) & 0xff,
    (addr32 >>> 8) & 0xff,
    addr32 & 0xff,
  ];
}

function isPrivateIpv4(host: string): boolean {
  const o = parseCanonicalIpv4(host);
  if (!o) return false;
  const [a, b] = o;
  return (
    a === 0 ||                                       // 0.0.0.0/8
    a === 10 ||                                      // 10.0.0.0/8
    a === 127 ||                                     // 127.0.0.0/8  loopback
    (a === 100 && b >= 64 && b <= 127) ||            // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) ||                      // 169.254.0.0/16 link-local
    (a === 172 && b >= 16 && b <= 31) ||             // 172.16.0.0/12
    (a === 192 && b === 0 && o[2] === 0) ||          // 192.0.0.0/24
    (a === 192 && b === 0 && o[2] === 2) ||          // 192.0.2.0/24 TEST-NET-1
    (a === 192 && b === 168) ||                      // 192.168.0.0/16
    (a === 198 && b === 18) ||                       // 198.18.0.0/15 benchmarking
    (a === 198 && b === 19) ||                       // 198.19.0.0/15 benchmarking
    (a === 198 && b === 51 && o[2] === 100) ||       // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && o[2] === 113) ||        // 203.0.113.0/24 TEST-NET-3
    a >= 240                                         // 240.0.0.0/4 reserved Class E
  );
}

function isPrivateIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (IPV6_LOOPBACK_LITERALS.has(lower)) return true;
  for (const prefix of IPV6_PRIVATE_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

/** Return true if the host is a known-private / loopback / reserved address. */
function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(lower)) return true;
  // Strip brackets from IPv6 literals
  const stripped = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  if (isPrivateIpv4(stripped)) return true;
  if (stripped.includes(':') && isPrivateIpv6(stripped)) return true;
  return false;
}

/** Extract the registrable host for same-origin comparison.
 *  We do NOT attempt public-suffix parsing — we simply compare hostnames exactly,
 *  which is conservative (same-origin, not same-site). Use `allowedHosts` to
 *  permit a separate IdP host. */
function hostnameOf(urlStr: string): string {
  return new URL(urlStr).hostname.toLowerCase();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Assert that `url` is safe to use as a server-controlled OAuth endpoint.
 *
 * Throws `McpSsrfError` if any check fails:
 * 1. Scheme must be `https:` (unless `opts.allowInsecureHttp` is explicitly `true`).
 * 2. Host must not be loopback / private / reserved (unless `opts.allowLoopback` is explicitly `true`).
 * 3. Host must be same-origin as `issuerUrl` OR match one of `opts.allowedHosts`.
 *
 * @param url         The discovered/auth endpoint URL to validate.
 * @param issuerUrl   The MCP server's base URL (the trusted origin anchor).
 * @param opts        Security options — all default to the most restrictive posture.
 */
export function assertSafeAuthUrl(url: string, issuerUrl: string, opts: SsrfGuardOptions = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpSsrfError(url, 'not a valid URL');
  }

  // 1. Scheme check
  if (parsed.protocol !== 'https:') {
    if (!opts.allowInsecureHttp) {
      throw new McpSsrfError(url, `scheme "${parsed.protocol}" is not allowed; only https: is permitted`);
    }
    // allowInsecureHttp is explicitly enabled — still block any non-http/https scheme
    if (parsed.protocol !== 'http:') {
      throw new McpSsrfError(url, `scheme "${parsed.protocol}" is not allowed; only https: (or http: with allowInsecureHttp) is permitted`);
    }
  }

  const hostname = parsed.hostname.toLowerCase();

  // 2. Private / loopback host check
  const hostIsBlocked = isBlockedHost(hostname);
  if (!opts.allowLoopback && hostIsBlocked) {
    throw new McpSsrfError(url, `host "${hostname}" resolves to a loopback, link-local, or private address`);
  }

  // 3. Origin / allowlist check.
  // When allowLoopback is true and the host IS a blocked (loopback/private) address, skip
  // the origin check: explicit local-dev mode means the auth server won't share origin.
  if (opts.allowLoopback && hostIsBlocked) return;

  const issuerHostname = hostnameOf(issuerUrl);

  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    const lower = opts.allowedHosts.map((h) => h.toLowerCase());
    if (!lower.includes(hostname) && hostname !== issuerHostname) {
      throw new McpSsrfError(
        url,
        `host "${hostname}" is not in the allowedHosts list and does not match the issuer host "${issuerHostname}"`,
      );
    }
  } else {
    // No allowlist — enforce same-origin with the issuer
    if (hostname !== issuerHostname) {
      throw new McpSsrfError(
        url,
        `host "${hostname}" differs from issuer host "${issuerHostname}"; supply allowedHosts to permit a separate auth server`,
      );
    }
  }
}
