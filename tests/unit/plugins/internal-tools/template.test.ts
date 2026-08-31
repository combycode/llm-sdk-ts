import { describe, expect, it } from 'bun:test';
import {
  formatBulletedList,
  formatNumberedList,
  parseJsonWithFences,
  renderTemplate,
} from '../../../../src/plugins/internal-tools/runner/template';

describe('renderTemplate — substitution', () => {
  it('replaces a single {{var}}', () => {
    expect(renderTemplate('Hello {{name}}!', { name: 'world' })).toBe('Hello world!');
  });

  it('replaces every occurrence of the same variable', () => {
    expect(renderTemplate('{{a}}-{{a}}-{{a}}', { a: 'x' })).toBe('x-x-x');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('[{{  name  }}]', { name: 'v' })).toBe('[v]');
  });

  it('leaves a template with no variables untouched', () => {
    expect(renderTemplate('plain text', {})).toBe('plain text');
  });

  it('does not treat a single brace pair as a variable', () => {
    expect(renderTemplate('{name}', {})).toBe('{name}');
  });

  it('ignores placeholders whose name starts with a digit', () => {
    expect(renderTemplate('{{1bad}}', {})).toBe('{{1bad}}');
  });

  it('accepts leading underscores in a variable name', () => {
    expect(renderTemplate('{{_x}}', { _x: 'ok' })).toBe('ok');
  });
});

describe('renderTemplate — dot paths', () => {
  it('resolves a nested path', () => {
    expect(renderTemplate('{{a.b.c}}', { a: { b: { c: 'deep' } } })).toBe('deep');
  });

  it('throws when an intermediate segment is null', () => {
    expect(() => renderTemplate('{{a.b}}', { a: null })).toThrow(
      'Template variable not found: "a.b"',
    );
  });

  it('throws when an intermediate segment is undefined', () => {
    expect(() => renderTemplate('{{a.b.c}}', { a: { b: undefined } })).toThrow(
      'Template variable not found: "a.b.c"',
    );
  });

  it('throws when an intermediate segment is a primitive, not an object', () => {
    expect(() => renderTemplate('{{a.b}}', { a: 'string' })).toThrow(
      'Template variable not found: "a.b"',
    );
    expect(() => renderTemplate('{{a.b}}', { a: 42 })).toThrow(/Template variable not found/);
  });

  it('reads through an array by numeric index', () => {
    expect(renderTemplate('{{a.1}}', { a: ['x', 'y'] })).toBe('y');
  });

  it('does NOT reach into a primitive’s own properties', () => {
    expect(() => renderTemplate('{{a.length}}', { a: 'abc' })).toThrow(
      'Template variable not found: "a.length"',
    );
    expect(() => renderTemplate('{{a.toFixed}}', { a: 1 })).toThrow(/not found/);
  });
});

describe('renderTemplate — strictness', () => {
  it('throws on a missing variable rather than emitting an empty string', () => {
    expect(() => renderTemplate('{{missing}}', {})).toThrow(
      'Template variable not found: "missing"',
    );
  });

  it('throws when the value is explicitly undefined', () => {
    expect(() => renderTemplate('{{a}}', { a: undefined })).toThrow(/not found/);
  });

  it('renders null as an empty string instead of throwing', () => {
    expect(renderTemplate('[{{a}}]', { a: null })).toBe('[]');
  });
});

describe('renderTemplate — value stringification', () => {
  it('inserts a string value verbatim, without JSON quoting', () => {
    expect(renderTemplate('{{a}}', { a: 'no "quotes" added' })).toBe('no "quotes" added');
  });

  it('JSON-encodes numbers, booleans, objects and arrays', () => {
    expect(renderTemplate('{{a}}', { a: 42 })).toBe('42');
    expect(renderTemplate('{{a}}', { a: false })).toBe('false');
    expect(renderTemplate('{{a}}', { a: { k: 1 } })).toBe('{"k":1}');
    expect(renderTemplate('{{a}}', { a: [1, 'x'] })).toBe('[1,"x"]');
  });

  it('renders an empty string value as an empty string', () => {
    expect(renderTemplate('[{{a}}]', { a: '' })).toBe('[]');
  });
});

describe('parseJsonWithFences — direct parse', () => {
  it('parses bare JSON', () => {
    expect(parseJsonWithFences('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a bare JSON array', () => {
    expect(parseJsonWithFences('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('tolerates surrounding whitespace and newlines', () => {
    expect(parseJsonWithFences('\n\n  {"a":1}  \n')).toEqual({ a: 1 });
  });

  it('parses a bare JSON scalar', () => {
    expect(parseJsonWithFences('42')).toBe(42);
    expect(parseJsonWithFences('null')).toBeNull();
    expect(parseJsonWithFences('"str"')).toBe('str');
  });
});

describe('parseJsonWithFences — markdown fences', () => {
  it('strips a ```json fence', () => {
    expect(parseJsonWithFences('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips an uppercase ```JSON fence', () => {
    expect(parseJsonWithFences('```JSON\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips a bare ``` fence', () => {
    expect(parseJsonWithFences('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips a fence with trailing whitespace after the closer', () => {
    expect(parseJsonWithFences('```json\n{"a":1}\n```   ')).toEqual({ a: 1 });
  });

  it('strips the fence around a bare scalar, which block extraction could not recover', () => {
    expect(parseJsonWithFences('```json\n42\n```')).toBe(42);
    expect(parseJsonWithFences('```JSON\n42\n```')).toBe(42);
    expect(parseJsonWithFences('```\n"text"\n```')).toBe('text');
  });
});

describe('parseJsonWithFences — extraction from prose', () => {
  it('extracts the object when the model wraps it in prose', () => {
    expect(parseJsonWithFences('Sure! Here it is: {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it('extracts an array when the model wraps it in prose', () => {
    expect(parseJsonWithFences('Result: [1,2] done')).toEqual([1, 2]);
  });

  it('balances nested objects, returning the OUTER object', () => {
    expect(parseJsonWithFences('note {"a":{"b":1},"c":2} end')).toEqual({ a: { b: 1 }, c: 2 });
  });

  it('ignores braces and brackets that appear inside JSON strings', () => {
    expect(parseJsonWithFences('note {"a":"a } brace","b":"an ] bracket"} end')).toEqual({
      a: 'a } brace',
      b: 'an ] bracket',
    });
  });

  it('ignores an escaped quote inside a string', () => {
    expect(parseJsonWithFences('note {"a":"he said \\"hi\\" }"} end')).toEqual({
      a: 'he said "hi" }',
    });
  });

  it('keeps tracking the string after a LONE escaped quote, so a later brace stays inert', () => {
    // Odd number of escaped quotes: mishandling the escape flips string state and
    // makes the `}` inside the string look like the end of the object.
    expect(parseJsonWithFences('note {"a":"say \\" }"} end')).toEqual({ a: 'say " }' });
  });

  it('ignores an escaped backslash immediately before a closing quote', () => {
    expect(parseJsonWithFences('note {"a":"back\\\\"} end')).toEqual({ a: 'back\\' });
  });

  it('takes the FIRST opening delimiter it meets', () => {
    expect(parseJsonWithFences('x {"first":1} y {"second":2}')).toEqual({ first: 1 });
  });
});

describe('parseJsonWithFences — failures', () => {
  it('throws SyntaxError when the text contains no JSON delimiter at all', () => {
    expect(() => parseJsonWithFences('just prose, nothing structured')).toThrow(SyntaxError);
    expect(() => parseJsonWithFences('just prose, nothing structured')).toThrow(
      /no valid JSON in input/,
    );
  });

  it('throws SyntaxError when the object is never closed', () => {
    expect(() => parseJsonWithFences('prefix {"a": 1')).toThrow(SyntaxError);
  });

  it('throws SyntaxError when the array is never closed', () => {
    expect(() => parseJsonWithFences('prefix [1, 2')).toThrow(SyntaxError);
  });

  it('throws SyntaxError on the empty string', () => {
    expect(() => parseJsonWithFences('')).toThrow(SyntaxError);
  });

  it('propagates the parse error when a balanced block is not valid JSON', () => {
    expect(() => parseJsonWithFences("prose {'a': 1} more")).toThrow(SyntaxError);
  });

  it('quotes only the first 120 chars of the offending input', () => {
    const noise = `${'z'.repeat(300)} no json`;
    let message = '';
    try {
      parseJsonWithFences(noise);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('z'.repeat(120));
    expect(message).not.toContain('z'.repeat(121));
  });
});

describe('formatNumberedList', () => {
  it('numbers from 1 by default, one item per line', () => {
    expect(formatNumberedList(['a', 'b', 'c'])).toBe('1. a\n2. b\n3. c');
  });

  it('honours a custom start index', () => {
    expect(formatNumberedList(['a', 'b'], 0)).toBe('0. a\n1. b');
  });

  it('accepts a negative start index', () => {
    expect(formatNumberedList(['a', 'b'], -1)).toBe('-1. a\n0. b');
  });

  it('renders numeric items', () => {
    expect(formatNumberedList([10, 20])).toBe('1. 10\n2. 20');
  });

  it('returns an empty string for an empty list', () => {
    expect(formatNumberedList([])).toBe('');
  });
});

describe('formatBulletedList', () => {
  it('uses "-" as the default bullet, one item per line', () => {
    expect(formatBulletedList(['a', 'b'])).toBe('- a\n- b');
  });

  it('honours a custom bullet', () => {
    expect(formatBulletedList(['a', 'b'], '*')).toBe('* a\n* b');
  });

  it('renders numeric items', () => {
    expect(formatBulletedList([1, 2])).toBe('- 1\n- 2');
  });

  it('returns an empty string for an empty list', () => {
    expect(formatBulletedList([])).toBe('');
  });
});
