/** Provider file adapters — the RESPONSE side.
 *
 *  Every provider names the same four facts differently, and two of them disagree
 *  about what a timestamp even is:
 *
 *    anthropic  id / filename / size_bytes  / created_at  ISO-8601 string
 *    openai     id / filename / bytes       / created_at  UNIX SECONDS
 *    xai        id / filename / bytes       / created_at  UNIX SECONDS
 *    google     uri/ displayName/ sizeBytes (a STRING) / createTime ISO-8601
 *
 *  `RemoteFileInfo.createdAt` is milliseconds for all of them. Reading the wrong
 *  key yields `undefined` and reading seconds as milliseconds puts every file in
 *  January 1970 — both silent, both the class of defect that shipped in the port.
 *  These tests state the mapping per provider so a port can be diffed against it.
 *
 *  Error paths are pinned too: upload THROWS with the status, getInfo returns
 *  null, list returns an empty array. Three different shapes for the same 4xx. */

import { describe, expect, it } from 'bun:test';
import { AnthropicFileAdapter } from '../../../../src/llm/providers/anthropic/files';
import { OpenAIFileAdapter } from '../../../../src/llm/providers/openai/files';
import { GoogleFileAdapter } from '../../../../src/llm/providers/google/files';
import { XAIFileAdapter } from '../../../../src/llm/providers/xai/files';
import { FileAttachment } from '../../../../src/plugins/files/attachment';
import type { EngineFetch, HttpRequest, HttpResponse } from '../../../../src/network/types';

/** A fetch that replies with a fixed status/body/headers and records the request. */
function stubFetch(
  res: Partial<HttpResponse> & { body?: unknown },
): { fetch: EngineFetch; seen: () => HttpRequest[] } {
  const seen: HttpRequest[] = [];
  const fetch = (async (req: HttpRequest) => {
    seen.push(req);
    return { status: res.status ?? 200, headers: res.headers ?? {}, body: res.body } as HttpResponse;
  }) as EngineFetch;
  return { fetch, seen: () => seen };
}

/** A fetch that walks a scripted list of responses (Google's upload is two calls). */
function scriptedFetch(list: Array<Partial<HttpResponse>>): { fetch: EngineFetch; seen: () => HttpRequest[] } {
  const seen: HttpRequest[] = [];
  let i = 0;
  const fetch = (async (req: HttpRequest) => {
    seen.push(req);
    const r = list[Math.min(i++, list.length - 1)] ?? {};
    return { status: r.status ?? 200, headers: r.headers ?? {}, body: r.body } as HttpResponse;
  }) as EngineFetch;
  return { fetch, seen: () => seen };
}

const attachment = (): FileAttachment =>
  new FileAttachment({
    filename: 'notes.txt',
    mimeType: 'text/plain',
    sizeBytes: 5,
    content: { type: 'buffer', mimeType: 'text/plain', data: new Uint8Array([104, 101, 108, 108, 111]) },
  });

// ─── Anthropic ──────────────────────────────────────────────────────────────

describe('AnthropicFileAdapter', () => {
  const a = new AnthropicFileAdapter({ apiKey: 'sk-ant' });

  it('upload returns the remote id and a null expiry (Anthropic files persist)', async () => {
    const s = stubFetch({ body: { id: 'file_011', type: 'file' } });
    expect(await a.upload(attachment(), s.fetch)).toEqual({ remoteId: 'file_011', expiresAt: null });
    expect(s.seen()[0].url).toBe('https://api.anthropic.com/v1/files');
    expect(s.seen()[0].method).toBe('POST');
  });

  it('upload throws with the status and the raw body on 4xx', async () => {
    const s = stubFetch({ status: 413, body: { error: { message: 'too large' } } });
    await expect(a.upload(attachment(), s.fetch)).rejects.toThrow(/Anthropic file upload failed \(413\).*too large/);
  });

  it('delete issues DELETE /v1/files/{id}, with no beta header', async () => {
    const s = stubFetch({ body: {} });
    await a.delete('file_011', s.fetch);
    const req = s.seen()[0];
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe('https://api.anthropic.com/v1/files/file_011');
    // The Files API went GA. Live-checked 2026-09-29: upload, list and a
    // file-backed message all answer 200 with no beta header, and sending it
    // selects the OLD list shape, so it is not merely redundant.
    expect(req.headers['anthropic-beta']).toBeUndefined();
    expect(req.headers['x-api-key']).toBe('sk-ant');
  });

  it('getInfo maps size_bytes and parses created_at as an ISO string', async () => {
    const s = stubFetch({
      body: {
        id: 'file_011',
        filename: 'notes.txt',
        size_bytes: 1234,
        created_at: '2025-04-14T10:00:00Z',
      },
    });
    expect(await a.getInfo('file_011', s.fetch)).toEqual({
      remoteId: 'file_011',
      filename: 'notes.txt',
      sizeBytes: 1234,
      createdAt: Date.parse('2025-04-14T10:00:00Z'),
    });
  });

  it('getInfo returns null on 404 rather than throwing', async () => {
    const s = stubFetch({ status: 404, body: { error: 'not_found' } });
    expect(await a.getInfo('nope', s.fetch)).toBeNull();
  });

  it('list maps every row through the same field names', async () => {
    const s = stubFetch({
      body: {
        data: [
          { id: 'f1', filename: 'a.txt', size_bytes: 10, created_at: '2025-01-01T00:00:00Z' },
          { id: 'f2', filename: 'b.pdf', size_bytes: 20, created_at: '2025-01-02T00:00:00Z' },
        ],
      },
    });
    const out = await a.list(s.fetch);
    expect(out).toEqual([
      { remoteId: 'f1', filename: 'a.txt', sizeBytes: 10, createdAt: Date.parse('2025-01-01T00:00:00Z') },
      { remoteId: 'f2', filename: 'b.pdf', sizeBytes: 20, createdAt: Date.parse('2025-01-02T00:00:00Z') },
    ]);
    expect(s.seen()[0].url).toBe('https://api.anthropic.com/v1/files');
  });

  it('list returns [] on an error status and on a body with no data array', async () => {
    expect(await a.list(stubFetch({ status: 500, body: 'boom' }).fetch)).toEqual([]);
    expect(await a.list(stubFetch({ body: {} }).fetch)).toEqual([]);
    expect(await a.list(stubFetch({ body: null }).fetch)).toEqual([]);
  });
});

// ─── OpenAI ─────────────────────────────────────────────────────────────────

describe('OpenAIFileAdapter', () => {
  const a = new OpenAIFileAdapter({ apiKey: 'sk-oa' });

  it('upload converts expires_at from SECONDS to milliseconds', async () => {
    const s = stubFetch({ body: { id: 'file-abc', expires_at: 1_700_000_000 } });
    expect(await a.upload(attachment(), s.fetch)).toEqual({
      remoteId: 'file-abc',
      expiresAt: 1_700_000_000_000,
    });
  });

  it('upload reports a null expiry when the file never expires', async () => {
    const s = stubFetch({ body: { id: 'file-abc' } });
    expect((await a.upload(attachment(), s.fetch)).expiresAt).toBeNull();
  });

  it('upload throws with the status on 4xx', async () => {
    const s = stubFetch({ status: 400, body: { error: { message: 'unsupported' } } });
    await expect(a.upload(attachment(), s.fetch)).rejects.toThrow(/OpenAI file upload failed \(400\).*unsupported/);
  });

  it('delete issues DELETE /v1/files/{id} with a Bearer key', async () => {
    const s = stubFetch({ body: { deleted: true } });
    await a.delete('file-abc', s.fetch);
    expect(s.seen()[0].method).toBe('DELETE');
    expect(s.seen()[0].url).toBe('https://api.openai.com/v1/files/file-abc');
    expect(s.seen()[0].headers.authorization).toBe('Bearer sk-oa');
  });

  it('getInfo maps `bytes` and multiplies both timestamps by 1000', async () => {
    const s = stubFetch({
      body: {
        id: 'file-abc',
        filename: 'notes.txt',
        bytes: 4096,
        created_at: 1_700_000_000,
        expires_at: 1_700_086_400,
      },
    });
    expect(await a.getInfo('file-abc', s.fetch)).toEqual({
      remoteId: 'file-abc',
      filename: 'notes.txt',
      sizeBytes: 4096,
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_086_400_000,
    });
  });

  it('getInfo leaves expiresAt undefined when the provider omits expires_at', async () => {
    const s = stubFetch({ body: { id: 'f', filename: 'n', bytes: 1, created_at: 1_700_000_000 } });
    expect((await a.getInfo('f', s.fetch))?.expiresAt).toBeUndefined();
  });

  it('getInfo returns null on 404', async () => {
    expect(await a.getInfo('nope', stubFetch({ status: 404 }).fetch)).toBeNull();
  });

  it('list applies the same seconds→ms conversion to every row', async () => {
    const s = stubFetch({
      body: {
        data: [
          { id: 'f1', filename: 'a.jsonl', bytes: 12, created_at: 1_700_000_000, expires_at: 1_700_003_600 },
          { id: 'f2', filename: 'b.jsonl', bytes: 34, created_at: 1_700_000_001 },
        ],
      },
    });
    expect(await a.list(s.fetch)).toEqual([
      {
        remoteId: 'f1',
        filename: 'a.jsonl',
        sizeBytes: 12,
        createdAt: 1_700_000_000_000,
        expiresAt: 1_700_003_600_000,
      },
      { remoteId: 'f2', filename: 'b.jsonl', sizeBytes: 34, createdAt: 1_700_000_001_000, expiresAt: undefined },
    ]);
  });

  it('list returns [] on an error status and on a body with no data array', async () => {
    expect(await a.list(stubFetch({ status: 401 }).fetch)).toEqual([]);
    expect(await a.list(stubFetch({ body: {} }).fetch)).toEqual([]);
  });
});

// ─── Google ─────────────────────────────────────────────────────────────────

describe('GoogleFileAdapter', () => {
  const a = new GoogleFileAdapter({ apiKey: 'g-key' });

  it('upload is two calls: start (returns the URL in a header) then the bytes', async () => {
    const s = scriptedFetch([
      { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example/session/1' }, body: {} },
      {
        status: 200,
        body: { file: { uri: 'https://gl.googleapis.com/v1beta/files/abc', expirationTime: '2025-05-01T00:00:00Z' } },
      },
    ]);
    const out = await a.upload(attachment(), s.fetch);
    expect(out).toEqual({
      remoteId: 'https://gl.googleapis.com/v1beta/files/abc',
      expiresAt: Date.parse('2025-05-01T00:00:00Z'),
    });
    expect(s.seen()).toHaveLength(2);
    expect(s.seen()[1].url).toBe('https://upload.example/session/1');
    // The bytes go up raw, not JSON-encoded.
    expect(s.seen()[1].rawBody).toBe(true);
    expect(s.seen()[1].body).toBeInstanceOf(Uint8Array);
  });

  it('upload finds the upload URL whatever the header casing', async () => {
    const s = scriptedFetch([
      { status: 200, headers: { 'X-GOOG-UPLOAD-URL': 'https://upload.example/2' }, body: {} },
      { status: 200, body: { file: { uri: 'u' } } },
    ]);
    await a.upload(attachment(), s.fetch);
    expect(s.seen()[1].url).toBe('https://upload.example/2');
  });

  it('upload falls back to a 48h expiry when Google omits expirationTime', async () => {
    const s = scriptedFetch([
      { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example/3' }, body: {} },
      { status: 200, body: { uri: 'u' } }, // note: flat body, no `file` wrapper
    ]);
    const before = Date.now();
    const out = await a.upload(attachment(), s.fetch);
    expect(out.remoteId).toBe('u');
    expect(out.expiresAt).toBeGreaterThanOrEqual(before + 48 * 3600 * 1000);
  });

  it('upload throws when the start call fails', async () => {
    const s = scriptedFetch([{ status: 403, body: { error: 'denied' } }]);
    await expect(a.upload(attachment(), s.fetch)).rejects.toThrow(/start failed \(403\)/);
  });

  it('upload throws when no upload URL comes back', async () => {
    const s = scriptedFetch([{ status: 200, headers: {}, body: {} }]);
    await expect(a.upload(attachment(), s.fetch)).rejects.toThrow('No upload URL returned from Google');
  });

  it('upload throws when the byte-transfer call fails', async () => {
    const s = scriptedFetch([
      { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example/4' }, body: {} },
      { status: 500, body: { error: 'oops' } },
    ]);
    await expect(a.upload(attachment(), s.fetch)).rejects.toThrow(/Google file upload failed \(500\)/);
  });

  it('getInfo parses sizeBytes out of a STRING and createTime out of ISO', async () => {
    const s = stubFetch({
      body: {
        uri: 'https://gl.googleapis.com/v1beta/files/abc',
        displayName: 'notes.txt',
        sizeBytes: '2048', // Google sends int64 as a JSON string
        createTime: '2025-04-14T10:00:00Z',
        expirationTime: '2025-04-16T10:00:00Z',
      },
    });
    expect(await a.getInfo('files/abc', s.fetch)).toEqual({
      remoteId: 'https://gl.googleapis.com/v1beta/files/abc',
      filename: 'notes.txt',
      sizeBytes: 2048,
      createdAt: Date.parse('2025-04-14T10:00:00Z'),
      expiresAt: Date.parse('2025-04-16T10:00:00Z'),
    });
  });

  it('getInfo defaults a missing displayName to "" and a missing sizeBytes to 0', async () => {
    const s = stubFetch({ body: { uri: 'u', createTime: '2025-01-01T00:00:00Z' } });
    const info = await a.getInfo('u', s.fetch);
    expect(info?.filename).toBe('');
    expect(info?.sizeBytes).toBe(0);
    expect(info?.expiresAt).toBeUndefined();
  });

  it('getInfo returns null on 404', async () => {
    expect(await a.getInfo('abc', stubFetch({ status: 404 }).fetch)).toBeNull();
  });

  it('list reads the `files` array (not `data`) and maps each row', async () => {
    const s = stubFetch({
      body: {
        files: [
          { uri: 'u1', displayName: 'a.txt', sizeBytes: '10', createTime: '2025-01-01T00:00:00Z', expirationTime: '2025-01-03T00:00:00Z' },
          { uri: 'u2', createTime: '2025-01-02T00:00:00Z' },
        ],
      },
    });
    expect(await a.list(s.fetch)).toEqual([
      {
        remoteId: 'u1',
        filename: 'a.txt',
        sizeBytes: 10,
        createdAt: Date.parse('2025-01-01T00:00:00Z'),
        expiresAt: Date.parse('2025-01-03T00:00:00Z'),
      },
      {
        remoteId: 'u2',
        filename: '',
        sizeBytes: 0,
        createdAt: Date.parse('2025-01-02T00:00:00Z'),
        expiresAt: undefined,
      },
    ]);
  });

  it('list returns [] on an error status and when `files` is absent', async () => {
    expect(await a.list(stubFetch({ status: 403 }).fetch)).toEqual([]);
    expect(await a.list(stubFetch({ body: {} }).fetch)).toEqual([]);
  });
});

// ─── xAI ────────────────────────────────────────────────────────────────────

describe('XAIFileAdapter', () => {
  const a = new XAIFileAdapter({ apiKey: 'xai-k' });

  it('upload posts multipart to api.x.ai and returns the id with a null expiry', async () => {
    const s = stubFetch({ body: { id: 'file_x1' } });
    expect(await a.upload(attachment(), s.fetch)).toEqual({ remoteId: 'file_x1', expiresAt: null });
    const req = s.seen()[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.x.ai/v1/files');
    expect(req.rawBody).toBe(true);
  });

  it('upload throws with the status on 4xx', async () => {
    const s = stubFetch({ status: 422, body: { error: 'bad mime' } });
    await expect(a.upload(attachment(), s.fetch)).rejects.toThrow(/xAI file upload failed \(422\).*bad mime/);
  });

  it('honours a custom baseURL', async () => {
    const custom = new XAIFileAdapter({ apiKey: 'k', baseURL: 'https://x.internal' });
    const s = stubFetch({ body: { id: 'f' } });
    await custom.upload(attachment(), s.fetch);
    expect(s.seen()[0].url).toBe('https://x.internal/v1/files');
  });

  // Was a pinned KNOWN GAP: only `xai/files.upload` had a wire spec, so these
  // three rejected with `unknown spec` before any HTTP and the response mapping
  // below them was dead — while XAIFileAdapter is exported public API. The specs
  // now exist, so these assert the requests they build.
  it('delete issues a DELETE to the file path', async () => {
    const s = stubFetch({ body: { id: 'f1', deleted: true } });
    await a.delete('f1', s.fetch);
    expect(s.seen()[0].method).toBe('DELETE');
    expect(s.seen()[0].url).toBe('https://api.x.ai/v1/files/f1');
  });

  it('getInfo GETs the file path and maps the row', async () => {
    const s = stubFetch({ body: { id: 'f1', filename: 'a.pdf', bytes: 12, created_at: 1_700_000_000 } });
    const info = await a.getInfo('f1', s.fetch);
    expect(s.seen()[0].method).toBe('GET');
    expect(s.seen()[0].url).toBe('https://api.x.ai/v1/files/f1');
    // created_at is UNIX SECONDS here, unlike anthropic's ISO-8601 string.
    expect(info).toMatchObject({ remoteId: 'f1', filename: 'a.pdf', sizeBytes: 12 });
  });

  it('list GETs the collection and maps every row', async () => {
    const s = stubFetch({ body: { data: [{ id: 'f1', filename: 'a.pdf', bytes: 1, created_at: 1 }] } });
    const rows = await a.list(s.fetch);
    expect(s.seen()[0].method).toBe('GET');
    expect(s.seen()[0].url).toBe('https://api.x.ai/v1/files');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ remoteId: 'f1', filename: 'a.pdf' });
  });

  it('the three build their requests without issuing one', async () => {
    expect((await a.buildDeleteRequest('f')).method).toBe('DELETE');
    expect((await a.buildGetInfoRequest('f')).method).toBe('GET');
    expect((await a.buildListRequest()).url).toBe('https://api.x.ai/v1/files');
  });
});
