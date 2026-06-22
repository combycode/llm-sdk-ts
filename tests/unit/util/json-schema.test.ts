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
