/** Local retrieval backend — zero-dep, cross-env (including browser).
 *
 *  Uses OUR embed() helper for vectors and an in-memory VectorStore by default.
 *  Callers can inject any VectorStore implementation (pgvector, Qdrant, etc.).
 *
 *  `asTool()` returns a real AgentTool so it works with Anthropic and every
 *  other provider that runs tool calls client-side. */

import type { AgentTool } from '../../agent/types';
import type { EngineFetch } from '../../network/types';
import type { EmbeddingProviderAdapter } from '../embeddings/types';
import type { Persistence } from '../persistence/types';
import { chunkText, DEFAULT_CHUNK_MAX_TOKENS, DEFAULT_CHUNK_OVERLAP_TOKENS } from './chunker';
import type {
  AddDocumentOptions,
  AsToolOptions,
  CorpusRef,
  CreateCorpusOptions,
  DocumentRef,
  DocumentSource,
  IndexStatus,
  RetrievalBackend,
  RetrievalCapabilities,
  RetrievalHit,
  RetrievalSearchOptions,
} from './types';
import { InMemoryVectorStore, type VectorStore } from './vector-store';

// ─── Named constants ──────────────────────────────────────────────────────────

/** Default top-k results returned by search(). */
const DEFAULT_SEARCH_TOP_K = 5;

/** Default minimum cosine score to include a hit. */
const DEFAULT_MIN_SCORE = 0;

/** Tool name exposed to the agent loop — matches the OpenAI built-in name
 *  for semantic parity, but this one runs client-side. */
const LOCAL_TOOL_NAME = 'file_search';

/** Description passed to the LLM in the tool schema. */
const LOCAL_TOOL_DESCRIPTION =
  'Search the local knowledge base for passages relevant to the query.';

const LOCAL_BACKEND_NAME: 'local' = 'local';

export interface LocalRetrievalConfig {
  /** Embedding adapter — required for the local backend. */
  embedAdapter: EmbeddingProviderAdapter;

  /** Engine fetch function (NetworkEngine.fetch), passed to the embed adapter. */
  fetch: EngineFetch;

  /** Pluggable vector store. Defaults to InMemoryVectorStore.
   *  // bring-your-own backend: pass your own VectorStore implementation here. */
  vectorStore?: VectorStore;

  /** Optional persistence for the default InMemoryVectorStore (ignored when
   *  a custom vectorStore is provided). */
  persistence?: Persistence;

  /** Embedding model identifier (e.g. 'text-embedding-3-small'). */
  embeddingModel: string;

  /** Default chunk size in tokens. */
  defaultMaxTokens?: number;

  /** Default overlap in tokens. */
  defaultOverlapTokens?: number;
}

// ─── Local backend ────────────────────────────────────────────────────────────

export class LocalRetrievalBackend implements RetrievalBackend {
  readonly capabilities: RetrievalCapabilities = {
    userChunking: true,
    searchModes: ['cosine'],
    expiration: false,
    directSearch: true,
    idField: 'id',
    citationFormat: 'label:offset',
  };

  private readonly embedAdapter: EmbeddingProviderAdapter;
  private readonly fetch: EngineFetch;
  private readonly vectorStore: VectorStore;
  private readonly embeddingModel: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultOverlapTokens: number;
  private readonly corpora = new Map<string, CorpusRef>();

  constructor(config: LocalRetrievalConfig) {
    this.embedAdapter = config.embedAdapter;
    this.fetch = config.fetch;
    this.embeddingModel = config.embeddingModel;
    this.defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_CHUNK_MAX_TOKENS;
    this.defaultOverlapTokens = config.defaultOverlapTokens ?? DEFAULT_CHUNK_OVERLAP_TOKENS;
    this.vectorStore = config.vectorStore ?? new InMemoryVectorStore({ persistence: config.persistence });
  }

  async createCorpus(opts: CreateCorpusOptions): Promise<CorpusRef> {
    const id = generateId();
    const ref: CorpusRef = { id, name: opts.name, backend: LOCAL_BACKEND_NAME };
    this.corpora.set(id, ref);
    return ref;
  }

  async addDocument(
    corpus: CorpusRef,
    source: DocumentSource,
    opts?: AddDocumentOptions,
  ): Promise<DocumentRef> {
    const docId = generateId();
    const meta = { ...source.metadata, ...opts?.metadata };

    const chunks = chunkText(source.text, {
      maxTokens: this.defaultMaxTokens,
      overlapTokens: this.defaultOverlapTokens,
    });

    const texts = chunks.map((c) => c.text);
    const result = await this.embedAdapter.embed(
      { model: this.embeddingModel, input: texts },
      this.fetch,
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const vector = result.embeddings[i] ?? [];
      const citation = source.label ? `${source.label}:${chunk.offset}` : undefined;
      await this.vectorStore.upsert({
        id: `${docId}:${i}`,
        docId,
        corpusId: corpus.id,
        vector,
        text: chunk.text,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
        citation,
      });
    }

    return {
      id: docId,
      corpusId: corpus.id,
      source: { text: source.text, label: source.label, metadata: source.metadata },
    };
  }

  async indexStatus(corpus: CorpusRef): Promise<IndexStatus> {
    const count = await this.vectorStore.count(corpus.id);
    return {
      state: 'ready',
      counts: { total: count, indexed: count, failed: 0 },
    };
  }

  async removeDocument(corpus: CorpusRef, docId: string): Promise<void> {
    await this.vectorStore.removeByDocId(corpus.id, docId);
  }

  async deleteCorpus(corpus: CorpusRef): Promise<void> {
    await this.vectorStore.removeByCorpusId(corpus.id);
    this.corpora.delete(corpus.id);
  }

  async listCorpora(): Promise<CorpusRef[]> {
    return Array.from(this.corpora.values());
  }

  asTool(corpora: CorpusRef[], opts?: AsToolOptions): AgentTool {
    const maxResults = opts?.maxResults ?? DEFAULT_SEARCH_TOP_K;
    const minScore = DEFAULT_MIN_SCORE;

    return {
      definition: {
        name: LOCAL_TOOL_NAME,
        description: LOCAL_TOOL_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query text.' },
          },
          required: ['query'],
        },
      },
      execute: async (args) => {
        const query = String(args.query ?? '');
        const hits = await this.search(corpora, query, { maxResults, minScore });
        return formatHits(hits);
      },
    };
  }

  async search(
    corpora: CorpusRef[],
    query: string,
    opts?: RetrievalSearchOptions,
  ): Promise<RetrievalHit[]> {
    const topK = opts?.maxResults ?? DEFAULT_SEARCH_TOP_K;
    const minScore = opts?.minScore ?? DEFAULT_MIN_SCORE;

    const result = await this.embedAdapter.embed(
      { model: this.embeddingModel, input: query },
      this.fetch,
    );
    const vector = result.embeddings[0] ?? [];

    const allHits: RetrievalHit[] = [];
    for (const corpus of corpora) {
      const matches = await this.vectorStore.query(corpus.id, vector, topK);
      for (const { entry, score } of matches) {
        if (score >= minScore) {
          allHits.push({
            text: entry.text,
            score,
            docId: entry.docId,
            metadata: entry.metadata,
            citation: entry.citation,
          });
        }
      }
    }

    // Re-rank across corpora and truncate
    allHits.sort((a, b) => b.score - a.score);
    return allHits.slice(0, topK);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

/** Format search hits as a plain-text string for the agent tool response. */
function formatHits(hits: RetrievalHit[]): string {
  if (hits.length === 0) return 'No relevant passages found.';
  return hits
    .map((h, i) => {
      const cite = h.citation ? ` [${h.citation}]` : '';
      return `[${i + 1}]${cite} (score ${h.score.toFixed(3)})\n${h.text}`;
    })
    .join('\n\n');
}

