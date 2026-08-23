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

/** Capture the request a method would make. */
async function reqFor(run: (f: any) => Promise<unknown>): Promise<{ url: string; headers: Record<string, string> }> {
  let seen: any = {};
  const fetch = (async (r: any) => {
    seen = r;
    return { status: 200, headers: {}, body: { name: 'files/abc', uri: 'u' } };
  }) as any;
  await run(fetch);
  return { url: seen.url ?? '', headers: seen.headers ?? {} };
}

const urlFor = async (run: (f: any) => Promise<unknown>): Promise<string> => (await reqFor(run)).url;

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
  // No `?key=`: the credential is a header. A key in a query string is copied into
  // every access log and telemetry span the request passes through.
  const expected = `${BASE}/v1beta/files/abc`;

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

  it('sends the key as a header and never in the url', async () => {
    for (const call of [
      (f: any) => adapter.delete('abc', f),
      (f: any) => adapter.getInfo('abc', f),
      (f: any) => adapter.list(f),
    ]) {
      const { url, headers } = await reqFor(call);
      expect(headers['x-goog-api-key']).toBe(K);
      expect(url).not.toContain('key=');
    }
  });
});
