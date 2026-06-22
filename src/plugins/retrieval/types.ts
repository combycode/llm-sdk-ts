/** Retrieval (RAG) subsystem — shared types.
 *
 *  Five-stage lifecycle shared by all backends:
 *    create corpus -> add documents -> index -> search / asTool -> cleanup
 *
 *  Provider-specific divergences live in capability flags + an `extra` passthrough
 *  bag, NOT in the core contract. This keeps the interface stable as Google and
 *  xAI backends are added later.
 *
 *  Anti-lock-in: CorpusRef/DocumentRef carry the original source metadata alongside
 *  the opaque provider id. The source documents are the rebuildable source of truth;
 *  never depend on exporting a hosted store's embeddings. */

import type { AgentTool } from '../../agent/types';

// ─── Source documents ────────────────────────────────────────────────────────

/** Text supplied by the caller; everything else is derived. */
export interface DocumentSource {
  /** Plain text content. */
  text: string;
  /** Caller-supplied label, e.g. a filename or URL. Stored for citation. */
  label?: string;
  /** Arbitrary key-value metadata the caller wants attached to chunks/hits. */
  metadata?: Record<string, unknown>;
}

// ─── Corpus and document references ─────────────────────────────────────────

/** Opaque reference to a corpus (vector store) on a particular backend.
 *  Carries the original creation options for rebuild support. */
export interface CorpusRef {
  /** Backend-specific identifier (e.g. OpenAI vector store id, or local UUID). */
  id: string;
  /** Human-readable label; stored alongside the id for display. */
  name: string;
  /** Which backend created this corpus. Needed for dispatch. */
  backend: RetrievalBackendName;
  /** Provider-specific extra fields (passthrough bag, not part of the core API). */
  extra?: Record<string, unknown>;
}

/** Reference to a single document within a corpus. */
export interface DocumentRef {
  /** Backend-specific document identifier. */
  id: string;
  /** The corpus this document belongs to. */
  corpusId: string;
  /** The original source supplied by the caller (for rebuildability). */
  source: DocumentSource;
  /** Provider-specific extra fields. */
  extra?: Record<string, unknown>;
}

// ─── Index status ────────────────────────────────────────────────────────────

/** Normalized indexing state across all backends. */
export type IndexState = 'pending' | 'indexing' | 'ready' | 'error';

export interface IndexCounts {
  /** Total documents in corpus. */
  total: number;
  /** Documents fully indexed. */
  indexed: number;
  /** Documents in error state. */
  failed: number;
}

export interface IndexStatus {
  state: IndexState;
  /** File-level counts (may be absent when not supported by a backend). */
  counts?: IndexCounts;
}

// ─── Search results ──────────────────────────────────────────────────────────

export interface RetrievalHit {
  /** Matched text chunk. */
  text: string;
  /** Cosine similarity score (0-1) or backend-specific relevance score. */
  score: number;
  /** Document reference id within the corpus. */
  docId: string;
  /** Original caller metadata attached to the document. */
  metadata?: Record<string, unknown>;
  /** Human-readable citation string (label + position). */
  citation?: string;
}

// ─── Tool specs ──────────────────────────────────────────────────────────────

/** Provider-native tool specification (splice directly into a provider API call).
 *  OpenAI/xAI shape: { type: 'file_search', vector_store_ids: [...] }
 *  Gemini shape: { fileSearch: { fileSearchStoreNames: [...] } } (no top-level type field)
 *  The index signature allows arbitrary provider-specific keys. */
export interface ProviderToolSpec {
  type?: string;
  vector_store_ids?: string[];
  max_num_results?: number;
  filters?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Options ─────────────────────────────────────────────────────────────────

/** Chunking strategy — named so defaults are never magic. */
export interface ChunkingOptions {
  /** Maximum chunk size in tokens (approximate via char heuristic). */
  maxTokens?: number;
  /** Overlap between consecutive chunks in tokens. */
  overlapTokens?: number;
}

export interface CreateCorpusOptions {
  name: string;
  chunking?: ChunkingOptions;
  /** How long the corpus lives on hosted backends (e.g. OpenAI `last_active_days`). */
  expiresAfter?: { anchor: 'last_active_at'; days: number };
  /** Embedding model for hosted backends that allow selection. */
  embeddingModel?: string;
}

export interface AddDocumentOptions {
  metadata?: Record<string, unknown>;
}

export interface RetrievalSearchOptions {
  /** Maximum number of hits to return (default: DEFAULT_SEARCH_TOP_K). */
  maxResults?: number;
  /** Minimum score threshold to include a hit (0-1). */
  minScore?: number;
  /** Backend-specific search mode (e.g. 'hybrid', 'semantic'). */
  searchMode?: string;
  /** Metadata filters (backend-specific). */
  filters?: Record<string, unknown>;
}

export interface AsToolOptions {
  maxResults?: number;
  searchMode?: string;
  filters?: Record<string, unknown>;
}

// ─── Capability descriptor ───────────────────────────────────────────────────

/** Static description of what a backend supports. Callers check these to
 *  degrade gracefully rather than hitting runtime errors. */
export interface RetrievalCapabilities {
  /** Whether the caller can control chunking (vs. fully automatic). */
  userChunking: boolean;
  /** Available search modes (e.g. ['hybrid'], ['cosine']). */
  searchModes: string[];
  /** Whether the backend supports corpus expiration. */
  expiration: boolean;
  /** Whether `search()` is supported directly (false for server-side-only). */
  directSearch: boolean;
  /** Identifier field name in returned hits (informational). */
  idField: string;
  /** Citation format emitted in `RetrievalHit.citation`. */
  citationFormat: 'label:offset' | 'file_id' | 'gemini' | 'collections-uri' | 'none';
}

// ─── Backend name ────────────────────────────────────────────────────────────

export type RetrievalBackendName =
  | 'local'
  | 'hostedOpenAI'
  | 'hostedGoogle'
  | 'hostedXai'
  | (string & NonNullable<unknown>);

// ─── Backend interface ───────────────────────────────────────────────────────

/** Unified interface all retrieval backends must implement. */
export interface RetrievalBackend {
  /** Descriptor: what this backend supports. Used for graceful degradation. */
  readonly capabilities: RetrievalCapabilities;

  /** Create a new corpus (vector store). */
  createCorpus(opts: CreateCorpusOptions): Promise<CorpusRef>;

  /** Add a document to a corpus (hides 1-step vs. 2-step upload differences). */
  addDocument(corpus: CorpusRef, source: DocumentSource, opts?: AddDocumentOptions): Promise<DocumentRef>;

  /** Normalized index status across all backends. */
  indexStatus(corpus: CorpusRef): Promise<IndexStatus>;

  /** Remove a single document from a corpus. */
  removeDocument(corpus: CorpusRef, docId: string): Promise<void>;

  /** Delete an entire corpus and all its documents. */
  deleteCorpus(corpus: CorpusRef): Promise<void>;

  /** List all corpora managed by this backend. */
  listCorpora(): Promise<CorpusRef[]>;

  /** Build a tool that can be passed to an AgentLoop (local: AgentTool) or
   *  spliced into a Responses call (hosted: ProviderToolSpec).
   *  The return type is a union: callers inspect `typeof result === 'object' &&
   *  'execute' in result` to distinguish AgentTool from ProviderToolSpec. */
  asTool(corpora: CorpusRef[], opts?: AsToolOptions): AgentTool | ProviderToolSpec;

  /** Direct search — supported by local and potentially some hosted backends.
   *  Backends that do not support it throw with a clear message. */
  search(corpora: CorpusRef[], query: string, opts?: RetrievalSearchOptions): Promise<RetrievalHit[]>;
}
