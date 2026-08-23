/** Hosted xAI (Grok Collections) retrieval backend.
 *
 *  Two API planes, two keys, two Bearer auths:
 *    Management API base  https://management-api.x.ai/v1  -- managementApiKey
 *    Standard API base    https://api.x.ai/v1             -- apiKey
 *
 *  Maps the unified RetrievalBackend interface:
 *    createCorpus   -> POST  {mgmt}/collections          body { collection_name }
 *    addDocument    -> POST  {std}/files (multipart)     then
 *                   -> POST  {mgmt}/collections/{id}/documents/{file_id}
 *    indexStatus    -> GET   {mgmt}/collections/{id}     (normalised from documents_count)
 *    removeDocument -> DELETE {mgmt}/collections/{id}/documents/{fileId}
 *    deleteCorpus   -> DELETE {mgmt}/collections/{id}
 *    listCorpora    -> GET   {mgmt}/collections
 *    search         -> POST  {std}/documents/search      (hybrid/keyword/semantic)
 *    asTool         -> ProviderToolSpec { type: 'file_search', vector_store_ids: [...] }
 *
 *  asTool reuses the OpenAI file_search spec shape because xAI /responses is OpenAI-compatible
 *  for file_search; a native collections_search shape is NOT accepted (verified 422).
 *
 *  ALL HTTP flows through the injected EngineFetch (NetworkEngine queue).
 *  Never globalThis.fetch. */

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
  IndexStatus,
  ProviderToolSpec,
  RetrievalBackend,
  RetrievalCapabilities,
  RetrievalHit,
  RetrievalSearchOptions,
} from './types';

// ─── Named constants ──────────────────────────────────────────────────────────

const XAI_STANDARD_BASE_URL = 'https://api.x.ai/v1';
const XAI_MANAGEMENT_BASE_URL = 'https://management-api.x.ai/v1';
const XAI_PROVIDER_TAG = 'xai';
const XAI_RETRIEVAL_MODEL_TAG = 'collections';
const HOSTED_BACKEND_NAME: 'hostedXai' = 'hostedXai';

/** Tool spec type field: xAI /responses is OpenAI-compatible for file_search. */
const FILE_SEARCH_TOOL_TYPE = 'file_search';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface HostedXaiRetrievalConfig {
  /** Standard API key (api.x.ai) — used for file uploads and search. */
  apiKey: string;
  /** Management API key (management-api.x.ai) — used for collection management. */
  managementApiKey: string;
  fetch: EngineFetch;
  /** Override for the standard API base URL. */
  baseURL?: string;
  /** Override for the management API base URL. */
  managementBaseURL?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse the chunk_content field from a search result.
 *  xAI returns a JSON-ish string: `[{"page_number":0,"text":"..."}]`.
 *  Extract the first entry's text. Fall back to the raw string if it isn't
 *  the expected shape. */
function parseChunkContent(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      typeof parsed[0] === 'object' &&
      parsed[0] !== null &&
      typeof (parsed[0] as Record<string, unknown>).text === 'string'
    ) {
      return (parsed[0] as Record<string, unknown>).text as string;
    }
  } catch {
    // Not JSON — fall through to raw string.
  }
  return raw;
}

/** Build a collections:// citation URI from result fields. */
function buildCitation(
  collectionIds: string[] | undefined,
  fields: Record<string, unknown> | undefined,
): string | undefined {
  const fileId = fields?.['chroma:uri'] ?? fields?.title;
  const collectionId = collectionIds?.[0];
  if (collectionId && fileId) {
    return `collections://${collectionId}/files/${fileId}`;
  }
  return undefined;
}

// ─── Backend ──────────────────────────────────────────────────────────────────

export class HostedXaiRetrievalBackend implements RetrievalBackend {
  readonly capabilities: RetrievalCapabilities = {
    userChunking: false,
    searchModes: ['hybrid', 'keyword', 'semantic'],
    expiration: false,
    directSearch: true,
    idField: 'id',
    citationFormat: 'collections-uri',
  };

  private readonly apiKey: string;
  private readonly managementApiKey: string;
  private readonly fetch: EngineFetch;
  private readonly baseURL: string;
  private readonly managementBaseURL: string;

  constructor(config: HostedXaiRetrievalConfig) {
    this.apiKey = config.apiKey;
    this.managementApiKey = config.managementApiKey;
    this.fetch = config.fetch;
    this.baseURL = config.baseURL ?? XAI_STANDARD_BASE_URL;
    this.managementBaseURL = config.managementBaseURL ?? XAI_MANAGEMENT_BASE_URL;
  }

  /** Collection rules need no adapter handles. */
  private readonly wireRegistry: Registry = makeRegistry({});

  /** Build one collections request from its spec, then add the engine metadata.
   *
   *  BOTH planes are handed to every spec: which host and which key a call uses is
   *  a property of the ENDPOINT, so the spec decides it rather than the caller
   *  picking a bearer helper and hoping it matches the URL it typed. */
  private request(specId: string, input: object, file?: MultipartFile): HttpRequest {
    const built = buildFromSpec(
      retrievalSpec(specId),
      input as never,
      this.wireRegistry,
      XAI_PROVIDER_TAG,
      undefined,
      {
        baseURL: this.baseURL,
        managementBaseURL: this.managementBaseURL,
        apiKey: this.apiKey,
        managementApiKey: this.managementApiKey,
      },
    ) as unknown as Record<string, unknown>;
    const { noBody, body, multipart, ...rest } = built;
    const form = multipart && file ? toFormData(multipart as MultipartField[], file) : undefined;
    return {
      ...rest,
      ...(form ? { body: form, rawBody: true } : noBody ? {} : { body }),
      provider: XAI_PROVIDER_TAG,
      model: XAI_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    } as HttpRequest;
  }

  async createCorpus(opts: CreateCorpusOptions): Promise<CorpusRef> {
    const res = await this.fetch(this.request('xai/retrieval.createCorpus', opts));

    if (res.status >= 400) {
      throw new Error(`hostedXai: createCorpus failed (${res.status}): ${JSON.stringify(res.body)}`);
    }

    const data = res.body as Record<string, unknown>;
    return {
      id: data.collection_id as string,
      name: (data.collection_name as string) ?? opts.name,
      backend: HOSTED_BACKEND_NAME,
    };
  }

  async addDocument(
    corpus: CorpusRef,
    source: DocumentSource,
    opts?: AddDocumentOptions,
  ): Promise<DocumentRef> {
    // Step 1: upload file via POST {std}/files (multipart, standard bearer).
    const uploadRes = await this.fetch(
      this.request('xai/retrieval.uploadFile', {}, documentFile(source)),
    );

    if (uploadRes.status >= 400) {
      throw new Error(`hostedXai: file upload failed (${uploadRes.status}): ${JSON.stringify(uploadRes.body)}`);
    }

    const file = uploadRes.body as Record<string, unknown>;
    const fileId = file.id as string;

    // Step 2: attach file to collection via POST {mgmt}/collections/{id}/documents/{file_id}.
    const attachRes = await this.fetch(
      this.request('xai/retrieval.attachDocument', {
        corpusId: corpus.id,
        fileId,
        label: source.label,
        metadata: opts?.metadata ?? source.metadata,
      }),
    );

    if (attachRes.status >= 400) {
      throw new Error(`hostedXai: attach document failed (${attachRes.status}): ${JSON.stringify(attachRes.body)}`);
    }

    return {
      id: fileId,
      corpusId: corpus.id,
      source: { text: source.text, label: source.label, metadata: source.metadata },
    };
  }

  async indexStatus(corpus: CorpusRef): Promise<IndexStatus> {
    // Read the DOCUMENTS, not the collection. `documents_count` goes to 1 the
    // moment a document is attached, several seconds before that document can be
    // searched — measured at ~5s — so reporting `ready` from it meant a caller
    // that dutifully polled still searched an empty index and got nothing back,
    // with no error to explain it. Each document carries its own status.
    const res = await this.fetch(
      this.request('xai/retrieval.listDocuments', { corpusId: corpus.id }),
    );

    if (res.status >= 400) {
      return { state: 'error' };
    }

    const docs =
      ((res.body as { documents?: Array<Record<string, unknown>> } | undefined)?.documents) ?? [];
    const total = docs.length;
    if (total === 0) return { state: 'pending', counts: { total: 0, indexed: 0, failed: 0 } };

    const statusOf = (d: Record<string, unknown>) => String(d.status ?? '');
    const indexed = docs.filter((d) => statusOf(d).endsWith('PROCESSED')).length;
    const failed = docs.filter((d) => /FAILED|ERROR/.test(statusOf(d))).length;
    const counts: IndexCounts = { total, indexed, failed };

    // A partial failure is still an error: the caller asked for these documents,
    // and searching without them silently answers from less than it was given.
    if (failed > 0) return { state: 'error', counts };
    return { state: indexed === total ? 'ready' : 'indexing', counts };
  }

  async removeDocument(corpus: CorpusRef, fileId: string): Promise<void> {
    await this.fetch(
      this.request('xai/retrieval.removeDocument', { corpusId: corpus.id, docId: fileId }),
    );
  }

  async deleteCorpus(corpus: CorpusRef): Promise<void> {
    const res = await this.fetch(
      this.request('xai/retrieval.deleteCorpus', { corpusId: corpus.id }),
    );

    if (res.status >= 400) {
      throw new Error(`hostedXai: deleteCorpus failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
  }

  async listCorpora(): Promise<CorpusRef[]> {
    const res = await this.fetch(this.request('xai/retrieval.listCorpora', {}));

    if (res.status >= 400) return [];

    // `{ collections: [...] }`, not a bare array — reading it as one threw a
    // TypeError on every real response, which no test caught because the fake
    // ones were arrays.
    const body = res.body as { collections?: Array<Record<string, unknown>> } | undefined;
    const items = body?.collections ?? [];
    return items.map((item) => ({
      id: item.collection_id as string,
      name: (item.collection_name as string) ?? '',
      backend: HOSTED_BACKEND_NAME,
    }));
  }

  async search(
    corpora: CorpusRef[],
    query: string,
    opts?: RetrievalSearchOptions,
  ): Promise<RetrievalHit[]> {
    const res = await this.fetch(
      this.request('xai/retrieval.search', {
        query,
        corpusIds: corpora.map((c) => c.id),
        searchMode: opts?.searchMode,
      }),
    );

    if (res.status >= 400) {
      throw new Error(`hostedXai: search failed (${res.status}): ${JSON.stringify(res.body)}`);
    }

    const data = res.body as Record<string, unknown>;
    // Live xAI returns hits under `matches` (the API docs say `results`); accept both.
    const results =
      (data.matches as Array<Record<string, unknown>>) ??
      (data.results as Array<Record<string, unknown>>) ??
      [];

    return results.map((r) => {
      const fields = r.fields as Record<string, unknown> | undefined;
      const collectionIds = r.collection_ids as string[] | undefined;
      return {
        text: parseChunkContent(String(r.chunk_content ?? '')),
        score: typeof r.score === 'number' ? r.score : 0,
        docId: String(r.file_id ?? r.chunk_id ?? ''),
        metadata: fields,
        citation: buildCitation(collectionIds, fields),
      };
    });
  }

  /** Returns a `file_search` ProviderToolSpec for splicing into a Responses call.
   *  xAI Responses is OpenAI-compatible for file_search; native collections_search
   *  is NOT accepted (verified 422). */
  asTool(corpora: CorpusRef[], opts?: AsToolOptions): ProviderToolSpec {
    const spec: ProviderToolSpec = {
      type: FILE_SEARCH_TOOL_TYPE,
      vector_store_ids: corpora.map((c) => c.id),
    };
    if (opts?.maxResults !== undefined) spec.max_num_results = opts.maxResults;
    return spec;
  }
}
