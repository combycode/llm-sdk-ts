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
