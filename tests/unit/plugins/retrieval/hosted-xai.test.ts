/** HostedXai retrieval backend unit tests.
 *
 *  No real network calls. All HTTP is stubbed via a fake EngineFetch. Tests:
 *    - createCorpus issues POST to MANAGEMENT base with management bearer + collection_name
 *    - addDocument does std-files-upload (std bearer) then mgmt-attach (mgmt bearer), maps metadata->fields
 *    - indexStatus normalises documents_count (incl. string-typed count) to ready/pending
 *    - search posts to {std}/documents/search with right body; parses chunk_content JSON
 *    - search defensive fallback when chunk_content is not the expected JSON shape
 *    - asTool emits exact {type:'file_search', vector_store_ids, max_num_results} spec
 *    - deleteCorpus/removeDocument/listCorpora hit the right URLs/planes
 *    - management calls use the management key; standard calls use the standard key (no cross-plane bleed)
 *    - capabilities descriptor */

import { describe, expect, it } from 'bun:test';
import { HostedXaiRetrievalBackend } from '../../../../src/plugins/retrieval/hosted-xai';
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

const STD_KEY = 'std-key';
const MGMT_KEY = 'mgmt-key';
const STD_BASE = 'https://api.x.ai/v1';
const MGMT_BASE = 'https://management-api.x.ai/v1';

function makeBackend(
  responses: Array<{ status: number; body: unknown }>,
  log?: RequestLog,
) {
  return new HostedXaiRetrievalBackend({
    apiKey: STD_KEY,
    managementApiKey: MGMT_KEY,
    fetch: stubFetch(responses, log),
  });
}

// ─── createCorpus ─────────────────────────────────────────────────────────────

describe('hostedXai -- createCorpus', () => {
  it('issues POST to management base with management bearer and collection_name', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [{ status: 200, body: { collection_id: 'col_abc', collection_name: 'my-col', documents_count: 0 } }],
      log,
    );

    const corpus = await backend.createCorpus({ name: 'my-col' });

    expect(corpus.id).toBe('col_abc');
    expect(corpus.name).toBe('my-col');
    expect(corpus.backend).toBe('hostedXai');
    // Must POST to the management base URL
    expect(log[0].req.url).toBe(`${MGMT_BASE}/collections`);
    expect(log[0].req.method).toBe('POST');
    // body must use collection_name
    const body = log[0].req.body as Record<string, unknown>;
    expect(body.collection_name).toBe('my-col');
    // Must use management bearer
    expect(log[0].req.headers?.authorization).toBe(`Bearer ${MGMT_KEY}`);
  });

  it('throws on HTTP error', async () => {
    const backend = makeBackend([{ status: 400, body: { error: 'bad' } }]);
    await expect(backend.createCorpus({ name: 'n' })).rejects.toThrow(/createCorpus failed/);
  });
});

// ─── addDocument ─────────────────────────────────────────────────────────────

describe('hostedXai -- addDocument', () => {
  const corpus: CorpusRef = { id: 'col_abc', name: 'my-col', backend: 'hostedXai' };

  it('uploads to std /files then attaches via mgmt /collections/{id}/documents/{fileId}', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [
        { status: 200, body: { id: 'file_123' } },
        { status: 200, body: {} },
      ],
      log,
    );

    const ref = await backend.addDocument(corpus, { text: 'hello', label: 'doc.txt' });

    expect(ref.id).toBe('file_123');
    expect(ref.corpusId).toBe('col_abc');
    // Step 1: std files upload
    expect(log[0].req.url).toBe(`${STD_BASE}/files`);
    expect(log[0].req.method).toBe('POST');
    expect(log[0].req.headers?.authorization).toBe(`Bearer ${STD_KEY}`);
    // Step 2: mgmt attach
    expect(log[1].req.url).toBe(`${MGMT_BASE}/collections/col_abc/documents/file_123`);
    expect(log[1].req.method).toBe('POST');
    expect(log[1].req.headers?.authorization).toBe(`Bearer ${MGMT_KEY}`);
  });

  it('maps opts.metadata to fields on the attach body', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [
        { status: 200, body: { id: 'file_x' } },
        { status: 200, body: {} },
      ],
      log,
    );

    await backend.addDocument(
      corpus,
      { text: 'content', label: 'f.txt' },
      { metadata: { author: 'alice', year: 2025 } },
    );

    const attachBody = log[1].req.body as Record<string, unknown>;
    const fields = attachBody.fields as Record<string, unknown>;
    expect(fields.author).toBe('alice');
    expect(fields.year).toBe(2025);
  });

  it('falls back to source.metadata when opts.metadata is absent', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [
        { status: 200, body: { id: 'file_y' } },
        { status: 200, body: {} },
      ],
      log,
    );

    await backend.addDocument(corpus, {
      text: 'hi',
      label: 'g.txt',
      metadata: { tag: 'test' },
    });

    const attachBody = log[1].req.body as Record<string, unknown>;
    const fields = attachBody.fields as Record<string, unknown>;
    expect(fields.tag).toBe('test');
  });

  it('preserves source on the returned DocumentRef', async () => {
    const backend = makeBackend([
      { status: 200, body: { id: 'file_z' } },
      { status: 200, body: {} },
    ]);

    const ref = await backend.addDocument(corpus, {
      text: 'body text',
      label: 'file.txt',
      metadata: { k: 'v' },
    });

    expect(ref.source.text).toBe('body text');
    expect(ref.source.label).toBe('file.txt');
    expect(ref.source.metadata?.k).toBe('v');
  });

  it('throws when file upload fails', async () => {
    const backend = makeBackend([{ status: 400, body: { error: 'upload bad' } }]);
    await expect(backend.addDocument(corpus, { text: 'hi' })).rejects.toThrow(/file upload failed/);
  });

  it('throws when attach step fails', async () => {
    const backend = makeBackend([
      { status: 200, body: { id: 'file_ok' } },
      { status: 422, body: { error: 'attach bad' } },
    ]);
    await expect(backend.addDocument(corpus, { text: 'hi' })).rejects.toThrow(/attach document failed/);
  });
});

// ─── indexStatus ──────────────────────────────────────────────────────────────

describe('hostedXai -- indexStatus', () => {
  const corpus: CorpusRef = { id: 'col_abc', name: 'my-col', backend: 'hostedXai' };

  it('returns "ready" when documents_count > 0 (number)', async () => {
    const backend = makeBackend([{
      status: 200,
      body: { collection_id: 'col_abc', documents_count: 3 },
    }]);
    const s = await backend.indexStatus(corpus);
    expect(s.state).toBe('ready');
    expect(s.counts?.total).toBe(3);
    expect(s.counts?.indexed).toBe(3);
    expect(s.counts?.failed).toBe(0);
  });

  it('returns "ready" when documents_count is a string (e.g. "5")', async () => {
    const backend = makeBackend([{
      status: 200,
      body: { collection_id: 'col_abc', documents_count: '5' },
    }]);
    const s = await backend.indexStatus(corpus);
    expect(s.state).toBe('ready');
    expect(s.counts?.total).toBe(5);
  });

  it('returns "pending" when documents_count is 0', async () => {
    const backend = makeBackend([{
      status: 200,
      body: { collection_id: 'col_abc', documents_count: 0 },
    }]);
    const s = await backend.indexStatus(corpus);
    expect(s.state).toBe('pending');
    expect(s.counts?.total).toBe(0);
  });

  it('returns "pending" when documents_count is "0"', async () => {
    const backend = makeBackend([{
      status: 200,
      body: { collection_id: 'col_abc', documents_count: '0' },
    }]);
    const s = await backend.indexStatus(corpus);
    expect(s.state).toBe('pending');
  });

  it('returns "error" state on HTTP error', async () => {
    const backend = makeBackend([{ status: 404, body: {} }]);
    const s = await backend.indexStatus(corpus);
    expect(s.state).toBe('error');
  });

  it('issues GET to management base with management bearer', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [{ status: 200, body: { documents_count: 1 } }],
      log,
    );
    await backend.indexStatus(corpus);
    expect(log[0].req.url).toBe(`${MGMT_BASE}/collections/col_abc`);
    expect(log[0].req.headers?.authorization).toBe(`Bearer ${MGMT_KEY}`);
  });
});

// ─── search ───────────────────────────────────────────────────────────────────

describe('hostedXai -- search', () => {
  const corpus: CorpusRef = { id: 'col_abc', name: 'my-col', backend: 'hostedXai' };

  it('posts to {std}/documents/search with query, source.collection_ids, retrieval_mode', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [{ status: 200, body: { results: [] } }],
      log,
    );

    await backend.search([corpus], 'what is rust?');

    expect(log[0].req.url).toBe(`${STD_BASE}/documents/search`);
    expect(log[0].req.method).toBe('POST');
    const body = log[0].req.body as Record<string, unknown>;
    expect(body.query).toBe('what is rust?');
    const source = body.source as Record<string, unknown>;
    expect(source.collection_ids).toEqual(['col_abc']);
    const mode = body.retrieval_mode as Record<string, unknown>;
    expect(mode.type).toBe('hybrid');
  });

  it('uses standard bearer for search, NOT management key', async () => {
    const log: RequestLog = [];
    const backend = makeBackend([{ status: 200, body: { results: [] } }], log);
    await backend.search([corpus], 'query');
    expect(log[0].req.headers?.authorization).toBe(`Bearer ${STD_KEY}`);
  });

  it('maps searchMode option to retrieval_mode.type', async () => {
    const log: RequestLog = [];
    const backend = makeBackend([{ status: 200, body: { results: [] } }], log);
    await backend.search([corpus], 'q', { searchMode: 'semantic' });
    const body = log[0].req.body as Record<string, unknown>;
    const mode = body.retrieval_mode as Record<string, unknown>;
    expect(mode.type).toBe('semantic');
  });

  it('falls back to "hybrid" for unknown searchMode', async () => {
    const log: RequestLog = [];
    const backend = makeBackend([{ status: 200, body: { results: [] } }], log);
    await backend.search([corpus], 'q', { searchMode: 'unknown-mode' });
    const body = log[0].req.body as Record<string, unknown>;
    const mode = body.retrieval_mode as Record<string, unknown>;
    expect(mode.type).toBe('hybrid');
  });

  it('parses live "matches" shape: chunk_content JSON -> text, file_id -> docId', async () => {
    // Live xAI returns hits under `matches` (docs incorrectly say `results`),
    // each carrying file_id. Verified against the real API.
    const chunkContent = JSON.stringify([{ page_number: 0, text: 'extracted text here' }]);
    const backend = makeBackend([{
      status: 200,
      body: {
        matches: [{
          file_id: 'file_xyz',
          chunk_id: 'file_xyz_0',
          chunk_content: chunkContent,
          score: 0.92,
          collection_ids: ['col_abc'],
          fields: { title: 'My Doc' },
        }],
      },
    }]);

    const hits = await backend.search([corpus], 'query');
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe('extracted text here');
    expect(hits[0].score).toBe(0.92);
    expect(hits[0].docId).toBe('file_xyz');
  });

  it('falls back to raw string when chunk_content is not the expected JSON shape', async () => {
    const backend = makeBackend([{
      status: 200,
      body: {
        results: [{
          chunk_id: 'ch_2',
          chunk_content: 'plain raw text',
          score: 0.5,
          collection_ids: ['col_abc'],
          fields: {},
        }],
      },
    }]);

    const hits = await backend.search([corpus], 'query');
    expect(hits[0].text).toBe('plain raw text');
  });

  it('falls back to raw string when chunk_content is malformed JSON', async () => {
    const backend = makeBackend([{
      status: 200,
      body: {
        results: [{
          chunk_id: 'ch_3',
          chunk_content: '{ not valid json [',
          score: 0.3,
          collection_ids: ['col_abc'],
          fields: {},
        }],
      },
    }]);

    const hits = await backend.search([corpus], 'query');
    expect(hits[0].text).toBe('{ not valid json [');
  });

  it('falls back when chunk_content JSON is an array without text field', async () => {
    const backend = makeBackend([{
      status: 200,
      body: {
        results: [{
          chunk_id: 'ch_4',
          chunk_content: '[{"page_number":0,"other":"value"}]',
          score: 0.4,
          collection_ids: ['col_abc'],
          fields: {},
        }],
      },
    }]);

    const hits = await backend.search([corpus], 'query');
    expect(hits[0].text).toBe('[{"page_number":0,"other":"value"}]');
  });

  it('maps fields to metadata on RetrievalHit', async () => {
    const backend = makeBackend([{
      status: 200,
      body: {
        results: [{
          chunk_id: 'ch_5',
          chunk_content: 'text',
          score: 0.7,
          collection_ids: ['col_abc'],
          fields: { author: 'bob', year: '2024' },
        }],
      },
    }]);

    const hits = await backend.search([corpus], 'query');
    expect(hits[0].metadata?.author).toBe('bob');
  });

  it('builds citation URI from collection_ids and fields', async () => {
    const backend = makeBackend([{
      status: 200,
      body: {
        results: [{
          chunk_id: 'ch_6',
          chunk_content: 'text',
          score: 0.8,
          collection_ids: ['col_abc'],
          fields: { 'chroma:uri': 'file_xyz' },
        }],
      },
    }]);

    const hits = await backend.search([corpus], 'query');
    expect(hits[0].citation).toBe('collections://col_abc/files/file_xyz');
  });

  it('throws on search HTTP error', async () => {
    const backend = makeBackend([{ status: 500, body: { error: 'oops' } }]);
    await expect(backend.search([corpus], 'q')).rejects.toThrow(/search failed/);
  });
});

// ─── asTool ───────────────────────────────────────────────────────────────────

describe('hostedXai -- asTool', () => {
  it('emits {type:"file_search", vector_store_ids} spec (not AgentTool)', () => {
    const backend = makeBackend([]);
    const corpora: CorpusRef[] = [
      { id: 'col_1', name: 'c1', backend: 'hostedXai' },
      { id: 'col_2', name: 'c2', backend: 'hostedXai' },
    ];

    const spec = backend.asTool(corpora);

    expect('execute' in spec).toBe(false);
    expect(spec.type).toBe('file_search');
    expect(spec.vector_store_ids).toEqual(['col_1', 'col_2']);
  });

  it('includes max_num_results when opts.maxResults provided', () => {
    const backend = makeBackend([]);
    const spec = backend.asTool(
      [{ id: 'col_1', name: 'c1', backend: 'hostedXai' }],
      { maxResults: 5 },
    );
    expect(spec.max_num_results).toBe(5);
  });

  it('omits max_num_results when not provided', () => {
    const backend = makeBackend([]);
    const spec = backend.asTool([{ id: 'col_1', name: 'c1', backend: 'hostedXai' }]);
    expect(spec.max_num_results).toBeUndefined();
  });
});

// ─── deleteCorpus / removeDocument / listCorpora ──────────────────────────────

describe('hostedXai -- delete and list', () => {
  const corpus: CorpusRef = { id: 'col_abc', name: 'my-col', backend: 'hostedXai' };

  it('deleteCorpus issues DELETE to management base', async () => {
    const log: RequestLog = [];
    const backend = makeBackend([{ status: 200, body: {} }], log);
    await backend.deleteCorpus(corpus);
    expect(log[0].req.url).toBe(`${MGMT_BASE}/collections/col_abc`);
    expect(log[0].req.method).toBe('DELETE');
    expect(log[0].req.headers?.authorization).toBe(`Bearer ${MGMT_KEY}`);
  });

  it('deleteCorpus throws on HTTP error', async () => {
    const backend = makeBackend([{ status: 404, body: {} }]);
    await expect(backend.deleteCorpus(corpus)).rejects.toThrow(/deleteCorpus failed/);
  });

  it('removeDocument issues DELETE to management collections/{id}/documents/{fileId}', async () => {
    const log: RequestLog = [];
    const backend = makeBackend([{ status: 200, body: {} }], log);
    await backend.removeDocument(corpus, 'file_xyz');
    expect(log[0].req.url).toBe(`${MGMT_BASE}/collections/col_abc/documents/file_xyz`);
    expect(log[0].req.method).toBe('DELETE');
    expect(log[0].req.headers?.authorization).toBe(`Bearer ${MGMT_KEY}`);
  });

  it('listCorpora issues GET to management base and returns CorpusRef[]', async () => {
    const log: RequestLog = [];
    const backend = makeBackend([{
      status: 200,
      body: [
        { collection_id: 'col_1', collection_name: 'store-1', documents_count: 2 },
        { collection_id: 'col_2', collection_name: 'store-2', documents_count: 0 },
      ],
    }], log);

    const list = await backend.listCorpora();

    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('col_1');
    expect(list[0].name).toBe('store-1');
    expect(list[0].backend).toBe('hostedXai');
    expect(list[1].id).toBe('col_2');
    expect(log[0].req.url).toBe(`${MGMT_BASE}/collections`);
    expect(log[0].req.headers?.authorization).toBe(`Bearer ${MGMT_KEY}`);
  });

  it('listCorpora returns [] on HTTP error', async () => {
    const backend = makeBackend([{ status: 500, body: {} }]);
    const list = await backend.listCorpora();
    expect(list).toEqual([]);
  });
});

// ─── Key plane isolation ──────────────────────────────────────────────────────

describe('hostedXai -- key plane isolation (no cross-plane bleed)', () => {
  it('management operations never send the standard key', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [
        { status: 200, body: { collection_id: 'c1', collection_name: 'n', documents_count: 0 } },
        { status: 200, body: { documents_count: 1 } },
        { status: 200, body: {} },
        { status: 200, body: {} },
        { status: 200, body: [] },
      ],
      log,
    );

    const corpus: CorpusRef = { id: 'c1', name: 'n', backend: 'hostedXai' };
    await backend.createCorpus({ name: 'n' });
    await backend.indexStatus(corpus);
    await backend.deleteCorpus(corpus);
    await backend.removeDocument(corpus, 'f1');
    await backend.listCorpora();

    for (const { req } of log) {
      expect(req.headers?.authorization).not.toBe(`Bearer ${STD_KEY}`);
      expect(req.headers?.authorization).toBe(`Bearer ${MGMT_KEY}`);
    }
  });

  it('standard operations never send the management key', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [{ status: 200, body: { results: [] } }],
      log,
    );

    const corpus: CorpusRef = { id: 'c1', name: 'n', backend: 'hostedXai' };
    await backend.search([corpus], 'query');

    for (const { req } of log) {
      expect(req.headers?.authorization).not.toBe(`Bearer ${MGMT_KEY}`);
      expect(req.headers?.authorization).toBe(`Bearer ${STD_KEY}`);
    }
  });
});

// ─── capabilities ─────────────────────────────────────────────────────────────

describe('hostedXai -- capabilities', () => {
  it('has the correct descriptor', () => {
    const backend = makeBackend([]);
    const cap = backend.capabilities;
    expect(cap.userChunking).toBe(false);
    expect(cap.searchModes).toEqual(['hybrid', 'keyword', 'semantic']);
    expect(cap.expiration).toBe(false);
    expect(cap.directSearch).toBe(true);
    expect(cap.idField).toBe('id');
    expect(cap.citationFormat).toBe('collections-uri');
  });
});
