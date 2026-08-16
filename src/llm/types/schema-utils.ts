/** Shared JSON Schema utilities for provider-agnostic schema preprocessing. */

import type { JsonSchema } from './tools';

/**
 * Recursively ensure every object-typed schema has `additionalProperties: false`.
 * Required by OpenAI strict mode and Anthropic structured output — providers
 * reject schemas without this explicit flag. Safe across all providers.
 */
export function ensureAdditionalProperties(schema: JsonSchema): JsonSchema {
  const result: Record<string, unknown> = { ...schema };

  if (result.type === 'object' && result.additionalProperties === undefined) {
    result.additionalProperties = false;
  }

  if (result.properties && typeof result.properties === 'object') {
    const props = { ...(result.properties as Record<string, unknown>) };
    for (const [key, val] of Object.entries(props)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        props[key] = ensureAdditionalProperties(val as JsonSchema);
      }
    }
    result.properties = props;
  }

  // Array items may also be object schemas
  if (result.items && typeof result.items === 'object' && !Array.isArray(result.items)) {
    result.items = ensureAdditionalProperties(result.items as JsonSchema);
  }

  return result;
}

/** Whose strict-mode rules to judge a schema against. */
export type StrictDialect = 'openai' | 'anthropic';

/** Keywords Anthropic's strict mode rejects outright, measured against the live API
 *  (2026-08-16, claude-haiku-4.5). The list is asymmetric — `minItems` is accepted
 *  while `maxItems` is not, `maxLength` accepted while `maximum` is not — so treat
 *  it as an evolving surface and fall back on the unknown rather than assume
 *  support. `exclusiveMaximum` is included by symmetry with the measured
 *  `exclusiveMinimum`; it was not itself tested. */
const ANTHROPIC_UNSUPPORTED = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'maxItems',
]);

/** Can this schema satisfy the provider's strict mode AS WRITTEN?
 *
 *  Strict mode is worth defaulting to — it is what makes a provider constrain the
 *  tool name and arguments DURING generation rather than checking after. But the
 *  two providers constrain different things, and a schema that violates either is
 *  rejected with a 400, not quietly degraded:
 *
 *    openai     every property must appear in `required`, at every nesting level
 *    anthropic  a set of validation keywords is simply unsupported
 *
 *  So strict is requested only where it can be honoured. The alternative — rewriting
 *  the schema to fit, promoting optional properties to required-and-nullable — changes
 *  what the tool actually receives, and the receiving end is the caller's code. */
export function strictSupport(
  schema: JsonSchema | undefined,
  dialect: StrictDialect,
): { ok: boolean; reason?: string } {
  const visit = (node: unknown, path: string): string | null => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const n = node as Record<string, unknown>;
    const at = path || '(root)';

    // A `$ref` points into `$defs`, which this walk does not resolve — so the
    // properties behind it are never checked and the schema would sail through
    // only to be rejected by the API. Not-verified is treated as not-safe.
    if (typeof n.$ref === 'string') return `${at}: '$ref' cannot be verified without resolution`;

    if (dialect === 'anthropic') {
      for (const key of Object.keys(n)) {
        if (ANTHROPIC_UNSUPPORTED.has(key)) return `${at}: '${key}' is not supported under strict`;
      }
    }

    const props = n.properties as Record<string, unknown> | undefined;

    // BOTH providers refuse an open object under strict — the whole point of strict is
    // that the argument shape is closed. Absent is fine (it gets supplied as false); an
    // explicit `true` survives conforming and is rejected. OpenAI: "'additionalProperties'
    // is required to be supplied and to be false". Anthropic: "For 'object' type,
    // 'additionalProperties: true' is not supported".
    if (n.additionalProperties !== undefined && n.additionalProperties !== false) {
      return `${at}: 'additionalProperties' must be false under strict`;
    }

    if (dialect === 'openai') {
      // A free-form object — `{ type: 'object' }` with no `properties` — is not
      // expressible under OpenAI strict at all: "object schema missing properties". An
      // EMPTY `properties: {}` is fine, so no-argument tools are unaffected. Nested, the
      // API reports this against the PARENT ("Extra required key 'input' supplied"),
      // which sends you looking in the wrong place. Anthropic accepts this shape.
      if (n.type === 'object' && props === undefined) {
        return `${at}: an object schema with no 'properties' cannot be strict (a free-form object is not expressible)`;
      }
    }

    if (props && typeof props === 'object') {
      if (dialect === 'openai') {
        const required = new Set(Array.isArray(n.required) ? (n.required as string[]) : []);
        const missing = Object.keys(props).filter((k) => !required.has(k));
        if (missing.length > 0) return `${at}: ${missing.join(', ')} not listed in 'required'`;
      }
      for (const [key, val] of Object.entries(props)) {
        const r = visit(val, path ? `${path}.${key}` : key);
        if (r) return r;
      }
    }

    for (const key of ['items', 'additionalProperties'] as const) {
      const r = visit(n[key], path ? `${path}.${key}` : key);
      if (r) return r;
    }
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
      const branches = n[key];
      if (!Array.isArray(branches)) continue;
      for (const [i, sub] of branches.entries()) {
        const r = visit(sub, `${at}.${key}[${i}]`);
        if (r) return r;
      }
    }
    return null;
  };

  const reason = visit(schema, '');
  return reason ? { ok: false, reason } : { ok: true };
}
