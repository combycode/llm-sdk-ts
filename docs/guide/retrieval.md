---
title: Retrieval (RAG)
description: Build Retrieval-Augmented Generation pipelines with a unified five-stage API across four backends.
---

# Retrieval (RAG)

## What you will achieve

By the end of this guide you will have a working RAG pipeline that can ingest text documents, embed or upload them, search by natural language, and surface results to an agent as a tool call. Because all four backends implement the same `RetrievalBackend` interface you can start with the local backend (zero network cost, any provider) and switch to a hosted backend with one line.

## When and why you need this

Reach for the retrieval plugin when:

- An agent needs to answer questions from a private knowledge base (support docs, internal wikis, product catalogs).
- You want to use Anthropic, Mistral, or another provider that does not offer its own hosted vector store -- the local backend runs entirely client-side and works with any provider.
- You are prototyping and want zero cost or zero server setup, then graduate to a hosted backend for scale.
- You want a single abstraction so swapping from OpenAI Vector Stores to Google Gemini File Search does not require rewriting agent code.

## Step by step

### Step 1 -- build a backend

Choose a factory based on where you want vectors to live:

```ts
import { createEngine, localRetrieval, OpenAIEmbeddingAdapter } from '@combycode/llm-sdk';

const engine = createEngine({
  apiKeys: {
    openai: process.env.OPENAI_API_KEY!,
    anthropic: process.env.ANTHROPIC_API_KEY!,
  },
});

// Local: embeddings computed client-side; works with ANY provider.
const retrieval = localRetrieval({
  embedAdapter: new OpenAIEmbeddingAdapter({ apiKey: process.env.OPENAI_API_KEY! }),
  fetch: engine.fetch,           // all HTTP through the NetworkEngine queue
  embeddingModel: 'text-embedding-3-small',
});
```

`engine.fetch` is required so every HTTP call goes through the NetworkEngine queue (retry, rate-limit, telemetry). Never pass raw `globalThis.fetch`.

### Step 2 -- create a corpus

A corpus is the container that holds one or more documents.

```ts
// Stage 1: create a named corpus.
const corpus = await retrieval.createCorpus({ name: 'product-docs' });
// corpus: { id: '<uuid>', name: 'product-docs', backend: 'local' }
```

For hosted backends you can also set a chunking strategy and an expiry at creation time (see "Your options" below).

### Step 3 -- add documents

Each `addDocument` call accepts a `DocumentSource` -- the plain text plus optional label and metadata. The label becomes part of the citation string.

```ts
// Stage 2: add documents (as many as you need).
await retrieval.addDocument(corpus, {
  text: 'Our refund policy allows returns within 30 days of purchase.',
  label: 'refund-policy.txt',
});
await retrieval.addDocument(corpus, {
  text: 'Shipping takes 3-5 business days within the US.',
  label: 'shipping.txt',
  metadata: { category: 'logistics' },
});
```

For the local backend each document is chunked and embedded immediately (synchronous relative to the await). For hosted backends the call uploads the file and returns a `DocumentRef` whose `id` is the provider's file ID.

### Step 4 -- check index status

For hosted backends indexing is asynchronous. Poll `indexStatus` until `state === 'ready'`.

```ts
// Stage 3: check status. Local is always 'ready'.
let status = await retrieval.indexStatus(corpus);
console.log(status.state); // 'ready' | 'indexing' | 'pending' | 'error'

// For hosted backends, poll:
while (status.state === 'indexing' || status.state === 'pending') {
  await new Promise((r) => setTimeout(r, 1_000));
  status = await retrieval.indexStatus(corpus);
}
if (status.state === 'error') throw new Error('Indexing failed');
```

`IndexStatus` also carries `counts?: { total, indexed, failed }` when the backend reports them.

### Step 5a -- give the corpus to an agent as a tool

`asTool()` is the primary path for agent integration. Its return type differs by backend: local returns an `AgentTool` (runs client-side); hosted backends return a `ProviderToolSpec` (splice into the provider's native call).

```ts
import { createAgent } from '@combycode/llm-sdk';

// Stage 4a: build and hand the tool to an agent.
const searchTool = retrieval.asTool([corpus], { maxResults: 3 });

// searchTool has an `execute` property -> it's an AgentTool, works with any provider.
const agent = createAgent({
  model: 'anthropic/claude-haiku-4.5',
  engine,
  tools: [searchTool],
});

const response = await agent.complete('What is the return window for purchases?');
console.log(response.text);
```

To distinguish an `AgentTool` from a `ProviderToolSpec` at runtime check `'execute' in searchTool`.

### Step 5b -- search directly without an agent

When you only need the ranked hits (pipeline scripts, pre-processing, custom UI):

```ts
// Stage 4b: direct search.
const hits = await retrieval.search([corpus], 'return item', { maxResults: 2 });
for (const hit of hits) {
  console.log(`[${hit.citation}] score=${hit.score.toFixed(3)}`);
  console.log(hit.text);
}
```

Direct search (`directSearch: true`) is supported by the local backend and by the xAI backend. It is NOT supported by the OpenAI or Google hosted backends -- calling `search()` on those will throw with a clear error.

### Step 6 -- cleanup

```ts
// Stage 5: remove one document or the entire corpus.
await retrieval.removeDocument(corpus, docRef.id);   // remove one
await retrieval.deleteCorpus(corpus);                  // remove all
```

For the local backend `deleteCorpus` also removes all entries from the in-memory vector store. For hosted backends it calls the provider's DELETE endpoint.

## Your options

### Backend selection

All four backends implement `RetrievalBackend`. Use `capabilities` to branch without hard-coding provider names.

| Factory | Backend name | `directSearch` | `userChunking` | Search modes | Citation format | Notes |
|---|---|---|---|---|---|---|
| `localRetrieval(config)` | `'local'` | true | true | cosine | `label:offset` | Zero-dep, cross-env, any provider |
| `openaiRetrieval(config)` | `'hostedOpenAI'` | false | true | hybrid | `file_id` | Server-side; `asTool` -> Responses API |
| `googleRetrieval(config)` | `'hostedGoogle'` | false | true | semantic | `gemini` | `asTool` -> `generateContent`; raw files expire ~48h |
| `xaiRetrieval(config)` | `'hostedXai'` | true | false | hybrid, keyword, semantic | `collections-uri` | Two API keys required |

Use `createRetrieval(backendName, config)` when the backend is chosen at runtime from a config value.

### `localRetrieval` config options

```ts
interface LocalRetrievalConfig {
  embedAdapter: EmbeddingProviderAdapter;  // required: embedding provider
  fetch: EngineFetch;                      // required: engine.fetch
  embeddingModel: string;                  // required: e.g. 'text-embedding-3-small'
  vectorStore?: VectorStore;               // default: InMemoryVectorStore
  persistence?: Persistence;              // for InMemoryVectorStore; survive restarts
  defaultMaxTokens?: number;              // default: 512 tokens per chunk
  defaultOverlapTokens?: number;          // default: 64 tokens overlap
}
```

When you pass `persistence`, the default `InMemoryVectorStore` serializes to disk via `FilePersistence` and reloads on the next startup -- vectors survive process restarts at the cost of one disk write per upsert.

Bring your own vector store by implementing `VectorStore`:

```ts
import { VectorStore, VectorEntry } from '@combycode/llm-sdk';

class MyPgVectorStore implements VectorStore {
  async upsert(entry: VectorEntry): Promise<void> { /* insert */ }
  async removeByDocId(corpusId: string, docId: string): Promise<void> { /* delete */ }
  async removeByCorpusId(corpusId: string): Promise<void> { /* delete */ }
  async query(corpusId: string, vector: number[], topK: number) { /* search */ }
  async count(corpusId?: string): Promise<number> { /* count */ }
}

const retrieval = localRetrieval({
  vectorStore: new MyPgVectorStore(),
  // ...
});
```

### `openaiRetrieval` config options

```ts
interface HostedOpenAIRetrievalConfig {
  apiKey: string;
  fetch: EngineFetch;
  baseURL?: string;  // default: https://api.openai.com
}
```

Chunking is specified per-corpus in `createCorpus({ chunking: { maxTokens, overlapTokens } })`. Defaults sent to the API: `max_chunk_size_tokens=800`, `chunk_overlap_tokens=400`.

Corpus expiry:

```ts
const corpus = await retrieval.createCorpus({
  name: 'session-docs',
  expiresAfter: { anchor: 'last_active_at', days: 7 },
});
```

`asTool()` supports `maxResults` and `filters` (metadata filters passed as `filters` in the spec).

### `googleRetrieval` config options

```ts
interface HostedGoogleRetrievalConfig {
  apiKey: string;
  fetch: EngineFetch;
  baseURL?: string;  // default: https://generativelanguage.googleapis.com
}
```

Auth uses the `x-goog-api-key` request header (not a query parameter) to avoid key exposure in server logs.

Key divergences from OpenAI:
- `createCorpus` accepts `embeddingModel` (default: `'models/gemini-embedding-2'`).
- `addDocument` returns a `DocumentRef` whose `id` is the long-running operation name. Call `retrieval.pollOperation(docRef.id)` to wait for it.
- Raw uploaded Files API files expire approximately 48 hours after upload. The `fileSearchStore` corpus itself persists until `deleteCorpus` is called.
- `asTool()` emits a Gemini-native shape: `{ fileSearch: { fileSearchStoreNames: [...], metadataFilter? } }` -- NOT the OpenAI `file_search` + `vector_store_ids` shape.
- Corpus expiration (`expiresAfter`) is not supported -- `capabilities.expiration === false`.

### `xaiRetrieval` config options

```ts
interface HostedXaiRetrievalConfig {
  apiKey: string;            // standard API key (api.x.ai) -- file uploads + search
  managementApiKey: string;  // management API key (management-api.x.ai) -- collection CRUD
  fetch: EngineFetch;
  baseURL?: string;          // default: https://api.x.ai/v1
  managementBaseURL?: string; // default: https://management-api.x.ai/v1
}
```

xAI is the only hosted backend with `directSearch: true`. Modes: `'hybrid'` (default), `'keyword'`, `'semantic'`.

```ts
const hits = await retrieval.search([corpus], 'query text', {
  maxResults: 5,
  searchMode: 'semantic',
});
```

`asTool()` emits the OpenAI `file_search` + `vector_store_ids` spec shape (xAI Responses is OpenAI-compatible for file_search; the native `collections_search` shape returns 422).

`userChunking` is `false` -- chunking is handled by xAI automatically.

### `createCorpus` options

```ts
interface CreateCorpusOptions {
  name: string;
  chunking?: {
    maxTokens?: number;       // max chunk size in tokens
    overlapTokens?: number;   // overlap between chunks
  };
  expiresAfter?: {
    anchor: 'last_active_at';
    days: number;
  };
  embeddingModel?: string;    // hosted backends that allow selection
}
```

### `addDocument` options

```ts
interface DocumentSource {
  text: string;
  label?: string;                        // used for citations and filename
  metadata?: Record<string, unknown>;    // passed through to hits and provider
}

interface AddDocumentOptions {
  metadata?: Record<string, unknown>;    // merged with source.metadata
}
```

### `asTool` and `search` options

```ts
interface AsToolOptions {
  maxResults?: number;              // default: 5
  searchMode?: string;              // backend-specific; xAI: 'hybrid' | 'keyword' | 'semantic'
  filters?: Record<string, unknown>; // metadata filters (provider-specific shape)
}

interface RetrievalSearchOptions {
  maxResults?: number;   // default: 5
  minScore?: number;     // minimum cosine score to include (0-1, default: 0)
  searchMode?: string;
  filters?: Record<string, unknown>;
}
```

### `RetrievalHit` fields

```ts
interface RetrievalHit {
  text: string;                         // matched text chunk
  score: number;                        // 0-1 cosine similarity or relevance score
  docId: string;                        // document ref id within the corpus
  metadata?: Record<string, unknown>;   // caller metadata attached at addDocument
  citation?: string;                    // format varies: 'label:offset', file_id, etc.
}
```

### Chunking defaults

The local backend's built-in chunker splits on whitespace boundaries. Named constants:

| Constant | Value | Meaning |
|---|---|---|
| `DEFAULT_CHUNK_MAX_TOKENS` | 512 | Max tokens per chunk (local default) |
| `DEFAULT_CHUNK_OVERLAP_TOKENS` | 64 | Overlap tokens (local default) |

You can call `chunkText(text, opts, estimateTokensFn)` directly to pre-inspect how a document will be split, or inject a more accurate token counter.

## Gotchas and next steps

**Local indexing is in-process and ephemeral by default.** If the process restarts, all vectors are gone. Pass `persistence: new FilePersistence('./vectors')` to the `localRetrieval` config to survive restarts.

**Hosted indexing is asynchronous.** Always poll `indexStatus` before calling `asTool()` or `search()`. Skipping the poll and calling `asTool()` immediately after `addDocument()` will work for tool invocations but the LLM may get no results if indexing has not finished.

**`asTool()` returns different types for local vs hosted backends.** Local returns an object with an `execute` function (`AgentTool`). Hosted returns a plain spec object (`ProviderToolSpec`). When the backend is chosen at runtime, check `'execute' in result` before deciding whether to pass it to `createAgent` or splice it into a native provider call.

**xAI requires two API keys.** A common mistake is passing the same key for both `apiKey` and `managementApiKey`. The standard key goes to `api.x.ai`; the management key goes to `management-api.x.ai`. Collection create/delete will 401 if you use the standard key for management calls.

**Google `addDocument` returns a long-running operation, not a ready document.** The `DocumentRef.id` is the operation name. Use `await retrieval.pollOperation(docRef.id)` to confirm the import completed before expecting the document in `indexStatus`.

**Do not depend on exporting embeddings from a hosted store.** `DocumentRef` and `CorpusRef` carry the original `source` metadata precisely so you can rebuild a corpus from source text if a provider deletes it or if you switch backends.

**Related guides:**

- `/docs/guides/tools` -- `AgentTool` interface and `defineTool`
- `/docs/guides/agent-loop` -- passing `AgentTool` to `createAgent`
- `/docs/guides/tokens-embeddings` -- `embed()` helper and embedding adapters
- `/docs/examples/23-embeddings/` -- embedding adapter usage
- `/docs/examples/27-web-search/` -- combining search results with agent completions
