/** Google's Files API returns a canonical resource `name` of the form
 *  `files/abc`. Passing that back to delete() or getInfo() used to produce
 *  `/v1beta/files/files/abc` and a 404, because the id was only normalised when
 *  it contained `/files/` WITH a leading slash — which is true of the full `uri`
 *  this adapter hands back, and false of the name Google itself returns.
 *
 *  It never broke the library's own round-trip (upload() and list() both return
 *  the uri), which is exactly why it survived: the only way to hit it was to use
 *  the provider's own id format.
 */

import { describe, expect, it } from 'bun:test';
import { GoogleFileAdapter, googleFileName } from '../../../../src/llm/providers/google/files';

const K = 'k';
const BASE = 'https://generativelanguage.googleapis.com';
const adapter = new GoogleFileAdapter({ apiKey: K });

/** Capture the URL a method would request. */
async function urlFor(run: (f: any) => Promise<unknown>): Promise<string> {
  let url = '';
  const fetch = (async (r: any) => {
    url = r.url;
    return { status: 200, headers: {}, body: { name: 'files/abc', uri: 'u' } };
  }) as any;
  await run(fetch);
  return url;
}

describe('googleFileName normalises every id form', () => {
  it('full uri (what upload() and list() return)', () => {
    expect(googleFileName(`${BASE}/v1beta/files/abc`)).toBe('abc');
  });

  it('canonical resource name (what the Google API returns as `name`)', () => {
    expect(googleFileName('files/abc')).toBe('abc');
  });

  it('bare name', () => {
    expect(googleFileName('abc')).toBe('abc');
  });

  it('does not mangle a name that merely contains the word', () => {
    expect(googleFileName('myfiles')).toBe('myfiles');
    expect(googleFileName('abc-files-1')).toBe('abc-files-1');
  });
});

describe('the URL is right for every id form', () => {
  const expected = `${BASE}/v1beta/files/abc?key=${K}`;

  for (const [label, id] of [
    ['full uri', `${BASE}/v1beta/files/abc`],
    ['canonical name', 'files/abc'],
    ['bare name', 'abc'],
  ] as const) {
    it(`delete: ${label}`, async () => {
      expect(await urlFor((f) => adapter.delete(id, f))).toBe(expected);
    });

    it(`getInfo: ${label}`, async () => {
      expect(await urlFor((f) => adapter.getInfo(id, f))).toBe(expected);
    });
  }
});
