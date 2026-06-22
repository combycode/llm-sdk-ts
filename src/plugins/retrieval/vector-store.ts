/** VectorStore — interface + in-memory reference implementation.
 *
 *  The interface is intentionally minimal so callers can plug a real DB
 *  (pgvector, Qdrant, Weaviate, etc.) via their own adapter:
 *
 *    // bring-your-own backend:
 *    class MyPgVectorStore implements VectorStore { ... }
 *    const backend = localRetrieval({ vectorStore: new MyPgVectorStore() });
 *
 *  The bundled `InMemoryVectorStore` is the default. It uses cosine similarity,
 *  runs fully in-process, works in the browser, and has zero external deps.
 *  It supports optional persistence via the cross-env `Persistence` layer so
 *  vectors survive process restarts (opt-in; default is ephemeral). */

import type { Persistence } from '../persistence/types';

// ─── Named constants (no magic values) ───────────────────────────────────────

/** Minimum cosine-similarity denominator to avoid division by zero. */
const COSINE_EPSILON = 1e-10;

/** Key used when serialising the full store to Persistence. */
const PERSISTENCE_STORE_KEY = 'retrieval:vector-store';

// ─── Stored entry ─────────────────────────────────────────────────────────────

/** A single chunk stored in the vector store. */
export interface VectorEntry {
  /** Corpus-scoped unique identifier for this chunk. */
  id: string;
  /** ID of the source document. */
  docId: string;
  /** ID of the corpus this entry belongs to. */
  corpusId: string;
  /** The embedding vector. */
  vector: number[];
  /** The original text of this chunk. */
  text: string;
  /** Caller-provided metadata from the document source. */
  metadata?: Record<string, unknown>;
  /** Human-readable citation (e.g. "label:offset"). */
  citation?: string;
}

// ─── VectorStore interface ────────────────────────────────────────────────────

/** Pluggable vector storage. Implement this to use any real DB backend.
 *  The in-memory default `InMemoryVectorStore` satisfies this contract. */
export interface VectorStore {
  /** Insert an entry. Overwrites any existing entry with the same `id`. */
  upsert(entry: VectorEntry): Promise<void>;

  /** Remove all entries for a given document. */
  removeByDocId(corpusId: string, docId: string): Promise<void>;

  /** Remove all entries for an entire corpus. */
  removeByCorpusId(corpusId: string): Promise<void>;

  /** Top-k nearest neighbours within a corpus by cosine similarity.
   *  Returns at most `topK` hits ordered by descending score. */
  query(corpusId: string, vector: number[], topK: number): Promise<Array<{ entry: VectorEntry; score: number }>>;

  /** Count stored entries, optionally scoped to a corpus. */
  count(corpusId?: string): Promise<number>;
}

// ─── Serialised snapshot (for Persistence) ───────────────────────────────────

interface StoreSnapshot {
  entries: VectorEntry[];
}

// ─── In-memory reference implementation ──────────────────────────────────────

export interface InMemoryVectorStoreConfig {
  /** Optional persistence layer. When supplied the store saves/loads via it.
   *  Omit (default) for an entirely ephemeral in-process store. */
  persistence?: Persistence;
}

export class InMemoryVectorStore implements VectorStore {
  private entries: VectorEntry[] = [];
  private readonly persistence: Persistence | null;
  private loaded = false;

  constructor(config: InMemoryVectorStoreConfig = {}) {
    this.persistence = config.persistence ?? null;
  }

  async upsert(entry: VectorEntry): Promise<void> {
    await this.ensureLoaded();
    const idx = this.entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      this.entries[idx] = entry;
    } else {
      this.entries.push(entry);
    }
    await this.persist();
  }

  async removeByDocId(corpusId: string, docId: string): Promise<void> {
    await this.ensureLoaded();
    this.entries = this.entries.filter((e) => !(e.corpusId === corpusId && e.docId === docId));
    await this.persist();
  }

  async removeByCorpusId(corpusId: string): Promise<void> {
    await this.ensureLoaded();
    this.entries = this.entries.filter((e) => e.corpusId !== corpusId);
    await this.persist();
  }

  async query(
    corpusId: string,
    vector: number[],
    topK: number,
  ): Promise<Array<{ entry: VectorEntry; score: number }>> {
    await this.ensureLoaded();
    const corpus = this.entries.filter((e) => e.corpusId === corpusId);
    const scored = corpus.map((entry) => ({
      entry,
      score: cosineSimilarity(vector, entry.vector),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async count(corpusId?: string): Promise<number> {
    await this.ensureLoaded();
    if (corpusId === undefined) return this.entries.length;
    return this.entries.filter((e) => e.corpusId === corpusId).length;
  }

  // ─── Persistence helpers ─────────────────────────────────────────────────

  private async ensureLoaded(): Promise<void> {
    if (this.loaded || !this.persistence) {
      this.loaded = true;
      return;
    }
    const snap = await this.persistence.get<StoreSnapshot>(PERSISTENCE_STORE_KEY);
    if (snap) this.entries = snap.entries;
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    if (!this.persistence) return;
    const snap: StoreSnapshot = { entries: this.entries };
    await this.persistence.set(PERSISTENCE_STORE_KEY, snap);
  }
}

// ─── Cosine similarity ────────────────────────────────────────────────────────

/** Cosine similarity between two equal-length vectors. Returns 0 for zero vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < COSINE_EPSILON) return 0;
  return dot / denom;
}
