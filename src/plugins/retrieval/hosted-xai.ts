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

import type { EngineFetch } from '../../network/types';
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

/** Purpose field for xAI file uploads (same value as OpenAI assistants uploads). */
const XAI_FILE_PURPOSE = 'assistants';

/** Tool spec type field: xAI /responses is OpenAI-compatible for file_search. */
const FILE_SEARCH_TOOL_TYPE = 'file_search';

/** Default retrieval mode for POST /documents/search. */
const DEFAULT_RETRIEVAL_MODE = 'hybrid';

/** Valid search mode values accepted by the xAI search API. */
const XAI_SEARCH_MODES = ['hybrid', 'keyword', 'semantic'] as const;
type XaiSearchMode = (typeof XAI_SEARCH_MODES)[number];

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

/** Resolve the search mode: validate against known values, fall back to default. */
function resolveSearchMode(mode?: string): XaiSearchMode {
  if (mode && (XAI_SEARCH_MODES as readonly string[]).includes(mode)) {
    return mode as XaiSearchMode;
  }
  return DEFAULT_RETRIEVAL_MODE;
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

  private stdBearer(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
    };
  }

  private mgmtBearer(): Record<string, string> {
    return {
      authorization: `Bearer ${this.managementApiKey}`,
      'content-type': 'application/json',
    };
  }

  async createCorpus(opts: CreateCorpusOptions): Promise<CorpusRef> {
    const res = await this.fetch({
      url: `${this.managementBaseURL}/collections`,
      method: 'POST',
      headers: this.mgmtBearer(),
      body: { collection_name: opts.name },
      provider: XAI_PROVIDER_TAG,
      model: XAI_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });

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
    const blob = new Blob([source.text], { type: 'text/plain' });
    const filename = source.label ?? `doc-${crypto.randomUUID().slice(0, 8)}.txt`;
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('purpose', XAI_FILE_PURPOSE);

    const uploadRes = await this.fetch({
      url: `${this.baseURL}/files`,
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      rawBody: true,
      provider: XAI_PROVIDER_TAG,
      model: XAI_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });

    if (uploadRes.status >= 400) {
      throw new Error(`hostedXai: file upload failed (${uploadRes.status}): ${JSON.stringify(uploadRes.body)}`);
    }

    const file = uploadRes.body as Record<string, unknown>;
    const fileId = file.id as string;

    // Step 2: attach file to collection via POST {mgmt}/collections/{id}/documents/{file_id}.
    const attachBody: Record<string, unknown> = {};
    if (source.label) attachBody.name = source.label;
    const metadata = opts?.metadata ?? source.metadata;
    if (metadata) attachBody.fields = metadata;

    const attachRes = await this.fetch({
      url: `${this.managementBaseURL}/collections/${corpus.id}/documents/${fileId}`,
      method: 'POST',
      headers: this.mgmtBearer(),
      body: attachBody,
      provider: XAI_PROVIDER_TAG,
      model: XAI_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });

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
    const res = await this.fetch({
      url: `${this.managementBaseURL}/collections/${corpus.id}`,
      method: 'GET',
      headers: this.mgmtBearer(),
      body: undefined,
      provider: XAI_PROVIDER_TAG,
      model: XAI_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });

    if (res.status >= 400) {
      return { state: 'error' };
    }

    const data = res.body as Record<string, unknown>;
    // xAI gives no granular indexing status per document (no pending/failed counts).
    // Normalise: any documents present -> 'ready', empty collection -> 'pending'.
    const count = Number(data.documents_count);
    const total = Number.isFinite(count) ? count : 0;
    const state = total > 0 ? 'ready' : 'pending';
    const counts: IndexCounts = { total, indexed: total, failed: 0 };

    return { state, counts };
  }

  async removeDocument(corpus: CorpusRef, fileId: string): Promise<void> {
    await this.fetch({
      url: `${this.managementBaseURL}/collections/${corpus.id}/documents/${fileId}`,
      method: 'DELETE',
      headers: this.mgmtBearer(),
      body: undefined,
      provider: XAI_PROVIDER_TAG,
      model: XAI_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });
  }

  async deleteCorpus(corpus: CorpusRef): Promise<void> {
    const res = await this.fetch({
      url: `${this.managementBaseURL}/collections/${corpus.id}`,
      method: 'DELETE',
      headers: this.mgmtBearer(),
      body: undefined,
      provider: XAI_PROVIDER_TAG,
      model: XAI_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });

    if (res.status >= 400) {
      throw new Error(`hostedXai: deleteCorpus failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
  }

  async listCorpora(): Promise<CorpusRef[]> {
    const res = await this.fetch({
      url: `${this.managementBaseURL}/collections`,
      method: 'GET',
      headers: this.mgmtBearer(),
      body: undefined,
      provider: XAI_PROVIDER_TAG,
      model: XAI_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });

    if (res.status >= 400) return [];

    const items = (res.body as Array<Record<string, unknown>>) ?? [];
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
    const mode = resolveSearchMode(opts?.searchMode);

    const res = await this.fetch({
      url: `${this.baseURL}/documents/search`,
      method: 'POST',
      headers: this.stdBearer(),
      body: {
        query,
        source: { collection_ids: corpora.map((c) => c.id) },
        retrieval_mode: { type: mode },
      },
      provider: XAI_PROVIDER_TAG,
      model: XAI_RETRIEVAL_MODEL_TAG,
      responseType: 'json',
    });

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
