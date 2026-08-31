/** loadImageContent() / loadContent() unit tests.
 *
 *  These pin the two things this module actually decides, because both are
 *  silent when wrong:
 *
 *    1. WHICH MIME it picks, and in which order the four sources win
 *       (explicit option > URL/file extension > content-type header > magic
 *       bytes > the 'image/png' fallback). A wrong MIME is not an error — the
 *       provider just rejects or mis-decodes the part.
 *    2. WHICH ContentPart type that MIME maps to. `loadImageContent` always
 *       yields an image part; `loadContent` routes pdf/text to `document`,
 *       `audio/*` to `audio`, `video/*` to `video` and everything else to
 *       `image`.
 *
 *  No network: `globalThis.fetch` is stubbed for the URL branch. Filesystem
 *  cases write into a real temp dir and delete it again. */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContent, loadImageContent } from '../../../src/helpers/content';
import { base64ToBytes } from '../../../src/util/base64';
import type { ContentPart } from '../../../src/llm/types/messages';

// ─── Byte fixtures (real magic numbers, minimum 12 bytes) ─────────────────────

const pad = (head: number[]): Uint8Array => {
  const out = new Uint8Array(16);
  out.set(head, 0);
  return out;
};

const PNG_BYTES = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = pad([0xff, 0xd8, 0xff, 0xe0]);
const GIF_BYTES = pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
/** 'RIFF' + 4 size bytes + 'WEBP' */
const WEBP_BYTES = pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
/** 'RIFF' + 4 size bytes + 'WAVE' */
const WAV_BYTES = pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
/** 'RIFF' + 4 size bytes + 'AVI ' — a RIFF container we do NOT claim to know. */
const RIFF_AVI_BYTES = pad([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]);
const PDF_BYTES = pad([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const ID3_MP3_BYTES = pad([0x49, 0x44, 0x33, 0x04, 0x00]);
/** Bare MPEG frame sync (no ID3 tag): FF followed by top-3-bits-set. */
const SYNC_MP3_BYTES = pad([0xff, 0xfb, 0x90, 0x00]);
/** 12+ bytes of nothing recognisable. */
const UNKNOWN_BYTES = pad([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);

const mimeOf = (part: Awaited<ReturnType<typeof loadContent>>): string =>
  (part as { source: { mimeType: string } }).source.mimeType;
const dataOf = (part: Awaited<ReturnType<typeof loadContent>>): string =>
  (part as { source: { data: string } }).source.data;

// ─── fetch stub ───────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

const realFetch = globalThis.fetch;
const calls: FetchCall[] = [];

function stubFetch(res: {
  status?: number;
  ok?: boolean;
  bytes?: Uint8Array;
  contentType?: string | null;
}): void {
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const status = res.status ?? 200;
    const body = res.bytes ?? PNG_BYTES;
    return {
      ok: res.ok ?? status < 400,
      status,
      headers: { get: (k: string) => (k === 'content-type' ? (res.contentType ?? null) : null) },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  }) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

// ─── Temp dir for the filesystem branch ───────────────────────────────────────

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orxa-content-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeTemp(name: string, bytes: Uint8Array): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

// ─── loadImageContent: bytes in, image part out ───────────────────────────────

describe('loadImageContent() -- Uint8Array source', () => {
  it('base64-encodes the bytes verbatim into an image part', async () => {
    const part = await loadImageContent(PNG_BYTES);
    expect(part.type).toBe('image');
    expect((part as { source: { type: string } }).source.type).toBe('base64');
    // Round-trips: the encoded payload is exactly the bytes handed in.
    expect([...base64ToBytes(dataOf(part))]).toEqual([...PNG_BYTES]);
  });

  it('detects the MIME from the magic bytes when no option is given', async () => {
    expect(mimeOf(await loadImageContent(JPEG_BYTES))).toBe('image/jpeg');
  });

  it('an explicit mimeType wins over the magic bytes', async () => {
    // The bytes say PNG; the caller says heic. The caller wins.
    expect(mimeOf(await loadImageContent(PNG_BYTES, { mimeType: 'image/heic' }))).toBe('image/heic');
  });

  it('falls back to image/png when the bytes match nothing', async () => {
    expect(mimeOf(await loadImageContent(UNKNOWN_BYTES))).toBe('image/png');
  });

  it('forces an image part even for bytes that are plainly not an image', async () => {
    // The whole point of the loadImageContent/loadContent split: this one does
    // NOT route by MIME.
    const part = await loadImageContent(PDF_BYTES);
    expect(part.type).toBe('image');
    expect(mimeOf(part)).toBe('application/pdf');
  });
});

// ─── detectMimeFromBytes: every signature it claims to know ───────────────────

describe('loadContent() -- magic-byte detection', () => {
  const CASES: Array<[string, Uint8Array, string, ContentPart['type']]> = [
    ['PNG', PNG_BYTES, 'image/png', 'image'],
    ['JPEG', JPEG_BYTES, 'image/jpeg', 'image'],
    ['GIF', GIF_BYTES, 'image/gif', 'image'],
    ['RIFF/WEBP', WEBP_BYTES, 'image/webp', 'image'],
    ['RIFF/WAVE', WAV_BYTES, 'audio/wav', 'audio'],
    ['PDF', PDF_BYTES, 'application/pdf', 'document'],
    ['MP3 (ID3 tag)', ID3_MP3_BYTES, 'audio/mpeg', 'audio'],
    ['MP3 (frame sync)', SYNC_MP3_BYTES, 'audio/mpeg', 'audio'],
  ];

  for (const [label, bytes, mime, partType] of CASES) {
    it(`${label} -> ${mime} -> ${partType} part`, async () => {
      const part = await loadContent(bytes);
      expect(mimeOf(part)).toBe(mime);
      expect(part.type).toBe(partType);
    });
  }

  it('a RIFF container that is neither WEBP nor WAVE is not guessed', async () => {
    // RIFF alone is not enough: the four bytes at offset 8 decide. An AVI must
    // fall through to the default rather than be reported as a webp image.
    expect(mimeOf(await loadContent(RIFF_AVI_BYTES))).toBe('image/png');
  });

  it('refuses to sniff a buffer shorter than 12 bytes', async () => {
    // The threshold is 12 because the RIFF branch reads offset 11. It is applied
    // to EVERY signature, not just RIFF: a 6-byte buffer whose first three bytes
    // are a valid JPEG SOI is still not sniffed.
    const shortJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(shortJpeg.length).toBeGreaterThan(3); // enough bytes for the JPEG test itself
    expect(mimeOf(await loadContent(shortJpeg))).toBe('image/png'); // fallback, NOT image/jpeg

    // 11 bytes — one short — is still refused.
    const elevenGif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 1, 1, 1, 1]);
    expect(elevenGif.length).toBe(11);
    expect(mimeOf(await loadContent(elevenGif))).toBe('image/png'); // NOT image/gif

    // 12 bytes of the same GIF header IS sniffed — the boundary is exact.
    const twelveGif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 1, 1, 1, 1, 1]);
    expect(mimeOf(await loadContent(twelveGif))).toBe('image/gif');
  });

  it('0xFF not followed by a frame sync is not an mp3', async () => {
    // The frame-sync test masks the top three bits of byte 1; 0x00 fails it.
    expect(mimeOf(await loadContent(pad([0xff, 0x00, 0x00, 0x00])))).toBe('image/png');
  });
});

// ─── loadContent: MIME -> part type routing ───────────────────────────────────

describe('loadContent() -- part type follows the MIME', () => {
  const ROUTES: Array<[string, ContentPart['type']]> = [
    ['application/pdf', 'document'],
    ['text/plain', 'document'],
    ['audio/wav', 'audio'],
    ['audio/mpeg', 'audio'],
    ['video/mp4', 'video'],
    ['video/webm', 'video'],
    ['image/png', 'image'],
    ['image/webp', 'image'],
    // Unknown families land on `image` — the historical default.
    ['application/octet-stream', 'image'],
  ];

  for (const [mimeType, expected] of ROUTES) {
    it(`${mimeType} -> ${expected}`, async () => {
      const part = await loadContent(UNKNOWN_BYTES, { mimeType });
      expect(part.type).toBe(expected);
      expect(mimeOf(part)).toBe(mimeType);
    });
  }
});

// ─── URL source ───────────────────────────────────────────────────────────────

describe('loadContent() -- http(s) source', () => {
  it('fetches the URL and encodes the returned bytes', async () => {
    stubFetch({ bytes: GIF_BYTES });
    const part = await loadContent('https://example.com/a.gif');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/a.gif');
    expect([...base64ToBytes(dataOf(part))]).toEqual([...GIF_BYTES]);
  });

  it('treats http:// the same as https://', async () => {
    stubFetch({ bytes: PNG_BYTES });
    await loadContent('http://example.com/a.png');
    expect(calls[0].url).toBe('http://example.com/a.png');
  });

  it('sends a user-agent header only when one was asked for', async () => {
    stubFetch({ bytes: PNG_BYTES });
    await loadContent('https://example.com/a.png', { userAgent: 'orxa-tests/1.0' });
    expect(calls[0].headers).toEqual({ 'user-agent': 'orxa-tests/1.0' });

    calls.length = 0;
    stubFetch({ bytes: PNG_BYTES });
    await loadContent('https://example.com/a.png');
    expect(calls[0].headers).toEqual({});
  });

  it('throws with the status and the URL when the fetch is not ok', async () => {
    stubFetch({ status: 404, bytes: PNG_BYTES });
    await expect(loadContent('https://example.com/missing.png')).rejects.toThrow(
      /fetch failed \(404\) for https:\/\/example\.com\/missing\.png/,
    );
  });

  describe('MIME precedence', () => {
    it('1. the explicit option beats the URL extension, the header and the bytes', async () => {
      stubFetch({ bytes: PNG_BYTES, contentType: 'image/gif' });
      const part = await loadContent('https://example.com/a.jpg', { mimeType: 'image/webp' });
      expect(mimeOf(part)).toBe('image/webp');
    });

    it('2. the URL extension beats the content-type header', async () => {
      // The header is the source most often wrong (CDNs serve
      // application/octet-stream), so the path extension is trusted first.
      stubFetch({ bytes: PNG_BYTES, contentType: 'application/octet-stream' });
      expect(mimeOf(await loadContent('https://example.com/pic.webp'))).toBe('image/webp');
    });

    it('3. the content-type header beats the magic bytes', async () => {
      stubFetch({ bytes: PNG_BYTES, contentType: 'image/tiff' });
      expect(mimeOf(await loadContent('https://example.com/pic'))).toBe('image/tiff');
    });

    it('4. the magic bytes are used when nothing else says anything', async () => {
      stubFetch({ bytes: WAV_BYTES, contentType: null });
      const part = await loadContent('https://example.com/clip');
      expect(mimeOf(part)).toBe('audio/wav');
      expect(part.type).toBe('audio');
    });

    it('5. image/png is the last resort', async () => {
      stubFetch({ bytes: UNKNOWN_BYTES, contentType: null });
      expect(mimeOf(await loadContent('https://example.com/blob'))).toBe('image/png');
    });

    it('a URL with no extension skips the extension source', async () => {
      stubFetch({ bytes: UNKNOWN_BYTES, contentType: 'audio/flac' });
      expect(mimeOf(await loadContent('https://example.com/'))).toBe('audio/flac');
    });

    it('a string that starts with a scheme but is not a parseable URL contributes no MIME', async () => {
      // The scheme prefix check (`startsWith('http://')`) is looser than the URL
      // parser, so `mimeFromUrl` MUST swallow the parse failure — throwing here
      // would turn a fetch that already succeeded into a load error.
      stubFetch({ bytes: UNKNOWN_BYTES, contentType: 'image/bmp' });
      expect(mimeOf(await loadContent('http://a b.com/pic.png'))).toBe('image/bmp');
      // ...and the MIME it would have derived from '.png' is NOT used.
    });

    it('a query string does not become part of the extension', async () => {
      // extOf runs on `new URL(...).pathname`, so `?v=2` must not defeat the map.
      stubFetch({ bytes: UNKNOWN_BYTES, contentType: null });
      expect(mimeOf(await loadContent('https://example.com/pic.png?v=2&x=1'))).toBe('image/png');
    });

    it('a dot in a directory name is not an extension', async () => {
      // extOf only counts a dot that comes AFTER the last slash.
      stubFetch({ bytes: UNKNOWN_BYTES, contentType: 'image/bmp' });
      expect(mimeOf(await loadContent('https://example.com/v1.2/file'))).toBe('image/bmp');
    });
  });
});

// ─── Filesystem source ────────────────────────────────────────────────────────

describe('loadContent() -- filesystem source', () => {
  it('reads the file and maps the extension to a MIME', async () => {
    const p = writeTemp('sample.wav', WAV_BYTES);
    const part = await loadContent(p);
    expect(part.type).toBe('audio');
    expect(mimeOf(part)).toBe('audio/wav');
    expect([...base64ToBytes(dataOf(part))]).toEqual([...WAV_BYTES]);
  });

  it('matches the extension case-insensitively', async () => {
    // Bytes are unrecognisable on purpose: only a case-folded extension lookup
    // can produce image/jpeg here. Without the fold it would fall through to the
    // image/png default, which looks like success for a .PNG fixture.
    const p = writeTemp('SHOUTY.JPG', UNKNOWN_BYTES);
    expect(mimeOf(await loadContent(p))).toBe('image/jpeg');
  });

  const EXT_CASES: Array<[string, string]> = [
    ['a.png', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.gif', 'image/gif'],
    ['a.webp', 'image/webp'],
    ['a.pdf', 'application/pdf'],
    ['a.txt', 'text/plain'],
    ['a.wav', 'audio/wav'],
    ['a.mp3', 'audio/mpeg'],
    ['a.m4a', 'audio/mp4'],
    ['a.ogg', 'audio/ogg'],
    ['a.flac', 'audio/flac'],
    ['a.mp4', 'video/mp4'],
    ['a.webm', 'video/webm'],
    ['a.mov', 'video/quicktime'],
  ];

  for (const [name, mime] of EXT_CASES) {
    it(`${name} -> ${mime}`, async () => {
      // Contents are deliberately UNRECOGNISABLE, so only the extension map can
      // produce the expected answer.
      const p = writeTemp(name, UNKNOWN_BYTES);
      expect(mimeOf(await loadContent(p))).toBe(mime);
    });
  }

  it('the extension beats the magic bytes when the two disagree', async () => {
    // A .wav holding PNG bytes is a nonsense file, but it pins the ORDER: on
    // disk the filename is the stronger signal, so the caller who named the file
    // decides. Reversing the two sources would silently re-type every
    // mis-sniffed attachment.
    const p = writeTemp('claims-to-be.wav', PNG_BYTES);
    const part = await loadContent(p);
    expect(mimeOf(part)).toBe('audio/wav');
    expect(part.type).toBe('audio');
  });

  it('falls back to the magic bytes when the extension is unknown', async () => {
    const p = writeTemp('mystery.bin', JPEG_BYTES);
    expect(mimeOf(await loadContent(p))).toBe('image/jpeg');
  });

  it('falls back to image/png when neither the extension nor the bytes are known', async () => {
    const p = writeTemp('mystery2.bin', UNKNOWN_BYTES);
    expect(mimeOf(await loadContent(p))).toBe('image/png');
  });

  it('an explicit mimeType wins over the extension', async () => {
    const p = writeTemp('mislabelled.png', PNG_BYTES);
    expect(mimeOf(await loadContent(p, { mimeType: 'image/jpeg' }))).toBe('image/jpeg');
  });

  it('a dotless filename has no extension to map', async () => {
    const p = writeTemp('README', PDF_BYTES);
    // No '.', so the extension map contributes nothing and the bytes decide.
    expect(mimeOf(await loadContent(p))).toBe('application/pdf');
  });

  it('propagates the read error for a missing path', async () => {
    await expect(loadContent(join(dir, 'does-not-exist.png'))).rejects.toThrow();
  });
});
