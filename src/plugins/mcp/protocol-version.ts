/** MCP protocol-version registry and era helpers.
 *
 *  MCP has two ERAS, not just two versions:
 *    - **handshake** (2024-11-05 … 2025-11-25) — `initialize` + `notifications/initialized`, an
 *      `Mcp-Session-Id`, and a server→client back-channel (ping, logging/setLevel,
 *      resources/subscribe, push sampling / roots / elicitation).
 *    - **modern** (2026-07-28+) — no handshake and no session id. One `server/discover` probe,
 *      then every request carries its own identity in `_meta` and routing headers.
 *
 *  Both are supported and neither is preferred: real servers overwhelmingly still speak
 *  2025-11-25, so the handshake path must keep working byte-for-byte. See CONSTITUTION.md
 *  standing decisions (2026-08-08).
 */

/** Every released revision, oldest to newest. Verified against mcp-py 2.0.0
 *  (`mcp_types/version.py`, KNOWN_PROTOCOL_VERSIONS). */
export const MCP_KNOWN_PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
  '2026-07-28',
] as const;

/** Revisions reachable via the `initialize` handshake. */
export const MCP_HANDSHAKE_PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
] as const;

/** Revisions that use the stateless per-request envelope (`server/discover`). */
export const MCP_MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const;

/** Newest revision reachable via the handshake — what we offer in `initialize`. */
export const MCP_LATEST_HANDSHAKE_VERSION = '2025-11-25';

/** Newest per-request-envelope revision — what the `server/discover` probe asks for. */
export const MCP_LATEST_MODERN_VERSION = '2026-07-28';

/** Which wire a negotiated version implies. */
export type McpEra = 'handshake' | 'modern';

/** Version strings are an ENUMERATED SET, not an ordered scalar.
 *
 *  Released revisions happen to be dates that sort lexicographically, but future identifiers are
 *  not guaranteed to be date-shaped, and an unrecognised peer string must compare conservatively
 *  rather than accidentally (`'zzz' > '2025-11-25'` is true and meaningless). So era questions go
 *  through the lists above — never through `<` / `>`. Upstream calls this out explicitly, having
 *  been bitten by it. An unknown version reads as `handshake`: the older, safer wire. */
export function mcpEraOf(version: string): McpEra {
  return (MCP_MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version)
    ? 'modern'
    : 'handshake';
}

/** True when `version` is a revision this client can speak on the modern wire. */
export function isModernMcpVersion(version: string): boolean {
  return (MCP_MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

/** True when `version` is a revision reachable via the `initialize` handshake. */
export function isHandshakeMcpVersion(version: string): boolean {
  return (MCP_HANDSHAKE_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

/** The newest modern revision BOTH sides speak, or undefined if they share none. */
export function newestMutualModernVersion(theirs: readonly string[]): string | undefined {
  const mutual = MCP_MODERN_PROTOCOL_VERSIONS.filter((v) => theirs.includes(v));
  return mutual[mutual.length - 1];
}

// ─── `_meta` identity keys (modern era) ──────────────────────────────────────
// Verified against mcp-py 2.0.0 `mcp_types/_types.py`.

/** Required on every modern request: the revision this request is written at. */
export const MCP_PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
/** Required on every modern request: what the client can do (replaces the handshake exchange). */
export const MCP_CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
/** Optional client identity, display-only. */
export const MCP_CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
/** Server identity stamped on modern results, display-only (absent and malformed both read as
 *  "unknown" rather than failing the connection). */
export const MCP_SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
/** Stamped on every `subscriptions/listen` stream frame; the value is that request's JSON-RPC id,
 *  which is how a frame is attributed to one subscription. */
export const MCP_SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';

// ─── Routing headers (modern era, HTTP only) ─────────────────────────────────

export const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';
export const MCP_METHOD_HEADER = 'mcp-method';
export const MCP_NAME_HEADER = 'mcp-name';

/** Methods whose primary subject goes in the `Mcp-Name` routing header, and the param it comes
 *  from. Lets an intermediary route/authorize without parsing the body. */
export const MCP_NAME_BEARING_METHODS: Readonly<Record<string, string>> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

/** Header values must be ASCII; a tool name or URI may not be. Encode out-of-range characters
 *  rather than emitting a header the runtime will reject. */
export function encodeMcpHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(value) ? value : encodeURIComponent(value);
}
