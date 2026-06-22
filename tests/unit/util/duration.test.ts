/** parseDuration unit tests. */

import { describe, expect, it } from 'bun:test';
import { parseDuration, parseDurationOrNull } from '../../../src/util/duration';

describe('parseDuration', () => {
  it('parses each unit to ms', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('72h')).toBe(259_200_000);
    expect(parseDuration('3d')).toBe(259_200_000); // 3d === 72h
    expect(parseDuration('2w')).toBe(1_209_600_000);
  });

  it('trims whitespace and is case-insensitive', () => {
    expect(parseDuration(' 1H ')).toBe(3_600_000);
    expect(parseDuration('1.5h')).toBe(5_400_000);
  });

  it('throws on malformed input', () => {
    expect(() => parseDuration('abc')).toThrow();
    expect(() => parseDuration('10')).toThrow();
    expect(() => parseDuration('10y')).toThrow();
  });

  it('parseDurationOrNull tolerates null/empty but not malformed', () => {
    expect(parseDurationOrNull(null)).toBeNull();
    expect(parseDurationOrNull(undefined)).toBeNull();
    expect(parseDurationOrNull('')).toBeNull();
    expect(parseDurationOrNull('72h')).toBe(259_200_000);
    expect(() => parseDurationOrNull('bad')).toThrow();
  });
});
