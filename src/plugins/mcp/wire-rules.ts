/** The two MCP rules a spec cannot express as data, and where they live.
 *
 *  Every other named spec rule sits in `src/llm/wire-transforms.ts`, but these
 *  cannot: `llm -> plugins` is a forbidden edge (the layer test names it), and MCP
 *  is a plugin. So the transport composes its own registry from the shared one
 *  rather than the shared one reaching down into MCP.
 *
 *  Both are genuinely code rather than data:
 *
 *  `mcpModern` — era is set only AFTER discovery succeeds, so a request has to be
 *  judged by the version it DECLARES as well. Keying on era alone left the
 *  `server/discover` probe itself half-modern, which a modern server rejects.
 *
 *  `mcpNameHeader` — the subject lives under a different param per method (`name`
 *  for tools/call and prompts/get, `uri` for resources/read), so this is a lookup
 *  followed by a read at the key that lookup returned. A template can express a
 *  fixed path, not a computed one.
 */

import type { Ctx, Registry } from '../../wire/interpreter';
import {
  MCP_NAME_BEARING_METHODS,
  encodeMcpHeaderValue,
  isModernMcpVersion,
} from './protocol-version';

/** Add the MCP rules to a base registry, leaving the base untouched. */
export function mcpWireRegistry(base: Registry): Registry {
  return {
    ...base,
    predicates: {
      ...base.predicates,
      /** True on the 2026-07-28 wire, by negotiated era OR by declared version. */
      mcpModern: (ctx: Ctx) =>
        ctx.req.era === 'modern' || isModernMcpVersion(String(ctx.req.protocolVersion ?? '')),
    },
    transforms: {
      ...base.transforms,
      /** The method's subject for the `Mcp-Name` routing header, encoded so a
       *  non-ASCII tool name cannot produce a header the runtime rejects. */
      mcpNameHeader: (_v: unknown, ctx: Ctx) => {
        const key = MCP_NAME_BEARING_METHODS[String(ctx.req.method)];
        if (!key) return undefined as never;
        const value = (ctx.req.params as Record<string, unknown> | undefined)?.[key];
        return typeof value === 'string' ? encodeMcpHeaderValue(value) : (undefined as never);
      },
    },
  };
}
