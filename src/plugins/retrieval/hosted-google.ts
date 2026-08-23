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

import type { EngineFetch, HttpRequest } from '../../network/types';
import { buildFromSpec, type MultipartField, type Registry } from '../../wire/interpreter';
import { retrievalSpec } from '../../wire/retrieval-specs';
import { makeRegistry } from '../../llm/wire-transforms';
import { toFormData, type MultipartFile } from '../../llm/wire-multipart';
import { documentFile } from './document-file';
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

  /** File-search rules need no adapter handles. */
  private readonly wireRegistry: Registry = makeRegistry({});

  /** Build one file-search request from its spec, then add the engine metadata.
   *
   *  `provider` / `model` / `responseType` route and queue the call inside the
   *  NetworkEngine; they are not part of the wire, so they wrap the spec's output
   *  rather than being described by it. */
  private request(specId: string, input: object, file?: MultipartFile): HttpRequest {
    const built = buildFromSpec(
      retrievalSpec(specId),
      input as never,
      this.wireRegistry,
      GOOGLE_PROVIDER_TAG,
      undefined,
      { baseURL: this.baseURL, apiKey: this.apiKey },
    ) as unknown as Record<string, unknown>;
    const { noBody, body, multipart, ...rest } = built;
    const form = multipart && file ? toFormData(multipart as MultipartField[], file) : undefined;
    return {
      ...rest,
      ...(form ? { body: form, rawBody: true } : noBody ? {} : { body }),
      provider: GOOGLE_PROVIDER_TAG,
      model: GOOGLE_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    } as HttpRequest;
  }

  async createCorpus(opts: CreateCorpusOptions): Promise<CorpusRef> {
    const res = await this.fetch(this.request('google/retrieval.createCorpus', opts));

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
    const uploadRes = await this.fetch(
      this.request('google/retrieval.uploadFile', {}, documentFile(source)),
    );

    if (uploadRes.status >= 400) {
      throw new Error(`hostedGoogle: file upload failed (${uploadRes.status}): ${JSON.stringify(uploadRes.body)}`);
    }

    const uploadBody = (uploadRes.body as Record<string, unknown>) ?? {};
    const fileObj = (uploadBody.file as Record<string, unknown>) ?? uploadBody;
    const fileName = fileObj.name as string;

    // Step 2: Import the uploaded file into the file search store.
    const importRes = await this.fetch(
      this.request('google/retrieval.importFile', {
        corpusId: corpus.id,
        fileName,
        metadata: opts?.metadata ?? source.metadata,
        text: source.text,
      }),
    );

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
      const res = await this.fetch(
        this.request('google/retrieval.pollOperation', { operationName }),
      );

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
    const res = await this.fetch(
      this.request('google/retrieval.indexStatus', { corpusId: corpus.id }),
    );

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
    await this.fetch(this.request('google/retrieval.removeDocument', { docId }));
    // Suppress errors — the file may have already expired (~48h provider TTL).
    void corpus;
  }

  async deleteCorpus(corpus: CorpusRef): Promise<void> {
    // force=true cascades deletion of all contained documents.
    const res = await this.fetch(
      this.request('google/retrieval.deleteCorpus', { corpusId: corpus.id }),
    );

    if (res.status >= 400) {
      throw new Error(`hostedGoogle: deleteCorpus failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
  }

  async listCorpora(): Promise<CorpusRef[]> {
    const allCorpora: CorpusRef[] = [];
    let pageToken: string | undefined;

    do {
      const res = await this.fetch(this.request('google/retrieval.listCorpora', { pageToken }));

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
