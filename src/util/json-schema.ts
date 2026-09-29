/** Minimal JSON Schema validator (zero-dep). Covers the common keywords —
 *  type, required, properties, items, enum, const, additionalProperties, plus
 *  boolean schemas and local `$ref` — which is enough to validate MCP tool
 *  `structuredContent` against its `outputSchema`.
 *  Not a full Draft 2020-12 implementation (no allOf/anyOf, formats, …). */

import type { JsonSchema } from '../llm/types/tools';

/** A schema NODE is an object OR a boolean. `true` accepts every value, `false`
 *  accepts none; both are spec-valid anywhere a schema is expected, and MCP
 *  servers do ship them — `properties: { extra: true }` is an ordinary way to
 *  say "any shape". Treating one as an object threw a TypeError on `in`, so a
 *  conforming server crashed the caller rather than failing validation.
 *
 *  Deliberately NOT exported, and deliberately not a widening of the public
 *  `JsonSchema`: that type is what a tool's `parameters` is declared as, and
 *  admitting a boolean there would break every consumer that reads
 *  `schema.properties` off it. The public signature below spells the union out
 *  instead, so callers need no name they do not already have. */
type SchemaNode = JsonSchema | boolean;

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

/** Resolve a local JSON Pointer (`#`, `#/$defs/Name`, `#/properties/a/items`)
 *  against the document the validation started from. Returns undefined for a
 *  pointer that does not land on a schema — including `#anchor` forms, which are
 *  names rather than pointers and would need an index of the whole document. */
function resolvePointer(root: SchemaNode, ref: string): SchemaNode | undefined {
  if (!isObject(root)) return undefined;
  const frag = ref.slice(1);
  if (frag === '' || frag === '/') return root;
  if (!frag.startsWith('/')) return undefined;
  let cur: unknown = root;
  for (const raw of frag.slice(1).split('/')) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined;
      cur = cur[i];
      continue;
    }
    if (!isObject(cur) || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return isObject(cur) || typeof cur === 'boolean' ? (cur as SchemaNode) : undefined;
}

function validate(
  schema: SchemaNode,
  value: unknown,
  path: string,
  root: SchemaNode,
  seen: ReadonlySet<string>,
): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: schema is false, so no value is valid here`];
  // Anything that is neither object nor boolean is not a schema. Validating
  // against it cannot succeed OR fail meaningfully, and rejecting the value
  // would blame the data for a malformed schema.
  if (!isObject(schema)) return [];

  const errors: string[] = [];

  // `$ref`. Only local pointers are resolvable — an external one names a
  // document we were never given. We do not turn our own limitation into the
  // caller's rejection, so an unresolvable reference validates as accept; the
  // alternative is failing a tool result we simply could not check.
  // A ref already on the stack is a recursive schema: one pass is enough to
  // check this value, and following it again would not terminate.
  const ref = schema.$ref;
  if (typeof ref === 'string') {
    if (ref.startsWith('#') && !seen.has(ref)) {
      const target = resolvePointer(root, ref);
      if (target !== undefined) {
        errors.push(...validate(target, value, path, root, new Set([...seen, ref])));
      }
    }
    // Sibling keywords are evaluated too (2019-09 onward allows them); under the
    // older "$ref replaces everything" reading there are none to evaluate, so
    // this is a superset and cannot under-validate.
  }

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
    const props = schema.properties as Record<string, SchemaNode>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const r of required) {
      if (!(r in value)) errors.push(`${path}.${r}: required property missing`);
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in value) errors.push(...validate(sub, value[k], `${path}.${k}`, root, seen));
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in props)) errors.push(`${path}.${k}: additional property not allowed`);
      }
    }
  }

  // `items` may itself be a boolean: `items: false` says the array must be
  // empty. Guarding on isObject alone skipped that silently, which reported a
  // non-empty array as valid against a schema that forbids every element.
  const items = schema.items;
  if (Array.isArray(value) && (isObject(items) || typeof items === 'boolean')) {
    value.forEach((v, i) => {
      errors.push(...validate(items as SchemaNode, v, `${path}[${i}]`, root, seen));
    });
  }

  return errors;
}

/** Validate `value` against `schema`; returns a list of human-readable errors
 *  (empty = valid). `$ref` is resolved against `schema` itself as the document
 *  root, so a self-contained schema with `$defs` validates correctly. */
export function validateJsonSchema(schema: JsonSchema | boolean, value: unknown, path = '$'): string[] {
  return validate(schema, value, path, schema, new Set());
}
