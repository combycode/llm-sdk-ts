/** File retrieval — resolves inline data / url / provider file id into bytes +
 *  metadata (name / mimeType / size), buffered (retrieveFile) or streamed (streamFile). */

import { describe, expect, it } from 'bun:test';
import { retrieveFile, streamFile } from '../../../../src/llm/files/retrieve';
import type { RetrieveContext } from '../../../../src/llm/files/retrieve';
import type { EngineFetch, HttpRequest, HttpResponse } from '../../../../src/network/types';
import { bytesToBase64 } from '../../../../src/util/base64';

function recordingFetch(
  body: unknown,
  headers: Record<string, string> = {},
): { fetch: EngineFetch; last: () => HttpRequest } {
  let last: HttpRequest | undefined;
  const fetch = (async (req: HttpRequest) => {
    last = req;
    return { status: 200, headers, body } as HttpResponse;
  }) as EngineFetch;
  return { fetch, last: () => last as HttpRequest };
}

const ctx = (over: Partial<RetrieveContext>): RetrieveContext => ({
  provider: 'anthropic',
  apiKey: 'sk-test',
  fetch: recordingFetch(new ArrayBuffer(0)).fetch,
  ...over,
});

describe('retrieveFile', () => {
  it('inline data → decoded blob + metadata, no HTTP', async () => {
    let called = false;
    const fetch = (async () => {
      called = true;
      return { status: 200, headers: {}, body: new ArrayBuffer(0) } as HttpResponse;
    }) as EngineFetch;
    const data = bytesToBase64(new Uint8Array([1, 2, 3, 4]));
    const r = await retrieveFile(
      { data, name: 'out.csv', mimeType: 'text/csv', source: 'code_execution' },
      ctx({ provider: 'google', fetch }),
    );
    expect(called).toBe(false);
    expect(r.name).toBe('out.csv');
    expect(r.mimeType).toBe('text/csv');
    expect(r.size).toBe(4);
    expect(new Uint8Array(await r.blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('id → reads name/mimeType/size from response headers', async () => {
    const rec = recordingFetch(new Uint8Array([9, 9, 9]).buffer, {
      'content-type': 'image/png',
      'content-disposition': "attachment; filename*=utf-8''chart.png",
      'content-length': '3',
    });
    const r = await retrieveFile({ id: 'file_abc', source: 'code_execution' }, ctx({ fetch: rec.fetch }));
    expect(r.name).toBe('chart.png');
    expect(r.mimeType).toBe('image/png');
    expect(r.blob.type).toBe('image/png');
    expect(r.size).toBe(3);
  });

  it('anthropic id → GET /v1/files/{id}/content?beta=true with beta headers', async () => {
    const rec = recordingFetch(new Uint8Array([9]).buffer, { 'content-type': 'image/png' });
    await retrieveFile({ id: 'file_abc' }, ctx({ provider: 'anthropic', fetch: rec.fetch }));
    const r = rec.last();
    expect(r.url).toBe('https://api.anthropic.com/v1/files/file_abc/content?beta=true');
    expect(r.headers['anthropic-beta']).toBe('files-api-2025-04-14');
    expect(r.headers['x-api-key']).toBe('sk-test');
    expect(r.responseType).toBe('arraybuffer');
  });

  it('openai container file → /v1/containers/{cid}/files/{id}/content with Bearer', async () => {
    const rec = recordingFetch(new Uint8Array([9]).buffer);
    await retrieveFile(
      { id: 'cfile_1', ref: { containerId: 'cntr_9' } },
      ctx({ provider: 'openai', apiKey: 'oa-key', fetch: rec.fetch }),
    );
    const r = rec.last();
    expect(r.url).toBe('https://api.openai.com/v1/containers/cntr_9/files/cfile_1/content');
    expect(r.headers.authorization).toBe('Bearer oa-key');
  });

  it('url form → provider auth only for the provider host', async () => {
    const rec = recordingFetch(new Uint8Array([9]).buffer);
    await retrieveFile({ url: 'https://api.openai.com/v1/files/f/content' }, ctx({ provider: 'openai', apiKey: 'oa', fetch: rec.fetch }));
    expect(rec.last().headers.authorization).toBe('Bearer oa');

    const rec2 = recordingFetch(new Uint8Array([9]).buffer);
    await retrieveFile({ url: 'https://cdn.example.com/x' }, ctx({ provider: 'openai', apiKey: 'oa', fetch: rec2.fetch }));
    expect(rec2.last().headers.authorization).toBeUndefined();
  });
});

describe('streamFile', () => {
  it('inline data → single-chunk stream + metadata', async () => {
    const data = bytesToBase64(new Uint8Array([5, 6, 7]));
    const r = await streamFile({ data, name: 'x.bin', mimeType: 'application/octet-stream' }, ctx({ provider: 'google' }));
    expect(r.name).toBe('x.bin');
    expect(r.size).toBe(3);
    const reader = r.stream.getReader();
    const chunks: number[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(...value);
    }
    expect(chunks).toEqual([5, 6, 7]);
  });

  it('id → responseType:stream, raw body stream + header metadata', async () => {
    const raw = new ReadableStream<Uint8Array>();
    const rec = recordingFetch(raw, {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="data.csv"',
      'content-length': '5000000',
    });
    const r = await streamFile({ id: 'file_s' }, ctx({ provider: 'anthropic', fetch: rec.fetch }));
    expect(rec.last().responseType).toBe('stream');
    expect(r.stream).toBe(raw);
    expect(r.name).toBe('data.csv');
    expect(r.mimeType).toBe('text/csv');
    expect(r.size).toBe(5000000);
  });
});
