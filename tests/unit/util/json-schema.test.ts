import { describe, expect, it } from 'bun:test';
import { validateJsonSchema } from '../../../src/util/json-schema';

describe('validateJsonSchema', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
      role: { enum: ['admin', 'user'] },
    },
    required: ['name', 'age'],
    additionalProperties: false,
  };

  it('passes a valid object', () => {
    expect(validateJsonSchema(schema, { name: 'Alex', age: 30, tags: ['a'], role: 'admin' })).toEqual([]);
  });

  it('flags missing required, wrong types, bad enum, bad array item, extra prop', () => {
    const errs = validateJsonSchema(schema, { age: 1.5, tags: ['ok', 7], role: 'root', extra: true });
    expect(errs.some((e) => e.includes('name') && e.includes('required'))).toBe(true);
    expect(errs.some((e) => e.includes('age') && e.includes('integer'))).toBe(true);
    expect(errs.some((e) => e.includes('tags[1]'))).toBe(true);
    expect(errs.some((e) => e.includes('role') && e.includes('enum'))).toBe(true);
    expect(errs.some((e) => e.includes('extra') && e.includes('additional'))).toBe(true);
  });

  it('reports a top-level type mismatch', () => {
    expect(validateJsonSchema({ type: 'object' }, 'nope')).toEqual(['$: expected object, got string']);
  });
});

describe('validateJsonSchema — every `type` keyword', () => {
  const ok = (type: string, v: unknown) => validateJsonSchema({ type }, v).length === 0;

  it('boolean accepts only true/false', () => {
    expect(ok('boolean', true)).toBe(true);
    expect(ok('boolean', false)).toBe(true);
    expect(ok('boolean', 'true')).toBe(false);
    expect(ok('boolean', 0)).toBe(false);
  });

  it('null accepts only null — not undefined and not 0', () => {
    expect(ok('null', null)).toBe(true);
    expect(ok('null', undefined)).toBe(false);
    expect(ok('null', 0)).toBe(false);
    expect(ok('null', '')).toBe(false);
  });

  it('an UNKNOWN type keyword accepts anything rather than rejecting everything', () => {
    // Draft keywords the validator does not model must not turn into hard
    // rejections — that would fail valid tool output on a schema we simply
    // do not fully implement.
    expect(ok('any', 42)).toBe(true);
    expect(ok('date-time', 'nope')).toBe(true);
  });

  it('a union type passes when ANY member matches', () => {
    expect(validateJsonSchema({ type: ['string', 'null'] }, null)).toEqual([]);
    expect(validateJsonSchema({ type: ['string', 'null'] }, 'x')).toEqual([]);
    expect(validateJsonSchema({ type: ['string', 'null'] }, 3)[0]).toContain('expected string|null');
  });

  it('integer rejects a non-integer number, number accepts it', () => {
    expect(ok('integer', 3)).toBe(true);
    expect(ok('integer', 3.5)).toBe(false);
    expect(ok('number', 3.5)).toBe(true);
  });

  it('array and object are distinguished (an array is not an object here)', () => {
    expect(ok('array', [])).toBe(true);
    expect(ok('object', [])).toBe(false);
    expect(ok('object', null)).toBe(false);
    expect(ok('object', {})).toBe(true);
  });
});

describe('validateJsonSchema — const', () => {
  it('flags a value that differs from const', () => {
    expect(validateJsonSchema({ const: 'fixed' }, 'other')).toEqual(['$: value !== const']);
  });

  it('accepts an exactly-equal value, including deep structures', () => {
    expect(validateJsonSchema({ const: 'fixed' }, 'fixed')).toEqual([]);
    expect(validateJsonSchema({ const: { a: [1, 2] } }, { a: [1, 2] })).toEqual([]);
  });

  it('const: null is checked, not skipped as "absent"', () => {
    expect(validateJsonSchema({ const: null }, null)).toEqual([]);
    expect(validateJsonSchema({ const: null }, 0)).toEqual(['$: value !== const']);
  });

  it('reports the PATH of a nested const mismatch', () => {
    const errs = validateJsonSchema(
      { type: 'object', properties: { kind: { const: 'user' } } },
      { kind: 'admin' },
    );
    expect(errs).toEqual(['$.kind: value !== const']);
  });
});

describe('validateJsonSchema: boolean schemas', () => {
  // A spec-valid MCP server shipping `properties: { x: true }` used to crash the
  // caller with `TypeError: schema is not an Object` on `'const' in schema`.
  it('does not throw on a boolean subschema, and accepts anything under `true`', () => {
    const schema = { type: 'object', properties: { any: true } };
    expect(validateJsonSchema(schema, { any: 42 })).toEqual([]);
    expect(validateJsonSchema(schema, { any: { deep: [1] } })).toEqual([]);
  });

  it('rejects every value under `false`', () => {
    const errs = validateJsonSchema({ type: 'object', properties: { never: false } }, { never: 1 });
    expect(errs).toEqual(['$.never: schema is false, so no value is valid here']);
  });

  it('accepts an absent property even when its schema is `false`', () => {
    expect(validateJsonSchema({ type: 'object', properties: { never: false } }, {})).toEqual([]);
  });

  it('honours a boolean schema at the top level', () => {
    expect(validateJsonSchema(true, { anything: 1 })).toEqual([]);
    expect(validateJsonSchema(false, 1)).toEqual(['$: schema is false, so no value is valid here']);
  });

  // `items: false` means "the array must be empty". The old isObject guard
  // skipped it, so a non-empty array passed a schema that forbids every element.
  it('applies a boolean `items`', () => {
    expect(validateJsonSchema({ type: 'array', items: false }, [])).toEqual([]);
    expect(validateJsonSchema({ type: 'array', items: false }, [1, 2])).toEqual([
      '$[0]: schema is false, so no value is valid here',
      '$[1]: schema is false, so no value is valid here',
    ]);
    expect(validateJsonSchema({ type: 'array', items: true }, [1, 'x'])).toEqual([]);
  });
});

describe('validateJsonSchema: local $ref', () => {
  const schema = {
    $defs: { Positive: { type: 'number' }, Name: { type: 'string' } },
    type: 'object',
    properties: { n: { $ref: '#/$defs/Positive' }, who: { $ref: '#/$defs/Name' } },
  };

  it('validates through a local pointer instead of silently accepting', () => {
    expect(validateJsonSchema(schema, { n: 1, who: 'a' })).toEqual([]);
    expect(validateJsonSchema(schema, { n: 'not a number' })).toEqual([
      '$.n: expected number, got string',
    ]);
  });

  it('resolves `#` to the document root, and pointers into arrays', () => {
    expect(validateJsonSchema({ type: 'number', $ref: '#' }, 1)).toEqual([]);
    const withArray = {
      $defs: { list: [{ type: 'string' }, { type: 'number' }] },
      properties: { second: { $ref: '#/$defs/list/1' } },
    };
    expect(validateJsonSchema(withArray, { second: 'nope' })).toEqual([
      '$.second: expected number, got string',
    ]);
  });

  it('decodes ~0 and ~1 in a pointer segment', () => {
    const escaped = {
      $defs: { 'a/b': { type: 'number' }, 'c~d': { type: 'string' } },
      properties: { x: { $ref: '#/$defs/a~1b' }, y: { $ref: '#/$defs/c~0d' } },
    };
    expect(validateJsonSchema(escaped, { x: 'no', y: 1 })).toEqual([
      '$.x: expected number, got string',
      '$.y: expected string, got number',
    ]);
  });

  // A recursive schema is ordinary (a tree node whose children are nodes).
  // Following the ref unconditionally would not terminate.
  it('terminates on a self-referential schema', () => {
    const tree = {
      $defs: {
        Node: {
          type: 'object',
          properties: { value: { type: 'number' }, child: { $ref: '#/$defs/Node' } },
        },
      },
      $ref: '#/$defs/Node',
    };
    expect(validateJsonSchema(tree, { value: 1, child: { value: 2 } })).toEqual([]);
    expect(validateJsonSchema(tree, { value: 'x' })).toEqual(['$.value: expected number, got string']);
  });

  // We never turn "we could not check this" into "your data is invalid".
  it('accepts when the reference cannot be resolved', () => {
    expect(validateJsonSchema({ $ref: '#/$defs/Missing' }, 1)).toEqual([]);
    expect(validateJsonSchema({ $ref: 'https://example.com/s.json' }, 1)).toEqual([]);
    expect(validateJsonSchema({ $ref: '#someAnchor' }, 1)).toEqual([]);
  });

  it('still evaluates keywords sitting beside a $ref', () => {
    const s = { $defs: { N: { type: 'number' } }, $ref: '#/$defs/N', enum: [1, 2] };
    expect(validateJsonSchema(s, 1)).toEqual([]);
    expect(validateJsonSchema(s, 3)).toEqual(['$: value not in enum']);
    // 'x' breaks BOTH the referenced schema and the sibling enum, and the
    // point of evaluating siblings is that neither is skipped.
    expect(validateJsonSchema(s, 'x')).toEqual([
      '$: expected number, got string',
      '$: value not in enum',
    ]);
  });
});
