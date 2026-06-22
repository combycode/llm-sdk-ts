/** HostedGoogle retrieval backend unit tests.
 *
 *  No real network calls. All HTTP is stubbed via a fake EngineFetch. Tests:
 *    - createCorpus issues POST /v1beta/fileSearchStores with displayName + embeddingModel
 *    - addDocument issues upload to Files API then :importFile, preserves source metadata
 *    - indexStatus normalises activeDocumentsCount/pendingDocumentsCount/failedDocumentsCount
 *    - pollOperation reaches done: true
 *    - listCorpora pages via nextPageToken and returns CorpusRef[]
 *    - deleteCorpus issues DELETE with ?force=true
 *    - removeDocument issues DELETE on the file name
 *    - asTool emits { fileSearch: { fileSearchStoreNames, metadataFilter? } } (Gemini-native spec)
 *    - search() rejects with the use-asTool message
 *    - capabilities descriptor matches spec
 *    - auth uses x-goog-api-key header (never ?key= query param) */

import { describe, expect, it } from 'bun:test';
import { HostedGoogleRetrievalBackend } from '../../../../src/plugins/retrieval/hosted-google';
import type { HttpRequest, HttpResponse } from '../../../../src/network/types';
import type { CorpusRef } from '../../../../src/plugins/retrieval/types';

// ─── Stub fetch builder ───────────────────────────────────────────────────────

type RequestLog = { req: HttpRequest }[];

function stubFetch(
  responses: Array<{ status: number; body: unknown }>,
  log?: RequestLog,
) {
  let idx = 0;
  return async (req: HttpRequest): Promise<HttpResponse> => {
    log?.push({ req });
    const entry = responses[idx] ?? { status: 200, body: {} };
    idx++;
    return { status: entry.status, headers: {}, body: entry.body };
  };
}

function makeBackend(
  responses: Array<{ status: number; body: unknown }>,
  log?: RequestLog,
) {
  return new HostedGoogleRetrievalBackend({
    apiKey: 'test-api-key',
    fetch: stubFetch(responses, log),
  });
}

const TEST_CORPUS: CorpusRef = {
  id: 'fileSearchStores/store-abc',
  name: 'my-store',
  backend: 'hostedGoogle',
};

// ─── createCorpus ─────────────────────────────────────────────────────────────

describe('hostedGoogle -- createCorpus', () => {
  it('issues POST /v1beta/fileSearchStores with displayName and embeddingModel', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [{ status: 200, body: { name: 'fileSearchStores/abc', displayName: 'my-store' } }],
      log,
    );

    const corpus = await backend.createCorpus({ name: 'my-store' });

    expect(corpus.id).toBe('fileSearchStores/abc');
    expect(corpus.name).toBe('my-store');
    expect(corpus.backend).toBe('hostedGoogle');
    expect(log[0].req.url).toContain('/v1beta/fileSearchStores');
    expect(log[0].req.method).toBe('POST');
    const body = log[0].req.body as Record<string, unknown>;
    expect(body.displayName).toBe('my-store');
    expect(typeof body.embeddingModel).toBe('string');
    expect((body.embeddingModel as string).length).toBeGreaterThan(0);
  });

  it('uses caller-supplied embeddingModel when provided', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [{ status: 200, body: { name: 'fileSearchStores/x', displayName: 'n' } }],
      log,
    );

    await backend.createCorpus({ name: 'n', embeddingModel: 'models/custom-embed' });

    const body = log[0].req.body as Record<string, unknown>;
    expect(body.embeddingModel).toBe('models/custom-embed');
  });

  it('throws on HTTP error', async () => {
    const backend = makeBackend([{ status: 400, body: { error: { message: 'bad request' } } }]);
    await expect(backend.createCorpus({ name: 'n' })).rejects.toThrow(/createCorpus failed/);
  });

  it('auth header is x-goog-api-key (no ?key= query param)', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [{ status: 200, body: { name: 'fileSearchStores/abc', displayName: 'n' } }],
      log,
    );

    await backend.createCorpus({ name: 'n' });

    const req = log[0].req;
    expect(req.headers?.['x-goog-api-key']).toBe('test-api-key');
    expect(req.url).not.toContain('?key=');
    expect(req.url).not.toContain('&key=');
  });
});

// ─── addDocument ─────────────────────────────────────────────────────────────

describe('hostedGoogle -- addDocument', () => {
  it('issues Files API upload then :importFile', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [
        { status: 200, body: { file: { name: 'files/file-xyz', uri: 'https://example/files/file-xyz' } } },
        { status: 200, body: { name: 'fileSearchStores/abc/operations/op-1', done: false } },
      ],
      log,
    );

    const ref = await backend.addDocument(TEST_CORPUS, { text: 'hello world', label: 'doc.txt' });

    // Step 1: upload to Files API
    expect(log[0].req.url).toContain('/upload/v1beta/files');
    expect(log[0].req.method).toBe('POST');
    // Step 2: importFile on the store
    expect(log[1].req.url).toContain('fileSearchStores/store-abc:importFile');
    expect(log[1].req.method).toBe('POST');
    const importBody = log[1].req.body as Record<string, unknown>;
    expect(importBody.fileName).toBe('files/file-xyz');

    expect(ref.corpusId).toBe('fileSearchStores/store-abc');
  });

  it('preserves source metadata in the returned DocumentRef', async () => {
    const backend = makeBackend([
      { status: 200, body: { file: { name: 'files/file-abc' } } },
      { status: 200, body: { name: 'fileSearchStores/abc/operations/op-2' } },
    ]);

    const ref = await backend.addDocument(
      TEST_CORPUS,
      { text: 'content', label: 'file.txt', metadata: { author: 'alice', year: 2026 } },
    );

    expect(ref.source.text).toBe('content');
    expect(ref.source.label).toBe('file.txt');
    expect(ref.source.metadata?.author).toBe('alice');
    expect(ref.source.metadata?.year).toBe(2026);
  });

  it('passes metadata from opts as customMetadata in importFile body', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [
        { status: 200, body: { file: { name: 'files/f1' } } },
        { status: 200, body: { name: 'op-3' } },
      ],
      log,
    );

    await backend.addDocument(
      TEST_CORPUS,
      { text: 'doc text' },
      { metadata: { tag: 'news' } },
    );

    const importBody = log[1].req.body as Record<string, unknown>;
    const customMeta = importBody.customMetadata as Array<{ key: string; value: string }>;
    expect(Array.isArray(customMeta)).toBe(true);
    const tagEntry = customMeta.find((e) => e.key === 'tag');
    expect(tagEntry?.value).toBe('news');
  });

  it('throws when file upload fails', async () => {
    const backend = makeBackend([{ status: 400, body: { error: 'quota' } }]);
    await expect(
      backend.addDocument(TEST_CORPUS, { text: 'hi' }),
    ).rejects.toThrow(/file upload failed/);
  });

  it('throws when importFile fails', async () => {
    const backend = makeBackend([
      { status: 200, body: { file: { name: 'files/ok' } } },
      { status: 403, body: { error: 'forbidden' } },
    ]);
    await expect(
      backend.addDocument(TEST_CORPUS, { text: 'hi' }),
    ).rejects.toThrow(/importFile failed/);
  });

  it('upload auth header is x-goog-api-key (no ?key= in upload URL)', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [
        { status: 200, body: { file: { name: 'files/f-auth' } } },
        { status: 200, body: { name: 'op-auth' } },
      ],
      log,
    );

    await backend.addDocument(TEST_CORPUS, { text: 'auth check' });

    // Upload request must carry the header, not a query key
    expect(log[0].req.headers?.['x-goog-api-key']).toBe('test-api-key');
    expect(log[0].req.url).not.toContain('?key=');
    expect(log[0].req.url).not.toContain('&key=');
  });
});

// ─── indexStatus ──────────────────────────────────────────────────────────────

describe('hostedGoogle -- indexStatus', () => {
  it('pending > 0 normalises to "indexing"', async () => {
    const backend = makeBackend([{
      status: 200,
      body: { name: 'fileSearchStores/abc', activeDocumentsCount: 0, pendingDocumentsCount: 3, failedDocumentsCount: 0 },
    }]);
    const s = await backend.indexStatus(TEST_CORPUS);
    expect(s.state).toBe('indexing');
    expect(s.counts?.total).toBe(3);
    expect(s.counts?.indexed).toBe(0);
    expect(s.counts?.failed).toBe(0);
  });

  it('active > 0 && pending == 0 normalises to "ready"', async () => {
    const backend = makeBackend([{
      status: 200,
      body: { name: 'fileSearchStores/abc', activeDocumentsCount: 5, pendingDocumentsCount: 0, failedDocumentsCount: 0 },
    }]);
    const s = await backend.indexStatus(TEST_CORPUS);
    expect(s.state).toBe('ready');
    expect(s.counts?.indexed).toBe(5);
    expect(s.counts?.total).toBe(5);
  });

  it('failed > 0 && pending == 0 normalises to "error"', async () => {
    const backend = makeBackend([{
      status: 200,
      body: { name: 'fileSearchStores/abc', activeDocumentsCount: 2, pendingDocumentsCount: 0, failedDocumentsCount: 1 },
    }]);
    const s = await backend.indexStatus(TEST_CORPUS);
    expect(s.state).toBe('error');
    expect(s.counts?.failed).toBe(1);
    expect(s.counts?.total).toBe(3);
  });

  it('all zeros normalises to "pending"', async () => {
    const backend = makeBackend([{
      status: 200,
      body: { name: 'fileSearchStores/abc', activeDocumentsCount: 0, pendingDocumentsCount: 0, failedDocumentsCount: 0 },
    }]);
    const s = await backend.indexStatus(TEST_CORPUS);
    expect(s.state).toBe('pending');
  });

  it('coerces string-typed int64 counts (real API returns strings) instead of concatenating', async () => {
    const backend = makeBackend([{
      status: 200,
      body: { name: 'fileSearchStores/abc', activeDocumentsCount: '1', pendingDocumentsCount: '0', failedDocumentsCount: '0' },
    }]);
    const s = await backend.indexStatus(TEST_CORPUS);
    expect(s.state).toBe('ready');
    expect(s.counts?.total).toBe(1);
    expect(s.counts?.indexed).toBe(1);
    expect(s.counts?.failed).toBe(0);
  });

  it('returns error state on HTTP error', async () => {
    const backend = makeBackend([{ status: 404, body: {} }]);
    const s = await backend.indexStatus(TEST_CORPUS);
    expect(s.state).toBe('error');
  });
});

// ─── pollOperation ────────────────────────────────────────────────────────────

describe('hostedGoogle -- pollOperation', () => {
  it('polls until done: true and returns the operation', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [
        { status: 200, body: { name: 'fileSearchStores/abc/operations/op-1', done: false } },
        { status: 200, body: { name: 'fileSearchStores/abc/operations/op-1', done: true, response: {} } },
      ],
      log,
    );

    const result = await backend.pollOperation('fileSearchStores/abc/operations/op-1');

    expect(result.done).toBe(true);
    expect(log.length).toBe(2);
    expect(log[0].req.url).toContain('fileSearchStores/abc/operations/op-1');
    expect(log[0].req.method).toBe('GET');
  });

  it('returns immediately when already done', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [{ status: 200, body: { name: 'op-done', done: true, response: { ok: true } } }],
      log,
    );

    const result = await backend.pollOperation('op-done');
    expect(result.done).toBe(true);
    expect(log.length).toBe(1);
  });

  it('throws on HTTP error during poll', async () => {
    const backend = makeBackend([{ status: 500, body: { error: 'server error' } }]);
    await expect(backend.pollOperation('op-fail')).rejects.toThrow(/operation poll failed/);
  });
});

// ─── listCorpora ──────────────────────────────────────────────────────────────

describe('hostedGoogle -- listCorpora', () => {
  it('returns a flat list from a single page', async () => {
    const backend = makeBackend([{
      status: 200,
      body: {
        fileSearchStores: [
          { name: 'fileSearchStores/1', displayName: 'store-one' },
          { name: 'fileSearchStores/2', displayName: 'store-two' },
        ],
      },
    }]);

    const list = await backend.listCorpora();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('fileSearchStores/1');
    expect(list[0].backend).toBe('hostedGoogle');
    expect(list[1].name).toBe('store-two');
  });

  it('follows nextPageToken across multiple pages', async () => {
    const backend = makeBackend([
      {
        status: 200,
        body: {
          fileSearchStores: [{ name: 'fileSearchStores/A', displayName: 'A' }],
          nextPageToken: 'tok1',
        },
      },
      {
        status: 200,
        body: {
          fileSearchStores: [{ name: 'fileSearchStores/B', displayName: 'B' }],
        },
      },
    ]);

    const list = await backend.listCorpora();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('fileSearchStores/A');
    expect(list[1].id).toBe('fileSearchStores/B');
  });

  it('returns [] on HTTP error', async () => {
    const backend = makeBackend([{ status: 500, body: {} }]);
    const list = await backend.listCorpora();
    expect(list).toEqual([]);
  });

  it('hits the right URL with pageSize parameter', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [{ status: 200, body: { fileSearchStores: [] } }],
      log,
    );

    await backend.listCorpora();

    expect(log[0].req.url).toContain('/v1beta/fileSearchStores');
    expect(log[0].req.url).toContain('pageSize=');
    expect(log[0].req.method).toBe('GET');
  });
});

// ─── deleteCorpus ─────────────────────────────────────────────────────────────

describe('hostedGoogle -- deleteCorpus', () => {
  it('issues DELETE with ?force=true', async () => {
    const log: RequestLog = [];
    const backend = makeBackend([{ status: 200, body: {} }], log);

    await backend.deleteCorpus(TEST_CORPUS);

    expect(log[0].req.url).toContain('fileSearchStores/store-abc');
    expect(log[0].req.url).toContain('?force=true');
    expect(log[0].req.method).toBe('DELETE');
  });

  it('throws on HTTP error', async () => {
    const backend = makeBackend([{ status: 404, body: { error: 'not found' } }]);
    await expect(backend.deleteCorpus(TEST_CORPUS)).rejects.toThrow(/deleteCorpus failed/);
  });
});

// ─── removeDocument ───────────────────────────────────────────────────────────

describe('hostedGoogle -- removeDocument', () => {
  it('issues DELETE on the file name path', async () => {
    const log: RequestLog = [];
    const backend = makeBackend([{ status: 200, body: {} }], log);

    await backend.removeDocument(TEST_CORPUS, 'files/file-to-delete');

    expect(log[0].req.url).toContain('files/file-to-delete');
    expect(log[0].req.method).toBe('DELETE');
  });
});

// ─── asTool ───────────────────────────────────────────────────────────────────

describe('hostedGoogle -- asTool', () => {
  it('returns the Gemini-native fileSearch ProviderToolSpec (not AgentTool)', () => {
    const backend = makeBackend([]);
    const corpora: CorpusRef[] = [
      { id: 'fileSearchStores/s1', name: 'store-1', backend: 'hostedGoogle' },
      { id: 'fileSearchStores/s2', name: 'store-2', backend: 'hostedGoogle' },
    ];

    const spec = backend.asTool(corpora);

    // Must be a ProviderToolSpec (has no execute method)
    expect('execute' in spec).toBe(false);
    // Must use the Gemini-native camelCase shape
    expect(spec.fileSearch).toBeDefined();
    const fs = spec.fileSearch as Record<string, unknown>;
    expect(fs.fileSearchStoreNames).toEqual(['fileSearchStores/s1', 'fileSearchStores/s2']);
  });

  it('includes metadataFilter when filters provided', () => {
    const backend = makeBackend([]);
    const spec = backend.asTool(
      [{ id: 'fileSearchStores/s1', name: 's', backend: 'hostedGoogle' }],
      { filters: { category: 'news' } },
    );

    const fs = spec.fileSearch as Record<string, unknown>;
    expect((fs.metadataFilter as Record<string, unknown>).category).toBe('news');
  });

  it('omits metadataFilter when no filters provided', () => {
    const backend = makeBackend([]);
    const spec = backend.asTool([{ id: 'fileSearchStores/s1', name: 's', backend: 'hostedGoogle' }]);
    const fs = spec.fileSearch as Record<string, unknown>;
    expect(fs.metadataFilter).toBeUndefined();
  });

  it('does NOT use OpenAI-style type+vector_store_ids shape', () => {
    const backend = makeBackend([]);
    const spec = backend.asTool([{ id: 'fileSearchStores/s1', name: 's', backend: 'hostedGoogle' }]);
    // Must not look like OpenAI file_search spec
    expect(spec.type).toBeUndefined();
    expect(spec.vector_store_ids).toBeUndefined();
  });
});

// ─── search unsupported ───────────────────────────────────────────────────────

describe('hostedGoogle -- search() is unsupported', () => {
  it('throws with a message directing to asTool', async () => {
    const backend = makeBackend([]);
    await expect(
      backend.search([TEST_CORPUS], 'what is retrieval'),
    ).rejects.toThrow(/use asTool/i);
  });

  it('error message mentions hostedGoogle', async () => {
    const backend = makeBackend([]);
    await expect(
      backend.search([TEST_CORPUS], 'query'),
    ).rejects.toThrow(/hostedGoogle/);
  });
});

// ─── capabilities ─────────────────────────────────────────────────────────────

describe('hostedGoogle -- capabilities', () => {
  it('has the correct descriptor', () => {
    const backend = makeBackend([]);
    const cap = backend.capabilities;
    expect(cap.userChunking).toBe(true);
    expect(cap.searchModes).toContain('semantic');
    expect(cap.expiration).toBe(false);
    expect(cap.directSearch).toBe(false);
    expect(cap.citationFormat).toBe('gemini');
    expect(cap.idField).toBe('fileSearchStoreNames');
  });
});
