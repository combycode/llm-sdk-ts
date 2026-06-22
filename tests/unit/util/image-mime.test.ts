import { describe, expect, it } from 'bun:test';
import { sniffImageMime } from '../../../src/util/image-mime';

describe('sniffImageMime', () => {
  it('detects JPEG (FF D8 FF)', () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBe('image/jpeg');
  });

  it('detects PNG (89 50 4E 47)', () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
  });

  it('detects GIF and WEBP', () => {
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffImageMime(webp)).toBe('image/webp');
  });

  it('returns undefined for unknown / too-short data', () => {
    expect(sniffImageMime(new Uint8Array([0x00, 0x01, 0x02]))).toBeUndefined();
    expect(sniffImageMime(new Uint8Array([]))).toBeUndefined();
  });
});
