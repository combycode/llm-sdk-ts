import { describe, expect, it } from 'bun:test';
import {
  formatToolId,
  idWithoutVersion,
  matchesVersion,
  parseToolId,
  tryParseToolId,
} from '../../../../src/plugins/internal-tools/id';

describe('parseToolId', () => {
  it('splits "namespace:name@semver" into its three parts', () => {
    expect(parseToolId('orxa:summarize@1.0.0')).toEqual({
      namespace: 'orxa',
      name: 'summarize',
      version: '1.0.0',
    });
  });

  it('accepts digits, underscores and hyphens in namespace and name', () => {
    expect(parseToolId('ns_1-a:tool_2-b@10.20.30')).toEqual({
      namespace: 'ns_1-a',
      name: 'tool_2-b',
      version: '10.20.30',
    });
  });

  it.each([
    ['no version', 'orxa:summarize'],
    ['two-part version', 'orxa:summarize@1.0'],
    ['four-part version', 'orxa:summarize@1.0.0.0'],
    ['no namespace', 'summarize@1.0.0'],
    ['uppercase namespace', 'ORXA:summarize@1.0.0'],
    ['uppercase name', 'orxa:Summarize@1.0.0'],
    ['non-numeric version', 'orxa:summarize@v1.0.0'],
    ['empty string', ''],
    ['leading whitespace', ' orxa:summarize@1.0.0'],
    ['trailing whitespace', 'orxa:summarize@1.0.0 '],
    ['dot in name', 'orxa:sum.marize@1.0.0'],
  ])('rejects %s', (_label, id) => {
    expect(() => parseToolId(id)).toThrow(/Invalid tool ID format/);
  });

  it('names the offending id in the error message', () => {
    expect(() => parseToolId('nope')).toThrow(
      'Invalid tool ID format: "nope". Expected "namespace:name@major.minor.patch"',
    );
  });
});

describe('tryParseToolId', () => {
  it('returns the parsed parts for a valid id', () => {
    expect(tryParseToolId('orxa:score@2.3.4')).toEqual({
      namespace: 'orxa',
      name: 'score',
      version: '2.3.4',
    });
  });

  it('returns null instead of throwing for an invalid id', () => {
    expect(tryParseToolId('garbage')).toBeNull();
  });
});

describe('formatToolId', () => {
  it('joins the three parts into a canonical id', () => {
    expect(formatToolId('orxa', 'clarify', '1.2.3')).toBe('orxa:clarify@1.2.3');
  });

  it('round-trips with parseToolId', () => {
    const id = formatToolId('ns', 'tool', '0.0.1');
    expect(parseToolId(id)).toEqual({ namespace: 'ns', name: 'tool', version: '0.0.1' });
  });

  it('rejects an invalid namespace', () => {
    expect(() => formatToolId('Orxa', 'clarify', '1.0.0')).toThrow('Invalid namespace: "Orxa"');
    expect(() => formatToolId('with space', 'clarify', '1.0.0')).toThrow(/Invalid namespace/);
    expect(() => formatToolId('', 'clarify', '1.0.0')).toThrow(/Invalid namespace/);
  });

  it('rejects an invalid tool name', () => {
    expect(() => formatToolId('orxa', 'Clarify', '1.0.0')).toThrow('Invalid tool name: "Clarify"');
    expect(() => formatToolId('orxa', 'a:b', '1.0.0')).toThrow(/Invalid tool name/);
  });

  it('rejects a non-semver version', () => {
    expect(() => formatToolId('orxa', 'clarify', '1.0')).toThrow(
      'Invalid version: "1.0". Expected semver X.Y.Z',
    );
    expect(() => formatToolId('orxa', 'clarify', 'v1.0.0')).toThrow(/Invalid version/);
  });

  it('validates the namespace before the name', () => {
    expect(() => formatToolId('BAD', 'ALSO_BAD', 'bad')).toThrow(/Invalid namespace/);
  });
});

describe('matchesVersion', () => {
  it('is exact equality — no semver range semantics', () => {
    expect(matchesVersion('1.0.0', '1.0.0')).toBe(true);
    expect(matchesVersion('1.0.0', '1.0.1')).toBe(false);
    expect(matchesVersion('1.0.0', '1.0.0 ')).toBe(false);
  });
});

describe('idWithoutVersion', () => {
  it('strips the @version suffix from a well-formed id', () => {
    expect(idWithoutVersion('orxa:summarize@1.0.0')).toBe('orxa:summarize');
  });

  it('returns the input unchanged when it is not a parseable tool id', () => {
    expect(idWithoutVersion('not-an-id')).toBe('not-an-id');
    expect(idWithoutVersion('')).toBe('');
  });
});
