/** base64 + http helpers — the two fallback paths that only run where the fast
 *  path is unavailable (a browser has no `Buffer`) and the abort path that only
 *  runs when a signal is ALREADY aborted before it is combined. */

import { afterEach, describe, expect, it } from 'bun:test';
import { base64ToBytes, base64ToUtf8, bytesToBase64 } from '../../../src/util/base64';
import { anySignal, header, isStreamBody, parseIntHeader } from '../../../src/util/http';

const g = globalThis as unknown as { Buffer?: unknown };
const realBuffer = g.Buffer;
afterEach(() => {
  g.Buffer = realBuffer;
});

describe('base64', () => {
  it('round-trips bytes through the Buffer fast path', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('the btoa fallback (browser: no Buffer) produces the SAME string', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 65, 66]);
    const withBuffer = bytesToBase64(bytes);
    g.Buffer = undefined;
    const withoutBuffer = bytesToBase64(bytes);
    expect(withoutBuffer).toBe(withBuffer);
    expect(base64ToBytes(withoutBuffer)).toEqual(bytes);
  });

  it('the btoa fallback handles bytes above 0x7f without mangling them', () => {
    // String.fromCharCode per byte is only correct if each byte stays < 256 —
    // a naive TextDecoder-based fallback corrupts these.
    const bytes = new Uint8Array([0x80, 0xff, 0xc3, 0xa9]);
    g.Buffer = undefined;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('base64ToUtf8 decodes multi-byte characters', () => {
    expect(base64ToUtf8(bytesToBase64(new TextEncoder().encode('héllo ✓')))).toBe('héllo ✓');
  });
});

describe('anySignal', () => {
  it('an already-aborted signal short-circuits, carrying its reason', () => {
    const already = AbortSignal.abort('gone');
    const fresh = new AbortController();
    const combined = anySignal(already, fresh.signal);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('gone');
  });

  it('the FIRST already-aborted signal wins and later ones are not consulted', () => {
    const first = AbortSignal.abort('first');
    const second = AbortSignal.abort('second');
    expect(anySignal(first, second).reason).toBe('first');
  });

  it('a live signal aborting later propagates', () => {
    const c = new AbortController();
    const combined = anySignal(c.signal);
    expect(combined.aborted).toBe(false);
    c.abort('later');
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('later');
  });

  it('no signals → a signal that never aborts', () => {
    expect(anySignal().aborted).toBe(false);
  });
});

describe('http odds and ends', () => {
  it('header lookup is case-insensitive', () => {
    expect(header({ 'X-GOOG-UPLOAD-URL': 'u' }, 'x-goog-upload-url')).toBe('u');
    expect(header({ 'x-goog-upload-url': 'u' }, 'X-Goog-Upload-Url')).toBe('u');
    expect(header({}, 'missing')).toBeUndefined();
  });

  it('parseIntHeader returns null for absent and non-numeric values', () => {
    expect(parseIntHeader({ a: '42' }, 'a')).toBe(42);
    expect(parseIntHeader({}, 'a')).toBeNull();
    expect(parseIntHeader({ a: '' }, 'a')).toBeNull();
    expect(parseIntHeader({ a: 'abc' }, 'a')).toBeNull();
  });

  it('isStreamBody is true only for a ReadableStream', () => {
    expect(isStreamBody(new ReadableStream())).toBe(true);
    expect(isStreamBody('text')).toBe(false);
    expect(isStreamBody(new Uint8Array([1]))).toBe(false);
    expect(isStreamBody(undefined)).toBe(false);
  });
});
