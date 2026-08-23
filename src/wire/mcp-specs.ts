/** The MCP Streamable-HTTP spec family.
 *
 *  A sibling of the provider families, loaded separately for the same reason: an
 *  application that never talks to an MCP server should not carry these, and the
 *  generated `registry.ts` imports everything.
 *
 *  MCP is the case that shows the spec format is about NETWORKING rather than about
 *  LLM providers — a JSON-RPC envelope, era-dependent routing headers and a
 *  long-lived stream are described by the same six constructs a chat request uses.
 */

import { resolveSpec, type SpecDelta } from './inherit';
import type { WireSpec } from './interpreter';

import httpBase from './specs/mcp/http.base.json' with { type: 'json' };
import httpRequest from './specs/mcp/http.request.json' with { type: 'json' };
import httpNotify from './specs/mcp/http.notify.json' with { type: 'json' };
import httpLongLived from './specs/mcp/http.longLived.json' with { type: 'json' };
import httpEvents from './specs/mcp/http.events.json' with { type: 'json' };
import httpClose from './specs/mcp/http.close.json' with { type: 'json' };
import httpMessage from './specs/mcp/http.message.json' with { type: 'json' };

// ── the OAuth flow: discovery, registration, the two grants, and the URL the
//    user's browser opens ────────────────────────────────────────────────────
import oauthBase from './specs/mcp-oauth/base.json' with { type: 'json' };
import oauthDiscoverOauth from './specs/mcp-oauth/discover.oauth.json' with { type: 'json' };
import oauthDiscoverOidc from './specs/mcp-oauth/discover.oidc.json' with { type: 'json' };
import oauthRegister from './specs/mcp-oauth/register.json' with { type: 'json' };
import oauthExchange from './specs/mcp-oauth/token.exchange.json' with { type: 'json' };
import oauthRefresh from './specs/mcp-oauth/token.refresh.json' with { type: 'json' };
import oauthAuthorize from './specs/mcp-oauth/authorize.json' with { type: 'json' };

const MCP_SPECS = new Map<string, SpecDelta>(
  (
    [
      httpBase, httpRequest, httpNotify, httpLongLived, httpEvents, httpClose, httpMessage,
      oauthBase, oauthDiscoverOauth, oauthDiscoverOidc, oauthRegister, oauthExchange,
      oauthRefresh, oauthAuthorize,
    ] as unknown as SpecDelta[]
  ).map(
    (s) => [(s as { id: string }).id, s],
  ),
);

/** Carries the shared envelope for the others to inherit; builds no request. */
const ABSTRACT = new Set(['mcp/http.base', 'mcp-oauth/base']);

const cache = new Map<string, WireSpec>();

/** Resolve an MCP spec by id, flattening its `extends` chain. */
export function mcpSpec(id: string): WireSpec {
  const hit = cache.get(id);
  if (hit) return hit;
  if (ABSTRACT.has(id)) throw new Error(`${id} is a base spec and builds no request`);
  const spec = resolveSpec(id, MCP_SPECS) as WireSpec;
  cache.set(id, spec);
  return spec;
}
