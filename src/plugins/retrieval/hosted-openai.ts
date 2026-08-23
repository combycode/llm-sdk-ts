/** Hosted OpenAI Vector Stores backend.
 *
 *  Maps the unified RetrievalBackend interface to the OpenAI Vector Stores API:
 *    createCorpus  -> POST /v1/vector_stores
 *    addDocument   -> POST /v1/files  then  POST /v1/vector_stores/{id}/files
 *    indexStatus   -> GET  /v1/vector_stores/{id}  (normalized)
 *    removeDocument-> DELETE /v1/vector_stores/{id}/files/{file_id}
 *    deleteCorpus  -> DELETE /v1/vector_stores/{id}
 *    listCorpora   -> GET  /v1/vector_stores
 *    asTool        -> returns ProviderToolSpec (splice into a Responses call)
 *    search        -> not supported server-side; use asTool
 *
 *  ALL HTTP flows through the injected EngineFetch (NetworkEngine queue).
 *  Never globalThis.fetch.
 *
 *  Note: xAI will reuse the `asTool` emitter shape (same file_search spec) —
 *  the divergence point for xAI will be the base URL and any auth differences.
 *  // future: hostedXai — subclass or factory: pass baseURL, different auth header. */

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

const OPENAI_BASE_URL = 'https://api.openai.com';
const OPENAI_PROVIDER_TAG = 'openai';
const OPENAI_MODEL_TAG = 'vector_stores';
const HOSTED_BACKEND_NAME: 'hostedOpenAI' = 'hostedOpenAI';

/** Tool spec type field for OpenAI (and xAI-compat) Responses API. */
const FILE_SEARCH_TOOL_TYPE = 'file_search';

// ─── OpenAI status → IndexState normalisation ─────────────────────────────────

const OPENAI_STATUS_MAP: Record<string, IndexState> = {
  in_progress: 'indexing',
  completed: 'ready',
  expired: 'error',
  failed: 'error',
};

function normaliseStatus(raw: string): IndexState {
  return OPENAI_STATUS_MAP[raw] ?? 'pending';
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface HostedOpenAIRetrievalConfig {
  apiKey: string;
  fetch: EngineFetch;
  baseURL?: string;
}

// ─── Backend ──────────────────────────────────────────────────────────────────

export class HostedOpenAIRetrievalBackend implements RetrievalBackend {
  readonly capabilities: RetrievalCapabilities = {
    userChunking: true,
    searchModes: ['hybrid'],
    expiration: true,
    directSearch: false,
    idField: 'id',
    citationFormat: 'file_id',
  };

  private readonly apiKey: string;
  private readonly fetch: EngineFetch;
  private readonly baseURL: string;

  constructor(config: HostedOpenAIRetrievalConfig) {
    this.apiKey = config.apiKey;
    this.fetch = config.fetch;
    this.baseURL = config.baseURL ?? OPENAI_BASE_URL;
  }

  /** Vector-store rules need no adapter handles. */
  private readonly wireRegistry: Registry = makeRegistry({});

  /** Build one vector-store request from its spec, then add the engine metadata.
   *
   *  `provider` / `model` / `responseType` are how the NetworkEngine routes and
   *  queues the call — they are not part of the wire, so they are wrapped around
   *  the spec's output rather than described by it. A multipart spec names the
   *  fields but not the bytes, so an upload passes its file in here. */
  private request(specId: string, input: object, file?: MultipartFile): HttpRequest {
    const built = buildFromSpec(
      retrievalSpec(specId),
      input as never,
      this.wireRegistry,
      OPENAI_PROVIDER_TAG,
      undefined,
      { baseURL: this.baseURL, apiKey: this.apiKey },
    ) as unknown as Record<string, unknown>;
    const { noBody, body, multipart, ...rest } = built;
    const form = multipart && file ? toFormData(multipart as MultipartField[], file) : undefined;
    return {
      ...rest,
      ...(form ? { body: form, rawBody: true } : noBody ? {} : { body }),
      provider: OPENAI_PROVIDER_TAG,
      model: OPENAI_MODEL_TAG,
      responseType: 'json',
    } as HttpRequest;
  }

  async createCorpus(opts: CreateCorpusOptions): Promise<CorpusRef> {
    const res = await this.fetch(this.request('openai/retrieval.createCorpus', opts));

    if (res.status >= 400) {
      throw new Error(`hostedOpenAI: createCorpus failed (${res.status}): ${JSON.stringify(res.body)}`);
    }

    const data = res.body as Record<string, unknown>;
    return {
      id: data.id as string,
      name: data.name as string,
      backend: HOSTED_BACKEND_NAME,
    };
  }

  async addDocument(
    corpus: CorpusRef,
    source: DocumentSource,
    opts?: AddDocumentOptions,
  ): Promise<DocumentRef> {
    // Step 1: upload file via POST /v1/files
    const uploadRes = await this.fetch(
      this.request('openai/retrieval.uploadFile', {}, documentFile(source)),
    );

    if (uploadRes.status >= 400) {
      throw new Error(`hostedOpenAI: file upload failed (${uploadRes.status}): ${JSON.stringify(uploadRes.body)}`);
    }

    const file = uploadRes.body as Record<string, unknown>;
    const fileId = file.id as string;

    // Step 2: attach file to vector store via POST /v1/vector_stores/{id}/files
    const attachRes = await this.fetch(
      this.request('openai/retrieval.attachDocument', {
        corpusId: corpus.id,
        fileId,
        metadata: opts?.metadata,
      }),
    );

    if (attachRes.status >= 400) {
      throw new Error(`hostedOpenAI: attach file failed (${attachRes.status}): ${JSON.stringify(attachRes.body)}`);
    }

    return {
      id: fileId,
      corpusId: corpus.id,
      source: { text: source.text, label: source.label, metadata: source.metadata },
      extra: { file_id: fileId },
    };
  }

  async indexStatus(corpus: CorpusRef): Promise<IndexStatus> {
    const res = await this.fetch(
      this.request('openai/retrieval.indexStatus', { corpusId: corpus.id }),
    );

    if (res.status >= 400) {
      return { state: 'error' };
    }

    const data = res.body as Record<string, unknown>;
    const state = normaliseStatus(data.status as string);
    const fc = data.file_counts as Record<string, number> | undefined;
    const counts: IndexCounts | undefined = fc
      ? {
          total: fc.total ?? 0,
          indexed: fc.completed ?? 0,
          failed: fc.failed ?? 0,
        }
      : undefined;

    return { state, counts };
  }

  async removeDocument(corpus: CorpusRef, docId: string): Promise<void> {
    await this.fetch(
      this.request('openai/retrieval.removeDocument', { corpusId: corpus.id, docId }),
    );
  }

  async deleteCorpus(corpus: CorpusRef): Promise<void> {
    await this.fetch(this.request('openai/retrieval.deleteCorpus', { corpusId: corpus.id }));
  }

  async listCorpora(): Promise<CorpusRef[]> {
    const res = await this.fetch(this.request('openai/retrieval.listCorpora', {}));

    if (res.status >= 400) return [];

    const data = res.body as Record<string, unknown>;
    const items = (data.data as Array<Record<string, unknown>>) ?? [];
    return items.map((item) => ({
      id: item.id as string,
      name: (item.name as string) ?? '',
      backend: HOSTED_BACKEND_NAME,
    }));
  }

  /** Returns a `file_search` ProviderToolSpec for splicing into a Responses call.
   *  // future: hostedXai will reuse this same tool spec shape. */
  asTool(corpora: CorpusRef[], opts?: AsToolOptions): ProviderToolSpec {
    const spec: ProviderToolSpec = {
      type: FILE_SEARCH_TOOL_TYPE,
      vector_store_ids: corpora.map((c) => c.id),
    };
    if (opts?.maxResults !== undefined) spec.max_num_results = opts.maxResults;
    if (opts?.filters !== undefined) spec.filters = opts.filters;
    return spec;
  }

  /** Direct search is not supported for server-side vector stores.
   *  Use `asTool()` and splice the spec into a Responses API call instead. */
  async search(_corpora: CorpusRef[], _query: string, _opts?: RetrievalSearchOptions): Promise<RetrievalHit[]> {
    throw new Error(
      'hostedOpenAI: direct search() is not supported. Use asTool() and splice the ' +
      'returned ProviderToolSpec into a Responses API call (file_search is server-side).',
    );
  }
}

