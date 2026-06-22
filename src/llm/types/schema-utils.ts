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
