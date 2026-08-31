/** Source/reference image + video normalisation.
 *
 *  Every DataSource variant has to reach a provider field, and the failure mode
 *  when one does not is silent: a `provider_ref` that falls through returns
 *  `undefined` and the provider receives `{"file_id": null}` — a 400 far from
 *  the cause, or worse, a request that renders without the reference image at
 *  all. Each case is asserted here, including the two that throw. */

import { describe, expect, it } from 'bun:test';
import {
  googleImagePart,
  googleVeoImage,
  normalizeImageSource,
  openaiImageRef,
  toDataUrl,
  xaiImageRef,
  xaiVideoRef,
} from '../../../src/util/source-image';
import { bytesToBase64 } from '../../../src/util/base64';

/** A one-pixel PNG: the 8-byte signature is enough for the mime sniffer. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PNG_B64 = bytesToBase64(PNG_BYTES);
/** JPEG magic: FF D8 FF. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

describe('normalizeImageSource', () => {
  it('base64: sniffs the REAL mime and overrides a mislabeled one', () => {
    const jpegAsPng = normalizeImageSource({
      type: 'base64',
      data: bytesToBase64(JPEG_BYTES),
      mimeType: 'image/png',
    });
    expect(jpegAsPng.mimeType).toBe('image/jpeg');
    expect(jpegAsPng.base64).toBe(bytesToBase64(JPEG_BYTES));
  });

  it('base64: keeps the declared mime when the bytes say nothing', () => {
    expect(
      normalizeImageSource({ type: 'base64', data: bytesToBase64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), mimeType: 'image/heic' })
        .mimeType,
    ).toBe('image/heic');
  });

  it('base64: undecodable input falls back to the declared mime instead of throwing', () => {
    // `!!!!` is 4 chars but not valid base64 — atob throws, and the sniff must
    // swallow it rather than take down the whole request build.
    expect(normalizeImageSource({ type: 'base64', data: '!!!!', mimeType: 'image/webp' }).mimeType).toBe(
      'image/webp',
    );
  });

  it('base64: a payload shorter than one base64 quantum is not sniffed', () => {
    expect(normalizeImageSource({ type: 'base64', data: 'ab', mimeType: 'image/gif' }).mimeType).toBe(
      'image/gif',
    );
  });

  it('buffer: encodes to base64 and sniffs the mime from the bytes', () => {
    const r = normalizeImageSource({ type: 'buffer', data: PNG_BYTES, mimeType: 'application/octet-stream' });
    expect(r.base64).toBe(PNG_B64);
    expect(r.mimeType).toBe('image/png');
  });

  it('url passes through untouched', () => {
    expect(normalizeImageSource({ type: 'url', url: 'https://x/y.png' })).toEqual({
      url: 'https://x/y.png',
    });
  });

  it('file → fileId', () => {
    expect(normalizeImageSource({ type: 'file', fileId: 'file-123' })).toEqual({ fileId: 'file-123' });
  });

  it('provider_ref → fileId + its declared mime (this case used to fall through)', () => {
    expect(
      normalizeImageSource({ type: 'provider_ref', refId: 'files/abc', mimeType: 'image/png' } as never),
    ).toEqual({ fileId: 'files/abc', mimeType: 'image/png' });
  });

  it('path throws — it is the one source that cannot be resolved here', () => {
    expect(() => normalizeImageSource({ type: 'path', path: '/tmp/a.png', mimeType: 'image/png' })).toThrow(
      /`path` DataSource is not supported/,
    );
  });
});

describe('toDataUrl / provider ref objects', () => {
  it('a url wins over inline bytes', () => {
    expect(toDataUrl({ url: 'https://x/y.png', base64: PNG_B64 })).toBe('https://x/y.png');
  });

  it('inline bytes become a data URL, defaulting the mime to image/png', () => {
    expect(toDataUrl({ base64: 'AAAA' })).toBe('data:image/png;base64,AAAA');
    expect(toDataUrl({ base64: 'AAAA', mimeType: 'image/jpeg' })).toBe('data:image/jpeg;base64,AAAA');
  });

  it('a file id alone cannot become a data URL', () => {
    expect(() => toDataUrl({ fileId: 'file-1' })).toThrow(/needs inline base64 or a url/);
  });

  it('openai prefers file_id, else image_url', () => {
    expect(openaiImageRef({ fileId: 'file-1' })).toEqual({ file_id: 'file-1' });
    expect(openaiImageRef({ url: 'https://x/y.png' })).toEqual({ image_url: 'https://x/y.png' });
  });

  it('xai prefers file_id, else url (NOT image_url — different field name)', () => {
    expect(xaiImageRef({ fileId: 'file-1' })).toEqual({ file_id: 'file-1' });
    expect(xaiImageRef({ url: 'https://x/y.png' })).toEqual({ url: 'https://x/y.png' });
  });

  it('google generateContent uses inline_data for bytes and file_data for a reference', () => {
    expect(googleImagePart({ base64: 'AAAA', mimeType: 'image/jpeg' })).toEqual({
      inline_data: { mime_type: 'image/jpeg', data: 'AAAA' },
    });
    expect(googleImagePart({ url: 'https://x/y.png' })).toEqual({
      file_data: { file_uri: 'https://x/y.png', mime_type: 'image/png' },
    });
    expect(googleImagePart({ fileId: 'files/abc', mimeType: 'image/webp' })).toEqual({
      file_data: { file_uri: 'files/abc', mime_type: 'image/webp' },
    });
  });

  it('google Veo uses the Image proto (bytesBase64Encoded), never inlineData', () => {
    expect(googleVeoImage({ base64: 'AAAA', mimeType: 'image/jpeg' })).toEqual({
      bytesBase64Encoded: 'AAAA',
      mimeType: 'image/jpeg',
    });
    expect(googleVeoImage({ url: 'gs://bucket/x.png' })).toEqual({
      gcsUri: 'gs://bucket/x.png',
      mimeType: 'image/png',
    });
  });
});

describe('xaiVideoRef — every DataSource variant', () => {
  it('url → { url }', () => {
    expect(xaiVideoRef({ type: 'url', url: 'https://x/v.mp4' })).toEqual({ url: 'https://x/v.mp4' });
  });

  it('file → { file_id }', () => {
    expect(xaiVideoRef({ type: 'file', fileId: 'file-9' })).toEqual({ file_id: 'file-9' });
  });

  it('provider_ref → { file_id } from refId', () => {
    expect(xaiVideoRef({ type: 'provider_ref', refId: 'file-ref-9' } as never)).toEqual({
      file_id: 'file-ref-9',
    });
  });

  it('base64 → a data URL that keeps the DECLARED mime (no image sniffing on video bytes)', () => {
    expect(xaiVideoRef({ type: 'base64', data: 'QUJD', mimeType: 'video/mp4' })).toEqual({
      url: 'data:video/mp4;base64,QUJD',
    });
  });

  it('buffer → a data URL with the declared mime', () => {
    expect(
      xaiVideoRef({ type: 'buffer', data: new Uint8Array([65, 66, 67]), mimeType: 'video/webm' }),
    ).toEqual({ url: 'data:video/webm;base64,QUJD' });
  });

  it('path throws', () => {
    expect(() => xaiVideoRef({ type: 'path', path: '/tmp/v.mp4', mimeType: 'video/mp4' })).toThrow(
      /`path` DataSource is not supported/,
    );
  });
});
