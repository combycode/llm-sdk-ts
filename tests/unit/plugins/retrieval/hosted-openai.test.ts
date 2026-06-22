/** HostedOpenAI retrieval backend unit tests.
 *
 *  No real network calls. All HTTP is stubbed via a fake EngineFetch. Tests:
 *    - createCorpus issues POST /v1/vector_stores with correct body
 *    - addDocument issues POST /v1/files then POST /v1/vector_stores/{id}/files
 *    - indexStatus normalises OpenAI status strings to our IndexState
 *    - deleteCorpus / removeDocument issue the right DELETE requests
 *    - listCorpora parses the data[] array
 *    - asTool emits the file_search ProviderToolSpec (NOT an AgentTool)
 *    - search() throws with a clear message
 *    - capabilities descriptor */

import { describe, expect, it } from 'bun:test';
import { HostedOpenAIRetrievalBackend } from '../../../../src/plugins/retrieval/hosted-openai';
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
  return new HostedOpenAIRetrievalBackend({
    apiKey: 'sk-test',
    fetch: stubFetch(responses, log),
  });
}

// ─── createCorpus ─────────────────────────────────────────────────────────────

describe('hostedOpenAI — createCorpus', () => {
  it('issues POST /v1/vector_stores and returns CorpusRef', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [{ status: 200, body: { id: 'vs_abc', name: 'my-store', status: 'in_progress' } }],
      log,
    );

    const corpus = await backend.createCorpus({ name: 'my-store' });

    expect(corpus.id).toBe('vs_abc');
    expect(corpus.name).toBe('my-store');
    expect(corpus.backend).toBe('hostedOpenAI');
    expect(log[0].req.url).toContain('/v1/vector_stores');
    expect(log[0].req.method).toBe('POST');
  });

  it('includes chunking_strategy when chunking opts provided', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [{ status: 200, body: { id: 'vs_1', name: 'n', status: 'in_progress' } }],
      log,
    );

    await backend.createCorpus({ name: 'n', chunking: { maxTokens: 400, overlapTokens: 100 } });

    const body = log[0].req.body as Record<string, unknown>;
    const cs = body.chunking_strategy as Record<string, unknown>;
    expect(cs.type).toBe('static');
    const st = cs.static as Record<string, unknown>;
    expect(st.max_chunk_size_tokens).toBe(400);
    expect(st.chunk_overlap_tokens).toBe(100);
  });

  it('includes expires_after when expiresAfter provided', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [{ status: 200, body: { id: 'vs_2', name: 'n', status: 'in_progress' } }],
      log,
    );

    await backend.createCorpus({
      name: 'n',
      expiresAfter: { anchor: 'last_active_at', days: 7 },
    });

    const body = log[0].req.body as Record<string, unknown>;
    const ea = body.expires_after as Record<string, unknown>;
    expect(ea.anchor).toBe('last_active_at');
    expect(ea.days).toBe(7);
  });

  it('throws on HTTP error', async () => {
    const backend = makeBackend([{ status: 400, body: { error: { message: 'bad' } } }]);
    await expect(backend.createCorpus({ name: 'n' })).rejects.toThrow(/createCorpus failed/);
  });
});

// ─── addDocument ─────────────────────────────────────────────────────────────

describe('hostedOpenAI — addDocument', () => {
  const corpus: CorpusRef = { id: 'vs_abc', name: 'store', backend: 'hostedOpenAI' };

  it('issues POST /v1/files then POST /v1/vector_stores/{id}/files', async () => {
    const log: RequestLog = [];
    const backend = makeBackend(
      [
        { status: 200, body: { id: 'file_123', filename: 'doc.txt' } },
        { status: 200, body: { id: 'file_123', status: 'in_progress' } },
      ],
      log,
    );

    const ref = await backend.addDocument(corpus, { text: 'hello world', label: 'doc.txt' });

    expect(ref.id).toBe('file_123');
    expect(ref.corpusId).toBe('vs_abc');
    expect(log[0].req.url).toContain('/v1/files');
    expect(log[0].req.method).toBe('POST');
    expect(log[1].req.url).toContain('/v1/vector_stores/vs_abc/files');
    expect(log[1].req.method).toBe('POST');
  });

  it('preserves source on the returned DocumentRef', async () => {
    const backend = makeBackend([
      { status: 200, body: { id: 'file_x' } },
      { status: 200, body: { id: 'file_x' } },
    ]);

    const ref = await backend.addDocument(corpus, {
      text: 'content',
      label: 'file.txt',
      metadata: { author: 'alice' },
    });

    expect(ref.source.text).toBe('content');
    expect(ref.source.label).toBe('file.txt');
    expect(ref.source.metadata?.author).toBe('alice');
  });

  it('throws when file upload fails', async () => {
    const backend = makeBackend([{ status: 400, body: { error: 'bad' } }]);
    await expect(
      backend.addDocument(corpus, { text: 'hi' }),
    ).rejects.toThrow(/file upload failed/);
  });

  it('throws when attach step fails', async () => {
    const backend = makeBackend([
      { status: 200, body: { id: 'file_ok' } },
      { status: 400, body: { error: 'quota' } },
    ]);
    await expect(
      backend.addDocument(corpus, { text: 'hi' }),
    ).rejects.toThrow(/attach file failed/);
  });
});

// ─── indexStatus ──────────────────────────────────────────────────────────────

describe('hostedOpenAI — indexStatus', () => {
  const corpus: CorpusRef = { id: 'vs_abc', name: 'store', backend: 'hostedOpenAI' };

  it('normalises "completed" -> "ready"', async () => {
    const backend = makeBackend([{
      status: 200,
      body: { id: 'vs_abc', status: 'completed', file_counts: { total: 2, completed: 2, failed: 0 } },
    }]);
    const s = await backend.indexStatus(corpus);
    expect(s.state).toBe('ready');
    expect(s.counts?.total).toBe(2);
    expect(s.counts?.indexed).toBe(2);
    expect(s.counts?.failed).toBe(0);
  });

  it('normalises "in_progress" -> "indexing"', async () => {
    const backend = makeBackend([{
      status: 200,
      body: { id: 'vs_abc', status: 'in_progress', file_counts: { total: 1, completed: 0, failed: 0 } },
    }]);
    const s = await backend.indexStatus(corpus);
    expect(s.state).toBe('indexing');
  });

  it('normalises "expired" -> "error"', async () => {
    const backend = makeBackend([{
      status: 200,
      body: { id: 'vs_abc', status: 'expired', file_counts: { total: 0, completed: 0, failed: 0 } },
    }]);
    const s = await backend.indexStatus(corpus);
    expect(s.state).toBe('error');
  });

  it('unknown status falls back to "pending"', async () => {
    const backend = makeBackend([{
      status: 200,
      body: { id: 'vs_abc', status: 'some_future_state' },
    }]);
    const s = await backend.indexStatus(corpus);
    expect(s.state).toBe('pending');
  });

  it('returns error state on HTTP error', async () => {
    const backend = makeBackend([{ status: 404, body: {} }]);
    const s = await backend.indexStatus(corpus);
    expect(s.state).toBe('error');
  });
});

// ─── deleteCorpus / removeDocument / listCorpora ──────────────────────────────

describe('hostedOpenAI — delete and list', () => {
  const corpus: CorpusRef = { id: 'vs_abc', name: 'store', backend: 'hostedOpenAI' };

  it('deleteCorpus issues DELETE /v1/vector_stores/{id}', async () => {
    const log: RequestLog = [];
    const backend = makeBackend([{ status: 200, body: {} }], log);
    await backend.deleteCorpus(corpus);
    expect(log[0].req.url).toContain('/v1/vector_stores/vs_abc');
    expect(log[0].req.method).toBe('DELETE');
  });

  it('removeDocument issues DELETE /v1/vector_stores/{id}/files/{fileId}', async () => {
    const log: RequestLog = [];
    const backend = makeBackend([{ status: 200, body: {} }], log);
    await backend.removeDocument(corpus, 'file_xyz');
    expect(log[0].req.url).toContain('/v1/vector_stores/vs_abc/files/file_xyz');
    expect(log[0].req.method).toBe('DELETE');
  });

  it('listCorpora parses data[] and returns CorpusRef[]', async () => {
    const backend = makeBackend([{
      status: 200,
      body: {
        data: [
          { id: 'vs_1', name: 'store-1' },
          { id: 'vs_2', name: 'store-2' },
        ],
      },
    }]);
    const list = await backend.listCorpora();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('vs_1');
    expect(list[0].backend).toBe('hostedOpenAI');
    expect(list[1].name).toBe('store-2');
  });

  it('listCorpora returns [] on HTTP error', async () => {
    const backend = makeBackend([{ status: 500, body: {} }]);
    const list = await backend.listCorpora();
    expect(list).toEqual([]);
  });
});

// ─── asTool ───────────────────────────────────────────────────────────────────

describe('hostedOpenAI — asTool', () => {
  it('returns a ProviderToolSpec (not an AgentTool)', () => {
    const backend = makeBackend([]);
    const corpora: CorpusRef[] = [
      { id: 'vs_1', name: 's1', backend: 'hostedOpenAI' },
      { id: 'vs_2', name: 's2', backend: 'hostedOpenAI' },
    ];

    const spec = backend.asTool(corpora);

    // ProviderToolSpec has type field but NOT execute()
    expect('execute' in spec).toBe(false);
    expect(spec.type).toBe('file_search');
    expect(spec.vector_store_ids).toEqual(['vs_1', 'vs_2']);
  });

  it('includes max_num_results when provided', () => {
    const backend = makeBackend([]);
    const spec = backend.asTool(
      [{ id: 'vs_1', name: 's', backend: 'hostedOpenAI' }],
      { maxResults: 10 },
    );
    expect(spec.max_num_results).toBe(10);
  });

  it('includes filters when provided', () => {
    const backend = makeBackend([]);
    const spec = backend.asTool(
      [{ id: 'vs_1', name: 's', backend: 'hostedOpenAI' }],
      { filters: { category: 'news' } },
    );
    expect((spec.filters as Record<string, unknown>).category).toBe('news');
  });

  it('omits optional fields when not provided', () => {
    const backend = makeBackend([]);
    const spec = backend.asTool([{ id: 'vs_1', name: 's', backend: 'hostedOpenAI' }]);
    expect(spec.max_num_results).toBeUndefined();
    expect(spec.filters).toBeUndefined();
  });
});

// ─── search unsupported ───────────────────────────────────────────────────────

describe('hostedOpenAI — search() is unsupported', () => {
  it('throws with a message directing to asTool', async () => {
    const backend = makeBackend([]);
    await expect(
      backend.search([{ id: 'vs_1', name: 's', backend: 'hostedOpenAI' }], 'query'),
    ).rejects.toThrow(/use asTool/i);
  });
});

// ─── capabilities ─────────────────────────────────────────────────────────────

describe('hostedOpenAI — capabilities', () => {
  it('has the correct descriptor', () => {
    const backend = makeBackend([]);
    const cap = backend.capabilities;
    expect(cap.directSearch).toBe(false);
    expect(cap.userChunking).toBe(true);
    expect(cap.expiration).toBe(true);
    expect(cap.searchModes).toContain('hybrid');
    expect(cap.citationFormat).toBe('file_id');
  });
});
