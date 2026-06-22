/** Source-image normalizer + per-provider ref builders. */

import { describe, expect, it } from 'bun:test';
import {
  googleImagePart,
  googleVeoImage,
  normalizeImageSource,
  openaiImageRef,
  toDataUrl,
  xaiImageRef,
} from '../../../../src/plugins/media/source-image';
import { bytesToBase64 } from '../../../../src/util/base64';

// A JPEG header (FF D8 FF E0 … JFIF), padded to give a long-enough base64 prefix.
const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
]);

describe('normalizeImageSource', () => {
  it('base64 passes through with mime', () => {
    expect(normalizeImageSource({ type: 'base64', mimeType: 'image/png', data: 'AAA' })).toEqual({
      base64: 'AAA',
      mimeType: 'image/png',
    });
  });

  it('buffer is base64-encoded', () => {
    const r = normalizeImageSource({ type: 'buffer', mimeType: 'image/png', data: new Uint8Array([104, 105]) });
    expect(r.base64).toBe('aGk='); // 'hi'
    expect(r.mimeType).toBe('image/png');
  });

  it('url and file map straight across', () => {
    expect(normalizeImageSource({ type: 'url', url: 'http://x/y.png' })).toEqual({ url: 'http://x/y.png' });
    expect(normalizeImageSource({ type: 'file', fileId: 'file-1' })).toEqual({ fileId: 'file-1' });
  });

  it('path throws (needs reading first)', () => {
    expect(() => normalizeImageSource({ type: 'path', mimeType: 'image/png', path: '/x.png' })).toThrow();
  });

  it('corrects a mislabeled mime from the actual bytes (base64 JPEG tagged png)', () => {
    const data = bytesToBase64(JPEG_BYTES);
    const r = normalizeImageSource({ type: 'base64', mimeType: 'image/png', data });
    expect(r.mimeType).toBe('image/jpeg'); // sniffed, not the wrong label
    expect(r.base64).toBe(data); // payload untouched
  });

  it('corrects a mislabeled mime for a buffer source too', () => {
    const r = normalizeImageSource({ type: 'buffer', mimeType: 'image/png', data: JPEG_BYTES });
    expect(r.mimeType).toBe('image/jpeg');
  });

  it('keeps the declared mime when bytes are unrecognized', () => {
    const r = normalizeImageSource({ type: 'base64', mimeType: 'image/png', data: bytesToBase64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) });
    expect(r.mimeType).toBe('image/png');
  });
});

describe('provider ref builders', () => {
  const b64 = { base64: 'AAA', mimeType: 'image/jpeg' };
  const fileRef = { fileId: 'file-9' };

  it('toDataUrl builds data: URL / passes url', () => {
    expect(toDataUrl(b64)).toBe('data:image/jpeg;base64,AAA');
    expect(toDataUrl({ url: 'http://x' })).toBe('http://x');
    expect(() => toDataUrl(fileRef)).toThrow();
  });

  it('openai/xai prefer file_id, else data URL', () => {
    expect(openaiImageRef(b64)).toEqual({ image_url: 'data:image/jpeg;base64,AAA' });
    expect(openaiImageRef(fileRef)).toEqual({ file_id: 'file-9' });
    expect(xaiImageRef(b64)).toEqual({ url: 'data:image/jpeg;base64,AAA' });
    expect(xaiImageRef(fileRef)).toEqual({ file_id: 'file-9' });
  });

  it('google inline vs file_data', () => {
    expect(googleImagePart(b64)).toEqual({ inline_data: { mime_type: 'image/jpeg', data: 'AAA' } });
    expect(googleImagePart({ url: 'gs://x', mimeType: 'image/png' })).toEqual({
      file_data: { file_uri: 'gs://x', mime_type: 'image/png' },
    });
    // Veo predict uses the Image proto (bytesBase64Encoded), NOT inlineData.
    expect(googleVeoImage(b64)).toEqual({ bytesBase64Encoded: 'AAA', mimeType: 'image/jpeg' });
    expect(googleVeoImage({ url: 'gs://x', mimeType: 'image/png' })).toEqual({
      gcsUri: 'gs://x',
      mimeType: 'image/png',
    });
  });
});
