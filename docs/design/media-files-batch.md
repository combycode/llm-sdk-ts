---
title: Media, Files & Batch
---

# Media, Files & Batch

Source: `src/plugins/media/`, `src/plugins/files/`, `src/plugins/batch/`.

## Purpose and responsibilities

Three distinct but architecturally parallel subsystems for non-chat I/O:

- **Media** generates images, audio, and video through provider-specific generation APIs.
  Stores raw bytes + metadata in a `MediaStore`. Emits `onMediaGenerated` so `CostCollector`
  can price the result.
- **Files** manages file attachments shared across providers. Intercepts `onMessageResolve`
  to rewrite `{ type: 'file', fileId }` content parts into provider-friendly forms (inline
  base64, URL, or `provider_ref`) before every LLM call.
- **Batch** transparently routes requests from `batchable`-marked clients into provider
  batch APIs (OpenAI Batch, Anthropic Message Batches). Delivers results back to the original
  callers via resolved Promises (in-process) or `onBatchResult` hook events (after restart).

None of the three subsystems holds a private HTTP client. Every adapter receives an
`EngineFetch` per call so all HTTP flows through the `NetworkEngine` queue (rate limits,
retry, telemetry).

---

## Media generation

### Key types (`src/plugins/media/types.ts`)

```ts
type MediaType = 'image' | 'audio' | 'video';

interface MediaMeta {
  id: string; type: MediaType; mimeType: string; size: number; createdAt: number;
  provider: string; model?: string; prompt?: string; revisedPrompt?: string;
  width?: number; height?: number; durationMs?: number; sampleRate?: number;
  params?: Record<string, unknown>;
}

interface MediaStore {
  save(id: string, data: Uint8Array, meta: MediaMeta): Promise<void>;
  load(id: string): Promise<{ data: Uint8Array; meta: MediaMeta } | null>;
  getMeta(id: string): Promise<MediaMeta | null>;
  delete(id: string): Promise<void>;
  list(filter?: { type?: MediaType; provider?: string }): Promise<string[]>;
  has(id: string): Promise<boolean>;
}

interface RawMediaResult {
  data: Uint8Array; mimeType: string;
  width?: number; height?: number; durationMs?: number; sampleRate?: number;
  revisedPrompt?: string;
  /** Token usage for token-priced models (gpt-image, gemini-tts). */
  usage?: Usage;
  providerMeta?: Record<string, unknown>;
}

interface VideoStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number; error?: string;
}

const MEDIA_OUTPUT_DEFAULTS: Required<MediaOutputConfig> = {
  pollIntervalMs: 5_000,
  maxPollWaitMs: 600_000,
};
```

`RawMediaResult.usage` carries provider-reported token counts. `CostCollector` uses this
to apply per-token rates for token-priced media models instead of flat per-unit rates.

### `MediaProviderAdapter` (`src/plugins/media/types.ts`)

The per-provider plug-in contract. Every method receives an `EngineFetch` injected by
`MediaOutput` at call time — adapters do NOT hold a private fetch function.

```ts
interface MediaProviderAdapter {
  readonly name: string;
  capabilities(): MediaCapabilities;
  generateImage(req: ImageGenRequest, fetch: EngineFetch): Promise<RawMediaResult[]>;
  editImage?(req: ImageEditRequest, fetch: EngineFetch): Promise<RawMediaResult[]>;
  generateAudio(req: AudioGenRequest, fetch: EngineFetch): Promise<RawMediaResult>;
  submitVideo?(req: VideoGenRequest, fetch: EngineFetch): Promise<string>;  // operationId
  getVideoStatus?(operationId: string, fetch: EngineFetch): Promise<VideoStatus>;
  downloadVideo?(operationId: string, fetch: EngineFetch): Promise<RawMediaResult>;
  cancelVideo?(operationId: string, fetch: EngineFetch): Promise<void>;
}
```

Adapters must use `responseType: 'arraybuffer'` for binary downloads (audio, video files)
and `responseType: 'json'` for status polling. Mismatching the `responseType` causes silent
data corruption — the engine passes raw bytes through and the caller decides how to interpret
them.

### `MediaOutput` (`src/plugins/media/output.ts`)

The top-level orchestrator. Constructed with `MediaOutputInit`:

```ts
interface MediaOutputInit {
  hooks: HookBus; mediaStore: MediaStore; fetch: EngineFetch;
  providers?: Map<string, MediaProviderAdapter>;
  catalog?: ModelCatalog; config?: MediaOutputConfig; sessionId?: string;
}
```

Public methods: `generateImage`, `editImage`, `generateAudio`, `generateVideo`.

Each call mints a `TraceContext` via `tracedOp()` (private method,
`src/plugins/media/output.ts`):

```ts
private tracedOp() {
  const trace = { sessionId: this.sessionId, requestId: `req_${crypto.randomUUID().slice(0, 12)}` };
  const fetch: EngineFetch = (req, options) => this.fetch({ ...req, trace }, options);
  return { trace, fetch };
}
```

This stamps every adapter HTTP request with the same `requestId`, correlating all network
events for a single media generation in telemetry.

### Data & control flow

**Image and audio** (single-round-trip):

1. `generateImage(req)` / `generateAudio(req)` calls `getAdapter(req.provider)` and checks
   `capabilities()`.
2. Calls `tracedOp()` to mint a trace + traced fetch.
3. Calls `adapter.generateImage(req, fetch)` (or `generateAudio`) — one HTTP round-trip.
4. Calls private `saveResults(rawResults, ...)`:
   - Assigns each result a UUID-based id prefixed `img_`, `aud_`, or `vid_`.
   - Builds a `MediaMeta` record and calls `mediaStore.save(id, raw.data, meta)`.
   - Calls `aggregateUsage(rawResults)` to sum token counts across the batch (returns
     `undefined` when no result reported usage — unit-priced models).
   - Emits `onMediaGenerated` with `{ provider, model, mediaType, count, usage?, ... }`.

**Video** (async polling):

1. `generateVideo(req)` calls `adapter.submitVideo(req, fetch)` to get an `operationId`.
2. Enters `pollVideoCompletion(adapter, operationId, req, fetch, trace)` (private method).
3. Polls `adapter.getVideoStatus(operationId, fetch)` every `pollIntervalMs` (default 5 s)
   within a `while (Date.now() - start < maxPollWaitMs)` loop.
4. On `status === 'completed'`: calls `adapter.downloadVideo(operationId, fetch)` then
   routes through `saveResults()` same as image/audio.
5. On `status === 'failed'`: emits `onMediaError` and throws.
6. On timeout: throws with `Video generation timed out after ${maxPollWaitMs}ms`.

All polling calls use the same traced `EngineFetch` as the submit call. The trace
`requestId` is shared across the entire job lifecycle.

### Source image normalization (`src/plugins/media/source-image.ts`)

`normalizeImageSource(src: DataSource): NormalizedImageRef` collapses any `DataSource`
variant (base64, buffer, url, file, provider\_ref, path) to `{ base64?, mimeType?, url?,
fileId? }`. The `path` variant throws immediately — callers must pre-read files.

A magic-byte sniff via `sniffImageMime` (`src/util/image-mime.ts`) cross-checks the
declared MIME against the actual bytes and corrects mismatches. This prevents downstream
validation failures from providers that strictly check MIME types (Google Veo, OpenAI
image edits).

Per-provider adapter helpers: `openaiImageRef`, `xaiImageRef`, `googleImagePart`,
`googleVeoImage` — each maps a `NormalizedImageRef` to the wire shape the provider expects.

### Built-in stores

- `MemoryMediaStore` (`src/plugins/media/memory-store.ts`): `Map<id, { data, meta }>`.
  Data is lost on process exit. Default for tests.
- `FileMediaStore` (`src/plugins/media/file-store.ts`): writes `{id}{ext}` + `{id}.meta.json`
  files to a configured `dir`. Extension is derived from `mimeType` via the `MIME_TO_EXT`
  map (`src/plugins/media/file-store.ts`). Uses `nodeFsPromises()` — browser-guarded.
  `ensureDir()` is called at construction and awaited on every operation via the `ready`
  Promise.

---

## Files

### Purpose and boundaries

Resolves `FileAttachment` objects (tracked in the `FilesRegistry`) to provider-native
content at message-build time. Does NOT manage inline media generated during LLM calls
(those are handled by core LLM adapters + `onCompletion`). Does NOT fetch remote URLs
(URL-type files are passed through as-is when the provider supports them).

### `FileAttachment` (`src/plugins/files/attachment.ts`)

Immutable identity + mutable upload state:

```ts
type FileContent =
  | { type: 'buffer'; mimeType: string; data: Uint8Array }
  | { type: 'path'; mimeType: string; path: string }
  | { type: 'blob'; mimeType: string; data: Blob }
  | { type: 'url'; url: string; mimeType?: string }
  | { type: 'base64'; mimeType: string; data: string };

interface FileUploadState {
  provider: string;
  status: 'pending' | 'uploaded' | 'expired' | 'deleted' | 'error';
  remoteId: string | null; uploadedAt: number | null;
  expiresAt: number | null; error: string | null;
}
```

`uploads: Map<string, FileUploadState>` tracks upload state per provider. Key state-change
methods: `setUploaded(provider, remoteId, expiresAt)`, `setError(provider, error)`,
`setDeleted(provider)`. `isAvailable(provider)` returns false if `expiresAt` has passed
(and transitions the state to `'expired'` in place). `toBase64()` and `toBuffer()` are
async readers that handle all content types; `path` content uses `nodeFsPromises()`.

`FileAttachment.fromBlob(blob, opts?)` is the browser-friendly constructor, accepting a
standard `Blob` or `File` object.

### `FileProviderAdapter` (`src/plugins/files/provider-adapter.ts`)

```ts
interface FileProviderAdapter {
  readonly name: string;
  upload(file: FileAttachment, fetch: EngineFetch): Promise<FileUploadResult>;
  delete(remoteId: string, fetch: EngineFetch): Promise<void>;
  getInfo(remoteId: string, fetch: EngineFetch): Promise<RemoteFileInfo | null>;
  list(fetch: EngineFetch): Promise<RemoteFileInfo[]>;
  expiresAfter: number | null;  // ms, or null for persistent
  maxFileSize: number;          // bytes
  supportedTypes: string[] | null;  // null = accept all
}
```

### `FilesRegistry` (`src/plugins/files/registry.ts`)

Constructed with `{ hooks, catalog?, strategy?, fetch }`. Subscribes to
`hooks.on('onMessageResolve', ...)` at construction. Call `destroy()` to unsubscribe.

**File registration**: `add({ filename, mimeType, content, sizeBytes? })` creates a
`FileAttachment` with a UUID id. Size is estimated from content when not provided:
buffer length, Blob size, or base64 length × 3/4.

**Resolution pipeline** (called from `onMessageResolve`):

For each message with array content, for each content part of type `'image'`,
`'document'`, `'audio'`, or `'video'` whose `source.type` is `'path'`, `'buffer'`,
or `'file'`:

1. `source.type === 'file'`: look up the `fileId` in `this.files`. Emit `onWarning`
   with code `'file_not_found'` and return null if not found (part is left unchanged).
2. `source.type === 'path'`: synchronously `fs.statSync` the path, create a transient
   `FileAttachment` with content type `'path'`.
3. `source.type === 'buffer'`: create a transient `FileAttachment` with content type
   `'buffer'`.
4. Call `this.strategy.decide(ctx)` with a `FileStrategyContext` built from the file,
   provider, model, `ModelInfo` from catalog, adapter limits, and upload state.
5. `executeDecision()` carries out the action:
   - `'upload'` / `'reupload'`: call `this.upload(file.id, provider)` if
     `file.needsUpload(provider)`, then return a `provider_ref` content part.
   - `'inline'`: call `file.toBase64()` and return a base64 content part.
   - `'url'`: return a url content part (only when `file.content.type === 'url'`).
   - `'skip'`: emit `onWarning` with code `'file_skipped'`, return a text part with
     a human-readable placeholder.

`resolveMessages` mutates `messages` **in place** — the `LLMClient` does not deep-clone
before emitting `onMessageResolve`.

### `DefaultFileStrategy` (`src/plugins/files/strategy.ts`)

Inline threshold: 50 000 bytes (constructor parameter). Decision logic:

1. Unsupported type → `skip`.
2. File exceeds `providerMaxSize` → `skip`.
3. Already uploaded and not expired → `upload` (use existing ref).
4. Expired → `reupload`.
5. URL content on OpenAI or xAI → `url`.
6. Below inline threshold → `inline`.
7. Otherwise → `upload`.

Replace with a custom `FileStrategy` implementation to override.

---

## Batch

### Purpose and boundaries

Intercepts `onBeforeSubmit` events from clients and agents whose `batchable` flag is true
and whose provider has a registered `BatchProviderAdapter`. Defers execution, collects
requests into a window, submits the batch, polls for results via `Scheduler`, and delivers
outcomes back to the original callers. Does NOT intercept non-batchable clients or providers
without a registered adapter.

### Key types (`src/plugins/batch/types.ts`)

```ts
interface BatchStrategy {
  collectionWindowMs: number;
  minBatchSize: number;
  maxBatchSize: number;
  shouldBatch(ctx: { provider: string; markedRequestorsCount: number; pendingCount: number }): boolean;
  estimateFirstPoll(batchSize: number): number;
  pollIntervalMs: number;
}

interface BatchProviderAdapter {
  readonly name: string;
  submit(requests: BatchRequest[], fetch: EngineFetch): Promise<string>;  // returns batchId
  getStatus(batchId: string, fetch: EngineFetch): Promise<BatchStatus>;
  getResults(batchId: string, fetch: EngineFetch): Promise<BatchResult[]>;
  cancel(batchId: string, fetch: EngineFetch): Promise<void>;
}

interface BatchStatus {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'expired' | 'cancelled';
  total: number; completed: number; failed: number; pending: number;
}

interface BatchResult {
  customId: string; success: boolean; response: unknown | null; error: string | null;
}

interface PendingBatchJob {
  batchId: string; provider: string; createdAt: number;
  requests: Array<{ customId: string; conversationId: string; clientId: string }>;
}
```

### `DefaultBatchStrategy` (`src/plugins/batch/strategy.ts`)

Defaults: `collectionWindowMs: 10_000`, `minBatchSize: 3`, `maxBatchSize: 50_000`,
`pollIntervalMs: 30_000`. `shouldBatch` returns true when
`markedRequestorsCount >= minBatchSize`. `estimateFirstPoll` returns 30 s, 60 s, 5 min,
or 10 min depending on batch size (< 10, < 100, < 1000, ≥ 1000).

### `Batcher` (`src/plugins/batch/batcher.ts`)

Constructed with `{ hooks, persistence, scheduler, strategy, providers, fetch }`.

**Lifecycle tracking**: subscribes to `onClientCreate` / `onClientDestroy` /
`onAgentCreate` / `onAgentDestroy` to maintain `this.requestors: Map<string, { provider,
batchable }>`. When an agent is created for a client, the agent entry replaces the client
entry for that client id.

**Interception** (`handleBeforeSubmit`, called from `onBeforeSubmit`):

1. Skip if `!ctx.batchable || ctx.mode !== 'background'` or no adapter for the provider.
2. Compute `markedCount = countBatchableRequestors(ctx.provider)`.
3. If `strategy.shouldBatch` returns false, let the request proceed normally.
4. Set `ctx.intercepted = true` and assign `ctx.resultPromise` to a new Promise.
5. Enqueue the request into `this.collecting[provider]` as a `CollectedRequest` carrying
   the Promise's `resolve`/`reject` callbacks, `customId`, `conversationId`, `clientId`.

**Collection buffer** (`addToCollection`): starts a `collectionWindowMs` timer on first
request per provider. Flushes immediately when `collection.requests.length >= maxBatchSize`.
The timer and the size trigger are mutually exclusive — whichever fires first calls
`flushCollection(provider)`.

**Flush** (`flushCollection`):

1. Splices all pending requests out of the buffer.
2. Calls `adapter.submit(batchRequests, fetch)` → `batchId`.
3. Writes a `PendingBatchJob` to `persistence` under key `batch:{batchId}`.
4. Stores the resolvers in `pendingResolvers: Map<batchId, CollectedRequest[]>`.
5. Schedules `batchPoll` via `scheduler.after(estimateFirstPoll(...), 'batchPoll', { batchId })`.
6. Emits `onWarning` with code `'batch_created'`.

On submit failure, rejects all collected Promises with the error.

**Polling** (`poll(batchId)`): called by `Scheduler`. Calls `adapter.getStatus(batchId,
fetch)`. On terminal status (`completed` / `failed` / `expired`), calls
`handleBatchComplete()` which fetches results via `adapter.getResults(batchId, fetch)` and
resolves/rejects each in-memory resolver by matching `customId`. Then deletes the
persistence key.

**Restart recovery** (`restore()`): reads all `batch:` keys from persistence and reschedules
a `batchPoll` for each surviving job (5 s initial delay). In-memory resolvers are gone after
restart so results are emitted as `onWarning` events with code `'batch_result_ready'` keyed
by `conversationId`, allowing callers that subscribed to the hook to receive results.

---

## Cross-cutting concerns

- **EngineFetch threading**: all three subsystems inject `EngineFetch` (never hold a private
  fetch). Every adapter method receives it per-call. This ensures rate limiting, retry, and
  observability from `NetworkEngine` apply uniformly to media, file upload, and batch HTTP.
- **Cost reporting**: media costs are reported via `onMediaGenerated`. Batch results
  flow through `onCompletion` on the individual client, so `CostCollector` prices them
  normally. File upload calls are not cost-tracked (they use the Files API, not LLM tokens).
- **Persistence**: `FileMediaStore` and `FilePersistence` (used by `Batcher`) both use
  `nodeFsPromises()` and are browser-guarded. `MemoryMediaStore` and `MemoryPersistence`
  work cross-env.

---

## Extension points

**Media**: implement `MediaProviderAdapter` and call `mediaOutput.registerProvider(name,
adapter)`. Implement `MediaStore` to replace file or memory storage.

**Files**: implement `FileProviderAdapter` and call `filesRegistry.registerProvider(name,
adapter)`. Implement `FileStrategy` and pass it at `FilesRegistry` construction to change
attachment decisions.

**Batch**: implement `BatchProviderAdapter`, add it to the `providers` map passed to the
`Batcher` constructor. Implement `BatchStrategy` to change collection window, min size, and
poll timing.

---

## Gotchas and edge cases

- `FilesRegistry.resolveMessages` mutates `messages` in place. The `LLMClient` does not
  deep-clone before emitting `onMessageResolve`. Adapters that hold a reference to the
  original messages array will observe mutations.
- `FileMediaStore.load` and `FileMediaStore.list` with a filter do N serial `getMeta` reads
  (one per file). For large media stores with many entries, this is slow. No parallel batching.
- `FileMediaStore` writes binary data and metadata in a parallel `Promise.all` but does not
  use atomic write. A crash between the two writes leaves an orphaned binary without
  metadata, which `load()` will return null for (meta read fails → return null).
- Batch interception sets `ctx.intercepted = true` synchronously before the Promise is
  resolved asynchronously. Code that inspects `ctx.intercepted` after `onBeforeSubmit`
  returns must `await ctx.resultPromise`, not re-read the request body.
- After a process restart, batch in-memory resolvers are gone. Callers that used `await
  client.complete(...)` with batch intercepted will hang forever if they do not handle
  restart. Subscribe to `onWarning` with code `'batch_result_ready'` to receive results
  after restart.
- `VideoGenRequest.params.resolution` and `MediaOutputConfig.pollIntervalMs` /
  `maxPollWaitMs` must be set before the first call — `MediaOutput` reads them once at
  construction from `MEDIA_OUTPUT_DEFAULTS`.
- `aggregateUsage` in `src/plugins/media/output.ts` returns `undefined` when no
  `RawMediaResult` carries `usage`. `CostCollector` interprets this as unit-priced and
  falls back to flat-rate pricing. Returning a zero-filled `Usage` object instead would
  cause the collector to apply per-token rates with zero tokens, costing nothing. The
  `undefined` path is intentional.
