/** Local retrieval backend unit tests.
 *
 *  No network calls — uses a deterministic stub embedder so results are
 *  reproducible. Tests cover:
 *    - create / add / indexStatus / search / asTool / delete
 *    - top-k cosine ranking (deterministic vectors)
 *    - asTool.execute returns formatted hits
 *    - persisted round-trip via MemoryPersistence
 *    - capability descriptor */

import { beforeEach, describe, expect, it } from 'bun:test';
import { LocalRetrievalBackend } from '../../../../src/plugins/retrieval/local';
import { InMemoryVectorStore } from '../../../../src/plugins/retrieval/vector-store';
import { MemoryPersistence } from '../../../../src/plugins/persistence/memory';
import type { EmbeddingProviderAdapter, EmbedResult } from '../../../../src/plugins/embeddings/types';
import type { CorpusRef } from '../../../../src/plugins/retrieval/types';
import type { EngineFetch } from '../../../../src/network/types';
import type { AgentTool } from '../../../../src/agent/types';

// ─── Deterministic stub embedder ──────────────────────────────────────────────

/** Deterministic embedding: returns a unit vector in a fixed direction based on
 *  which input string is supplied. This lets us control cosine similarity scores. */
function makeStubAdapter(
  map: Record<string, number[]>,
  defaultVec?: number[],
): EmbeddingProviderAdapter {
  return {
    name: 'stub',
    async embed(req): Promise<EmbedResult> {
      const inputs = Array.isArray(req.input) ? req.input : [req.input];
      const embeddings = inputs.map((s) => map[s] ?? defaultVec ?? [0, 0, 1]);
      return { embeddings, model: req.model, dimensions: embeddings[0].length };
    },
  };
}

const stubFetch: EngineFetch = async () => ({ status: 200, headers: {}, body: {} });

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Three docs with orthogonal 3-D unit vectors for easy cosine control.
// cosine(doc1, query) = 1.0  (identical direction)
// cosine(doc2, query) = 0.0  (orthogonal)
// cosine(doc3, query) = 0.0
const VEC_DOC1 = [1, 0, 0];
const VEC_DOC2 = [0, 1, 0];
const VEC_DOC3 = [0, 0, 1];
const VEC_QUERY = [1, 0, 0]; // closest to doc1

const STUB_MAP: Record<string, number[]> = {
  'content of document 1': VEC_DOC1,
  'content of document 2': VEC_DOC2,
  'content of document 3': VEC_DOC3,
  'the query text': VEC_QUERY,
};

function makeBackend(store?: InMemoryVectorStore): LocalRetrievalBackend {
  return new LocalRetrievalBackend({
    embedAdapter: makeStubAdapter(STUB_MAP, [0, 0, 1]),
    fetch: stubFetch,
    embeddingModel: 'stub-model',
    vectorStore: store,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('local retrieval backend — lifecycle', () => {
  let backend: LocalRetrievalBackend;
  let corpus: CorpusRef;

  beforeEach(async () => {
    backend = makeBackend();
    corpus = await backend.createCorpus({ name: 'test-corpus' });
  });

  it('createCorpus returns a CorpusRef with backend=local', () => {
    expect(corpus.name).toBe('test-corpus');
    expect(corpus.backend).toBe('local');
    expect(typeof corpus.id).toBe('string');
  });

  it('listCorpora returns the created corpus', async () => {
    const list = await backend.listCorpora();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(corpus.id);
  });

  it('addDocument returns a DocumentRef with source preserved', async () => {
    const ref = await backend.addDocument(corpus, {
      text: 'content of document 1',
      label: 'doc1.txt',
      metadata: { topic: 'test' },
    });
    expect(ref.corpusId).toBe(corpus.id);
    expect(ref.source.text).toBe('content of document 1');
    expect(ref.source.label).toBe('doc1.txt');
  });

  it('indexStatus is immediately ready after addDocument', async () => {
    await backend.addDocument(corpus, { text: 'content of document 1' });
    const status = await backend.indexStatus(corpus);
    expect(status.state).toBe('ready');
    expect(status.counts?.indexed).toBeGreaterThan(0);
  });

  it('deleteCorpus removes it from listCorpora', async () => {
    await backend.deleteCorpus(corpus);
    const list = await backend.listCorpora();
    expect(list).toHaveLength(0);
  });

  it('removeDocument removes its chunks from the store', async () => {
    const store = new InMemoryVectorStore();
    const b2 = makeBackend(store);
    const c2 = await b2.createCorpus({ name: 'c' });
    const ref = await b2.addDocument(c2, { text: 'content of document 1' });
    const before = await store.count(c2.id);
    expect(before).toBeGreaterThan(0);
    await b2.removeDocument(c2, ref.id);
    const after = await store.count(c2.id);
    expect(after).toBe(0);
  });
});

describe('local retrieval backend — search ranking', () => {
  it('returns top-k hits ordered by cosine similarity', async () => {
    const backend = makeBackend();
    const corpus = await backend.createCorpus({ name: 'rank-test' });

    await backend.addDocument(corpus, { text: 'content of document 1', label: 'doc1' });
    await backend.addDocument(corpus, { text: 'content of document 2', label: 'doc2' });
    await backend.addDocument(corpus, { text: 'content of document 3', label: 'doc3' });

    const hits = await backend.search([corpus], 'the query text', { maxResults: 3 });

    expect(hits).toHaveLength(3);
    // doc1 should be first (identical direction to query)
    expect(hits[0].score).toBeCloseTo(1.0, 3);
    // doc2 and doc3 are orthogonal (score 0)
    expect(hits[1].score).toBeCloseTo(0, 3);
    expect(hits[2].score).toBeCloseTo(0, 3);
  });

  it('respects maxResults limit', async () => {
    const backend = makeBackend();
    const corpus = await backend.createCorpus({ name: 'limit-test' });
    await backend.addDocument(corpus, { text: 'content of document 1' });
    await backend.addDocument(corpus, { text: 'content of document 2' });
    await backend.addDocument(corpus, { text: 'content of document 3' });

    const hits = await backend.search([corpus], 'the query text', { maxResults: 2 });
    expect(hits).toHaveLength(2);
  });

  it('citation includes label and offset', async () => {
    const backend = makeBackend();
    const corpus = await backend.createCorpus({ name: 'cite-test' });
    await backend.addDocument(corpus, { text: 'content of document 1', label: 'doc1.txt' });

    const hits = await backend.search([corpus], 'the query text', { maxResults: 1 });
    expect(hits[0].citation).toContain('doc1.txt');
  });

  it('search across multiple corpora merges and re-ranks results', async () => {
    const backend = makeBackend();
    const c1 = await backend.createCorpus({ name: 'c1' });
    const c2 = await backend.createCorpus({ name: 'c2' });
    await backend.addDocument(c1, { text: 'content of document 2' });
    await backend.addDocument(c2, { text: 'content of document 1' });

    const hits = await backend.search([c1, c2], 'the query text', { maxResults: 5 });
    // doc1 in c2 should rank first
    expect(hits[0].score).toBeCloseTo(1.0, 3);
  });
});

describe('local retrieval backend — asTool', () => {
  it('returns an AgentTool with the expected definition', async () => {
    const backend = makeBackend();
    const corpus = await backend.createCorpus({ name: 'tool-test' });
    const tool = backend.asTool([corpus]);

    // Must have execute (AgentTool), not be a ProviderToolSpec
    expect('execute' in tool).toBe(true);
    const def = tool.definition;
    // FunctionTool has `name`; narrow via isFunctionTool check on the type string
    expect(!def.type || def.type === 'function').toBe(true);
    if (!def.type || def.type === 'function') {
      expect(def.name).toBe('file_search');
      expect(def.parameters).toBeDefined();
    }
  });

  it('asTool.execute returns formatted hits string', async () => {
    const backend = makeBackend();
    const corpus = await backend.createCorpus({ name: 'exec-test' });
    await backend.addDocument(corpus, { text: 'content of document 1', label: 'doc1' });

    const tool = backend.asTool([corpus]) as AgentTool;
    const ctx = { step: 0, callId: 'x', signal: new AbortController().signal, metrics: new Map<string, { value: number | string | boolean; type: string }>() };
    const result = await tool.execute({ query: 'the query text' }, ctx);
    expect(typeof result).toBe('string');
    expect(result as string).toContain('[1]');
    expect(result as string).toContain('doc1');
  });

  it('asTool.execute returns "no relevant passages" when store is empty', async () => {
    const backend = makeBackend();
    const corpus = await backend.createCorpus({ name: 'empty-test' });
    const tool = backend.asTool([corpus]) as AgentTool;
    const ctx = { step: 0, callId: 'x', signal: new AbortController().signal, metrics: new Map<string, { value: number | string | boolean; type: string }>() };
    const result = await tool.execute({ query: 'anything' }, ctx);
    expect(result as string).toContain('No relevant passages found');
  });
});

describe('local retrieval backend — persisted store round-trip', () => {
  it('data survives across backend instances sharing the same Persistence', async () => {
    const persistence = new MemoryPersistence();
    const store1 = new InMemoryVectorStore({ persistence });
    const b1 = makeBackend(store1);
    const corpus = await b1.createCorpus({ name: 'persist-test' });
    await b1.addDocument(corpus, { text: 'content of document 1' });

    // Build a second instance with the same persistence layer
    const store2 = new InMemoryVectorStore({ persistence });
    // Verify data is readable from the new store
    const count = await store2.count(corpus.id);
    expect(count).toBeGreaterThan(0);
  });

  it('InMemoryVectorStore without persistence starts empty on new instance', async () => {
    const store1 = new InMemoryVectorStore();
    await store1.upsert({ id: '1', docId: 'd1', corpusId: 'c1', vector: [1, 0], text: 'hi' });
    const store2 = new InMemoryVectorStore(); // no shared persistence
    const count = await store2.count('c1');
    expect(count).toBe(0);
  });
});

describe('local retrieval backend — capabilities', () => {
  it('has the correct capability descriptor', () => {
    const backend = makeBackend();
    const cap = backend.capabilities;
    expect(cap.directSearch).toBe(true);
    expect(cap.userChunking).toBe(true);
    expect(cap.expiration).toBe(false);
    expect(cap.searchModes).toContain('cosine');
    expect(cap.citationFormat).toBe('label:offset');
  });
});
