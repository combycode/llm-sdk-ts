/** Minimal JSON Schema validator (zero-dep). Covers the common keywords —
 *  type, required, properties, items, enum, const, additionalProperties — which
 *  is enough to validate MCP tool `structuredContent` against its `outputSchema`.
 *  Not a full Draft 2020-12 implementation (no $ref, allOf/anyOf, formats, …). */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(t: string, v: unknown): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'object':
      return isObject(v);
    case 'array':
      return Array.isArray(v);
    case 'null':
      return v === null;
    default:
      return true;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Validate `value` against `schema`; returns a list of human-readable errors
 *  (empty = valid). */
export function validateJsonSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path = '$',
): string[] {
  const errors: string[] = [];

  const type = schema.type as string | string[] | undefined;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${jsType(value)}`);
      return errors; // a type mismatch makes deeper checks meaningless
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${path}: value not in enum`);
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    errors.push(`${path}: value !== const`);
  }

  if (isObject(value) && isObject(schema.properties)) {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const r of required) {
      if (!(r in value)) errors.push(`${path}.${r}: required property missing`);
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in value) errors.push(...validateJsonSchema(sub, value[k], `${path}.${k}`));
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) errors.push(`${path}.${k}: additional property not allowed`);
      }
    }
  }

  if (Array.isArray(value) && isObject(schema.items)) {
    const items = schema.items as Record<string, unknown>;
    value.forEach((v, i) => {
      errors.push(...validateJsonSchema(items, v, `${path}[${i}]`));
    });
  }

  return errors;
}
