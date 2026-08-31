/** Small type-level helpers that everything else is built on.
 *
 *  `contentParts` and `isBuiltinTool` are one-liners, but they are the branch
 *  points for "is this a string or a part list" and "is this a function tool or a
 *  hosted one" — get either wrong and the request builder silently takes the
 *  other path for every call. */

import { describe, expect, it } from 'bun:test';
import { contentParts, contentText } from '../../../src/llm/types/messages';
import { isBuiltinTool, isFunctionTool } from '../../../src/llm/types/tools';
import type { Tool } from '../../../src/llm/types/tools';
import { ensureAdditionalProperties, strictSupport } from '../../../src/llm/types/schema-utils';

describe('contentParts', () => {
  it('wraps a plain string as a single text part', () => {
    expect(contentParts('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('wraps the EMPTY string too (rather than returning an empty list)', () => {
    expect(contentParts('')).toEqual([{ type: 'text', text: '' }]);
  });

  it('returns a part array unchanged, by identity', () => {
    const parts = [{ type: 'text' as const, text: 'a' }];
    expect(contentParts(parts)).toBe(parts);
  });

  it('round-trips with contentText for the string form', () => {
    expect(contentText(contentParts('hello'))).toBe('hello');
  });
});

describe('isFunctionTool / isBuiltinTool are exact complements', () => {
  const cases: Array<[string, Tool, boolean]> = [
    ['explicit function', { type: 'function', name: 'f', parameters: {} } as Tool, true],
    ['implicit function (no type)', { name: 'f', parameters: {} } as Tool, true],
    ['web_search builtin', { type: 'web_search' } as Tool, false],
    ['code_interpreter builtin', { type: 'code_interpreter' } as Tool, false],
  ];

  for (const [label, tool, isFn] of cases) {
    it(`${label}: isFunctionTool=${isFn}, isBuiltinTool=${!isFn}`, () => {
      expect(isFunctionTool(tool)).toBe(isFn);
      expect(isBuiltinTool(tool)).toBe(!isFn);
    });
  }

  it('an empty-string type counts as a function tool, not a builtin', () => {
    // `type: ''` reaches here from loosely-typed callers; treating it as a builtin
    // would send a tool with no name to the provider.
    const tool = { type: '', name: 'f', parameters: {} } as unknown as Tool;
    expect(isFunctionTool(tool)).toBe(true);
    expect(isBuiltinTool(tool)).toBe(false);
  });
});

describe('ensureAdditionalProperties', () => {
  it('adds additionalProperties:false to an object schema', () => {
    expect(ensureAdditionalProperties({ type: 'object', properties: {} })).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('does not override an explicit additionalProperties', () => {
    expect(
      ensureAdditionalProperties({ type: 'object', additionalProperties: true }).additionalProperties,
    ).toBe(true);
  });

  it('recurses into nested object properties', () => {
    const out = ensureAdditionalProperties({
      type: 'object',
      properties: { inner: { type: 'object', properties: {} } },
    });
    const inner = (out.properties as Record<string, Record<string, unknown>>).inner;
    expect(inner.additionalProperties).toBe(false);
  });

  it('recurses into ARRAY ITEMS — the branch a nested list schema depends on', () => {
    // `{ type: 'array', items: { type: 'object' } }` is the shape of every
    // "list of records" tool argument. Missing this leaves the item schema
    // without the flag and the provider rejects the whole tool.
    const out = ensureAdditionalProperties({
      type: 'object',
      properties: {
        rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
      },
    });
    const rows = (out.properties as Record<string, Record<string, unknown>>).rows;
    expect((rows.items as Record<string, unknown>).additionalProperties).toBe(false);
  });

  it('a TUPLE items form (an array) is left alone rather than mangled', () => {
    const items = [{ type: 'string' }, { type: 'number' }];
    const out = ensureAdditionalProperties({ type: 'array', items });
    expect(out.items).toEqual(items);
  });

  it('does not mutate the input schema', () => {
    const input = { type: 'object', properties: { a: { type: 'object' } } };
    const copy = JSON.parse(JSON.stringify(input));
    ensureAdditionalProperties(input);
    expect(input).toEqual(copy);
  });
});

describe('strictSupport — branch schemas that are ALL valid', () => {
  const OK = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };

  it('anyOf whose every branch is strict-safe passes', () => {
    expect(
      strictSupport({ type: 'object', properties: { x: { anyOf: [OK, OK] } }, required: ['x'] }, 'openai'),
    ).toEqual({ ok: true });
  });

  it('oneOf and allOf are walked the same way', () => {
    expect(
      strictSupport({ type: 'object', properties: { x: { oneOf: [OK] } }, required: ['x'] }, 'openai').ok,
    ).toBe(true);
    expect(
      strictSupport({ type: 'object', properties: { x: { allOf: [OK] } }, required: ['x'] }, 'openai').ok,
    ).toBe(true);
    const bad = { type: 'object', properties: { q: { type: 'string' }, p: { type: 'number' } }, required: ['q'] };
    expect(
      strictSupport({ type: 'object', properties: { x: { allOf: [OK, bad] } }, required: ['x'] }, 'openai').ok,
    ).toBe(false);
  });

  it('a non-array anyOf is skipped rather than crashing the walk', () => {
    expect(
      strictSupport(
        { type: 'object', properties: { x: { anyOf: 'not-a-list', type: 'string' } }, required: ['x'] },
        'openai',
      ).ok,
    ).toBe(true);
  });
});
