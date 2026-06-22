/** Hosted Google (Gemini) File Search backend.
 *
 *  Maps the unified RetrievalBackend interface to the Gemini File Search API:
 *    createCorpus   -> POST  {base}/v1beta/fileSearchStores
 *    addDocument    -> POST  {upload}/upload/v1beta/files (Files API)
 *                   -> POST  {base}/v1beta/{store}:importFile
 *    indexStatus    -> GET   {base}/v1beta/{store}  (normalized from count fields)
 *    removeDocument -> DELETE {base}/v1beta/{fileName}
 *    deleteCorpus   -> DELETE {base}/v1beta/{store}?force=true
 *    listCorpora    -> GET   {base}/v1beta/fileSearchStores
 *    asTool         -> returns ProviderToolSpec { fileSearch: { fileSearchStoreNames, ... } }
 *    search         -> not supported; use asTool
 *
 *  Auth: x-goog-api-key REQUEST HEADER (NOT ?key= query param) to avoid telemetry key-leak.
 *  See SEC-C1 in the readiness audit for why ?key= was fixed in the google provider adapter.
 *
 *  ALL HTTP flows through the injected EngineFetch (NetworkEngine queue).
 *  Never globalThis.fetch.
 *
 *  Note: the asTool() emitter produces the Gemini-native generateContent tool shape:
 *    { fileSearch: { fileSearchStoreNames: [...], metadataFilter? } }
 *  This diverges from the OpenAI/xAI `file_search` + `vector_store_ids` family on purpose.
 *  Google's File Search API uses its own AIP-160 filter and camelCase field names.
 *
 *  Provider behavior note: raw uploaded Files API files expire ~48h after upload.
 *  The fileSearchStore ITSELF persists until deleted. This asymmetry is provider-managed;
 *  callers should not depend on re-downloading the source file from Files API after 48h. */

import type { EngineFetch } from '../../network/types';
import type {
  AddDocumentOptions,
  AsToolOptions,
  CorpusRef,
  CreateCorpusOptions,
  DocumentRef,
  DocumentSource,
  IndexCounts,
  IndexState,
  IndexStatus,
  ProviderToolSpec,
  RetrievalBackend,
  RetrievalCapabilities,
  RetrievalHit,
  RetrievalSearchOptions,
} from './types';

// ─── Named constants ──────────────────────────────────────────────────────────

const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com';
const GOOGLE_PROVIDER_TAG = 'google';
const GOOGLE_RETRIEVAL_MODEL_TAG = 'fileSearchStores';
const HOSTED_BACKEND_NAME: 'hostedGoogle' = 'hostedGoogle';

/** Default embedding model for new file search stores. Caller-overridable via CreateCorpusOptions.embeddingModel. */
const DEFAULT_EMBEDDING_MODEL = 'models/gemini-embedding-2';

/** Default maximum tokens per chunk for importFile chunking config. */
const DEFAULT_CHUNK_MAX_TOKENS = 512;

/** Default overlap tokens for importFile chunking config. */
const DEFAULT_CHUNK_OVERLAP_TOKENS = 64;

/** Maximum page size for listCorpora requests (API cap: 20). */
const LIST_PAGE_SIZE = 20;

/** Gemini generateContent tool type field for file search. */
const GEMINI_FILE_SEARCH_TOOL_KEY = 'fileSearch';

// ─── Status normalisation ─────────────────────────────────────────────────────

/** Google REST returns int64 count fields as STRINGS (e.g. "1"); coerce safely
 *  so arithmetic adds numbers instead of concatenating strings. */
function toCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Normalise Google FileSearchStore count fields to our IndexState.
 *  Rules (from API spec):
 *    pending > 0                  -> 'indexing'
 *    failed > 0 && pending == 0   -> 'error'   (partial failure)
 *    active > 0 && pending == 0   -> 'ready'
 *    else                         -> 'pending'  (empty store or unknown) */
function normaliseGoogleStatus(
  active: number,
  pending: number,
  failed: number,
): IndexState {
  if (pending > 0) return 'indexing';
  if (failed > 0 && pending === 0) return 'error';
  if (active > 0 && pending === 0) return 'ready';
  return 'pending';
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface HostedGoogleRetrievalConfig {
  apiKey: string;
  fetch: EngineFetch;
  baseURL?: string;
}

// ─── Backend ──────────────────────────────────────────────────────────────────

export class HostedGoogleRetrievalBackend implements RetrievalBackend {
  readonly capabilities: RetrievalCapabilities = {
    userChunking: true,
    searchModes: ['semantic'],
    expiration: false,
    directSearch: false,
    idField: 'fileSearchStoreNames',
    citationFormat: 'gemini',
  };

  private readonly apiKey: string;
  private readonly fetch: EngineFetch;
  private readonly baseURL: string;

  constructor(config: HostedGoogleRetrievalConfig) {
    this.apiKey = config.apiKey;
    this.fetch = config.fetch;
    this.baseURL = config.baseURL ?? GOOGLE_BASE_URL;
  }

  private authHeaders(): Record<string, string> {
    return {
      'x-goog-api-key': this.apiKey,
      'content-type': 'application/json',
    };
  }

  /** Auth headers for multipart/form-data file upload (no content-type override). */
  private authHeadersNoContentType(): Record<string, string> {
    return { 'x-goog-api-key': this.apiKey };
  }

  async createCorpus(opts: CreateCorpusOptions): Promise<CorpusRef> {
    const body: Record<string, unknown> = {
      displayName: opts.name,
      embeddingModel: opts.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
    };

    const res = await this.fetch({
      url: `${this.baseURL}/v1beta/fileSearchStores`,
      method: 'POST',
      headers: this.authHeaders(),
      body,
      provider: GOOGLE_PROVIDER_TAG,
      model: GOOGLE_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });

    if (res.status >= 400) {
      throw new Error(`hostedGoogle: createCorpus failed (${res.status}): ${JSON.stringify(res.body)}`);
    }

    const data = res.body as Record<string, unknown>;
    return {
      id: data.name as string,
      name: (data.displayName as string) ?? opts.name,
      backend: HOSTED_BACKEND_NAME,
    };
  }

  async addDocument(
    corpus: CorpusRef,
    source: DocumentSource,
    opts?: AddDocumentOptions,
  ): Promise<DocumentRef> {
    // Step 1: Upload bytes via the Files API (text/plain).
    // The upload endpoint uses the same base URL under /upload/v1beta/files.
    const blob = new Blob([source.text], { type: 'text/plain' });
    const filename = source.label ?? `doc-${crypto.randomUUID().slice(0, 8)}.txt`;
    const form = new FormData();
    form.append('file', blob, filename);

    const uploadRes = await this.fetch({
      url: `${this.baseURL}/upload/v1beta/files`,
      method: 'POST',
      headers: this.authHeadersNoContentType(),
      body: form,
      rawBody: true,
      provider: GOOGLE_PROVIDER_TAG,
      model: GOOGLE_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });

    if (uploadRes.status >= 400) {
      throw new Error(`hostedGoogle: file upload failed (${uploadRes.status}): ${JSON.stringify(uploadRes.body)}`);
    }

    const uploadBody = (uploadRes.body as Record<string, unknown>) ?? {};
    const fileObj = (uploadBody.file as Record<string, unknown>) ?? uploadBody;
    const fileName = fileObj.name as string;

    // Step 2: Import the uploaded file into the file search store.
    const importBody: Record<string, unknown> = { fileName };

    const metadata = opts?.metadata ?? source.metadata;
    if (metadata) {
      importBody.customMetadata = Object.entries(metadata).map(([key, value]) => ({
        key,
        value: String(value),
      }));
    }

    if (source.text) {
      importBody.chunkingConfig = {
        whiteSpaceConfig: {
          maxTokensPerChunk: DEFAULT_CHUNK_MAX_TOKENS,
          maxOverlapTokens: DEFAULT_CHUNK_OVERLAP_TOKENS,
        },
      };
    }

    const importRes = await this.fetch({
      url: `${this.baseURL}/v1beta/${corpus.id}:importFile`,
      method: 'POST',
      headers: this.authHeaders(),
      body: importBody,
      provider: GOOGLE_PROVIDER_TAG,
      model: GOOGLE_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });

    if (importRes.status >= 400) {
      throw new Error(`hostedGoogle: importFile failed (${importRes.status}): ${JSON.stringify(importRes.body)}`);
    }

    // The importFile response is a long-running Operation.
    const op = importRes.body as Record<string, unknown>;
    const operationName = op.name as string;

    return {
      id: operationName ?? fileName,
      corpusId: corpus.id,
      source: { text: source.text, label: source.label, metadata: source.metadata },
      extra: { operationName, fileName },
    };
  }

  /** Poll a long-running Operation until done: true.
   *  Returns the operation body when complete. */
  async pollOperation(operationName: string): Promise<Record<string, unknown>> {
    for (;;) {
      const res = await this.fetch({
        url: `${this.baseURL}/v1beta/${operationName}`,
        method: 'GET',
        headers: this.authHeaders(),
        body: undefined,
        provider: GOOGLE_PROVIDER_TAG,
        model: GOOGLE_RETRIEVAL_MODEL_TAG,
        responseType: 'json',
      });

      if (res.status >= 400) {
        throw new Error(`hostedGoogle: operation poll failed (${res.status}): ${JSON.stringify(res.body)}`);
      }

      const op = res.body as Record<string, unknown>;
      if (op.done === true) return op;

      // Yield to event loop before polling again.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  async indexStatus(corpus: CorpusRef): Promise<IndexStatus> {
    const res = await this.fetch({
      url: `${this.baseURL}/v1beta/${corpus.id}`,
      method: 'GET',
      headers: this.authHeaders(),
      body: undefined,
      provider: GOOGLE_PROVIDER_TAG,
      model: GOOGLE_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });

    if (res.status >= 400) {
      return { state: 'error' };
    }

    const data = res.body as Record<string, unknown>;
    const active = toCount(data.activeDocumentsCount);
    const pending = toCount(data.pendingDocumentsCount);
    const failed = toCount(data.failedDocumentsCount);

    const state = normaliseGoogleStatus(active, pending, failed);
    const counts: IndexCounts = {
      total: active + pending + failed,
      indexed: active,
      failed,
    };

    return { state, counts };
  }

  async removeDocument(corpus: CorpusRef, docId: string): Promise<void> {
    // docId is the Files API file name (e.g. "files/xxx").
    await this.fetch({
      url: `${this.baseURL}/v1beta/${docId}`,
      method: 'DELETE',
      headers: this.authHeaders(),
      body: undefined,
      provider: GOOGLE_PROVIDER_TAG,
      model: GOOGLE_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });
    // Suppress errors — the file may have already expired (~48h provider TTL).
    void corpus;
  }

  async deleteCorpus(corpus: CorpusRef): Promise<void> {
    // force=true cascades deletion of all contained documents.
    const res = await this.fetch({
      url: `${this.baseURL}/v1beta/${corpus.id}?force=true`,
      method: 'DELETE',
      headers: this.authHeaders(),
      body: undefined,
      provider: GOOGLE_PROVIDER_TAG,
      model: GOOGLE_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });

    if (res.status >= 400) {
      throw new Error(`hostedGoogle: deleteCorpus failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
  }

  async listCorpora(): Promise<CorpusRef[]> {
    const allCorpora: CorpusRef[] = [];
    let pageToken: string | undefined;

    do {
      const url = pageToken
        ? `${this.baseURL}/v1beta/fileSearchStores?pageSize=${LIST_PAGE_SIZE}&pageToken=${encodeURIComponent(pageToken)}`
        : `${this.baseURL}/v1beta/fileSearchStores?pageSize=${LIST_PAGE_SIZE}`;

      const res = await this.fetch({
        url,
        method: 'GET',
        headers: this.authHeaders(),
        body: undefined,
        provider: GOOGLE_PROVIDER_TAG,
        model: GOOGLE_RETRIEVAL_MODEL_TAG,
        responseType: 'json',
      });

      if (res.status >= 400) break;

      const data = res.body as Record<string, unknown>;
      const items = (data.fileSearchStores as Array<Record<string, unknown>>) ?? [];

      for (const item of items) {
        allCorpora.push({
          id: item.name as string,
          name: (item.displayName as string) ?? '',
          backend: HOSTED_BACKEND_NAME,
        });
      }

      pageToken = data.nextPageToken as string | undefined;
    } while (pageToken);

    return allCorpora;
  }

  /** Returns a Gemini-native `fileSearch` ProviderToolSpec for splicing into a generateContent call.
   *  NOTE: this spec shape diverges from the OpenAI/xAI `file_search` + `vector_store_ids` family.
   *  Gemini uses camelCase `fileSearch` / `fileSearchStoreNames` with AIP-160 metadataFilter. */
  asTool(corpora: CorpusRef[], opts?: AsToolOptions): ProviderToolSpec {
    const fileSearch: Record<string, unknown> = {
      fileSearchStoreNames: corpora.map((c) => c.id),
    };

    if (opts?.filters !== undefined) {
      fileSearch.metadataFilter = opts.filters;
    }

    const spec: ProviderToolSpec = { [GEMINI_FILE_SEARCH_TOOL_KEY]: fileSearch };
    return spec;
  }

  /** Direct search is not supported for server-side Gemini file search stores.
   *  Use `asTool()` and splice the spec into a generateContent call instead. */
  async search(_corpora: CorpusRef[], _query: string, _opts?: RetrievalSearchOptions): Promise<RetrievalHit[]> {
    throw new Error(
      'hostedGoogle: direct search() is not supported. Use asTool() and splice the ' +
      'returned ProviderToolSpec into a generateContent call (fileSearch is server-side).',
    );
  }
}
