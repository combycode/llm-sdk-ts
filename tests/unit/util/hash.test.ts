import { describe, expect, it } from 'bun:test';
import { fnv1a32, fnv1a32Hex } from '../../../src/util/hash';

describe('fnv1a32', () => {
  it('matches the published FNV-1a 32-bit vectors', () => {
    // Reference values for the standard offset basis / prime.
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('is deterministic and unsigned', () => {
    for (const s of ['', 'a', 'hello world', 'x'.repeat(1000)]) {
      expect(fnv1a32(s)).toBe(fnv1a32(s));
      expect(fnv1a32(s)).toBeGreaterThanOrEqual(0);
      expect(fnv1a32(s)).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('renders 8 hex characters, zero-padded', () => {
    expect(fnv1a32Hex('foobar')).toBe('bf9cf968');
    for (const s of ['', 'a', 'zz', 'batch']) {
      expect(fnv1a32Hex(s)).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});
