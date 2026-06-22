---
title: Server
---

# Server

Layer 4. OpenAI-compatible HTTP front-end. Source: `src/server/`.

## Purpose and responsibilities

`OaiServer` exposes a small subset of the OpenAI Chat Completions API surface so
existing OpenAI-compatible clients (LangChain, any consumer of the `/v1/chat/completions`
endpoint) can talk to any registered `LLMClient` without code changes. It is a thin adapter
layer — all execution routes through `AgentLoop` via `dispatch`.

Endpoints:

- `POST /v1/chat/completions` — primary chat; fake streaming supported.
- `GET  /v1/models` — lists registered entries with ORXA-specific metadata.
- `GET  /health` — liveness probe, returns `{ status: 'ok' }`.
- `OPTIONS *` — CORS preflight, always 204.

Does NOT implement the full OAI spec. Stateful previous-response-id continuation,
function calling execution server-side, and vision are explicitly limited.

---

## Key types

### `ServerEntry` and `ModelRouter` (`src/server/router.ts`)

```ts
interface ServerEntry {
  model: string;           // model id as it appears in OAI requests
  client: LLMClient;
  internalTools?: AgentTool[];
  allowExternalTools?: boolean;  // default true
  capabilities?: {
    supportsPreviousResponseId?: boolean;
    stateRetentionDays?: number | null;
    tools?: boolean; vision?: boolean; reasoning?: boolean; maxContext?: number;
  };
}

interface ResolvedTarget {
  entry: ServerEntry; client: LLMClient; model: string;
  internalTools: AgentTool[]; allowExternalTools: boolean;
  supportsPreviousResponseId: boolean; stateRetentionDays: number | null;
}
```

`ModelRouter` holds a `Map<string, ServerEntry>`. `register(entry)` throws on duplicate
model ids. `resolve(modelName)` throws a descriptive error listing known models when the
id is unknown. `list()` returns `ModelListing[]` with an `orxa` extension field exposing
routing metadata and capabilities for inspection by callers.

### `ResponseStore` (`src/server/response-store.ts`)

Persists assistant responses keyed by `(userId, localResponseId)` for multi-turn
continuation via `previous_response_id`. Backed by a `Persistence` instance (or in-memory
`Map` when no persistence is configured).

```ts
interface ResponseStoreEntry {
  localResponseId: string; userId: string | null;
  createdAt: number; updatedAt: number;
  target: ResponseTarget;
  providerResponseId: string | null;
  providerStateExpiresAt: number | null;
  history: ConversationHistory;
}
```

In-memory LRU: a `Map<string, ResponseStoreEntry>` capped at `memoryCapacity`
(default 10 000). The `put` / `get` pattern uses `Map` insertion order for eviction —
`get` re-inserts the entry to make it most-recently-used, `put` evicts the oldest via
`cache.keys().next().value` when the cap is exceeded.

`ConversationHistory` is serialized via `history.export()` (`HistorySnapshot`) for
persistence and deserialized via `ConversationHistory.import(snapshot)` on load.

Static helpers: `ResponseStore.newId()` generates `resp_{24-char hex}`.
`ResponseStore.hasFreshProviderState(entry, now?)` checks whether
`providerResponseId` exists and `providerStateExpiresAt > now`.

### `AuthPlugin` (`src/server/auth.ts`)

```ts
interface AuthPlugin {
  verify(headers: Record<string, string>): Promise<AuthVerifyResult> | AuthVerifyResult;
}

interface AuthVerifyResult {
  userId: string;
  metadata?: Record<string, unknown>;
}
```

`BearerKeyAuth` is the built-in implementation. Accepts either a `keys: string[]` list
(userId is derived as `key:${key.slice(0, 8)}`) or a `keys: Record<string, string>` map
of `apiKey -> userId`. Reads `headers.authorization` or `headers.Authorization`.

When no `AuthPlugin` is configured, `userId` is null for all requests.

### Loader plugin slots (`src/server/loaders.ts`)

```ts
interface AgentLoaderPlugin {
  load(ctx: AgentLoaderContext): Promise<AgentLoop | null>;
}

interface AgentLoaderContext {
  userId: string | null; model: string; conversationId?: string;
}

interface ConversationLoaderPlugin {
  load(ctx: ConversationLoaderContext): Promise<ConversationHistory | null>;
  save(ctx: ConversationLoaderContext, history: ConversationHistory): Promise<void>;
}

interface ConversationLoaderContext {
  userId: string | null; conversationId: string;
}
```

When `AgentLoaderPlugin` is provided and returns a non-null `AgentLoop`, `dispatch` reuses
it (system prompt + tools + history come from the loader; the server does not override
them). When it returns null, `dispatch` builds a transient `AgentLoop` from the
`ResolvedTarget`.

When `ConversationLoaderPlugin` is provided, it is called to load and save
`ConversationHistory` around each request, enabling multi-turn conversations across
stateless HTTP calls. When absent, a fresh `ConversationHistory` is built per request.

---

## OAI wire types (`src/server/oai-types.ts`)

Pure TypeScript interfaces for the OpenAI wire format: `OaiChatRequest`,
`OaiChatResponse`, `OaiChatStreamChunk`, `OaiChatMessage`, `OaiContentPart`,
`OaiToolDefinition`, `OaiErrorBody`, `OaiFinishReason`, `OaiModelEntry`. Not exported as
part of the public SDK surface — used only internally by `oai-adapter.ts` and `server.ts`.

---

## `oai-adapter.ts` helper functions (`src/server/oai-adapter.ts`)

Pure conversion functions between OAI shapes and SDK types. No state, no side effects.

- `validateChatRequest(req)`: asserts `model` is a non-empty string, `messages` is a
  non-empty array, each message has a `role` field. Throws on failure with a descriptive
  message.
- `extractLastUserText(messages)`: scans backward for the last `role === 'user'` message,
  converts its content to text via `oaiContentToText`. Throws when no user message is found.
- `extractSystemText(messages)`: collects all `role === 'system'` messages, joins with
  `'\n\n'`.
- `buildChatResponse(input)`: returns an `OaiChatResponse` with a single choice, finish
  reason `'stop'`, and usage counts. Generates a `chatcmpl-{20-char UUID}` id.
- `buildStreamChunk(input)`: returns an `OaiChatStreamChunk` for SSE streaming.
- `formatSseFrame(data)`: serializes to `data: {JSON}\n\n`. `SSE_TERMINATOR =
  'data: [DONE]\n\n'`.
- `buildErrorBody(message, type?, code?)`: shapes an `OaiErrorBody`.
- `estimateTokens(text)`: rough estimate via `Math.ceil(text.length / 4)`. Used only when
  `dispatch` returns zero token counts.

---

## Request handling flow (`src/server/server.ts`)

`OaiServer.handle(request: Request): Promise<Response>` is the main entry point. Called
internally by `Bun.serve` and called directly by tests (no real port binding needed).

1. **Auth**: if `this.auth` is set, call `auth.verify(headersToRecord(request.headers))`.
   On throw, emit `onAuthFail` and return 401.
2. **Telemetry**: emit `onServerRequest` with `{ serverId, requestId, method, path, userId,
   model }`.
3. **Routing**: branch on `request.method + url.pathname`:
   - `OPTIONS *` → 204 with CORS headers.
   - `GET /health` → `{ status: 'ok' }`.
   - `GET /v1/models` → `router.list()`.
   - `POST /v1/chat/completions` → `handleChatCompletions`.
   - Anything else → 404.
4. **Response emission**: emit `onServerResponse` with `{ serverId, requestId, status,
   latencyMs, userId, model }`.

CORS headers (`corsHeaders()`) are attached to all JSON responses: `access-control-allow-
origin: *`, `access-control-allow-methods: GET, POST, OPTIONS, DELETE`,
`access-control-allow-headers: authorization, content-type`.

### `handleChatCompletions` (`src/server/server.ts`)

1. `safeJson(request)` reads and parses the request body (returns null/text on failure
   rather than throwing).
2. `validateChatRequest(body)` — throws and returns 400 on validation failure.
3. `router.resolve(oaiReq.model)` — returns 404 when unknown.
4. Determine `conversationId`: `oaiReq.user ?? userId ?? "default:{model}"`.
5. Load `ConversationHistory`:
   - Call `conversationLoader.load({ userId, conversationId })` if present.
   - On null / no loader: build `new ConversationHistory({ provider, model })`.
6. Load `AgentLoop`:
   - Call `agentLoader.load({ userId, model, conversationId })` if present.
   - On null / no loader: `dispatch` builds a transient loop internally.
7. Call `dispatch(input)` (see dispatch below) → `DispatchResult`.
8. If `conversationLoader` is present: call `.save({ userId, conversationId }, history)`.
9. Compute token counts: prefer `result.inputTokens` / `result.outputTokens`; fall back to
   `estimateTokens(userText + systemPrompt)` / `estimateTokens(result.text)`.
10. Return `buildChatResponse(...)` as JSON 200.

Streaming is NOT currently implemented in the handler despite `OaiChatStreamChunk` types
existing. The response is always a complete JSON body. `buildStreamChunk` and
`formatSseFrame` are available in `oai-adapter.ts` for a future streaming pass.

---

## `dispatch` (`src/server/dispatch.ts`)

```ts
interface DispatchInput {
  target: ResolvedTarget; history: ConversationHistory; userText: string;
  systemPrompt?: string; externalTools?: OaiToolDefinition[];
  maxOutputTokens?: number; temperature?: number; hooks: HookBus;
  agentLoop?: AgentLoop;
}

interface DispatchResult {
  text: string; providerResponseId: string | null;
  inputTokens: number; outputTokens: number;
}
```

`dispatch` is a free function (`export async function dispatch`), not a method.

1. If `target.supportsPreviousResponseId`: subscribe to `onCompletion` to capture
   `ctx.response.id` into `capturedProviderId` (unsubscribed in `finally`).
2. If `input.agentLoop` is provided, use it directly.
3. Otherwise: `mergeTools(target.internalTools, toAgentTools(input.externalTools))`.
   - `mergeTools`: internal tools win on name collision; external tools that duplicate an
     internal name are silently dropped.
   - `toAgentTools`: wraps each `OaiToolDefinition` as an `AgentTool` whose `execute`
     throws `"client-defined tools aren't executed by the OAI server"`. The model receives
     the schema but any actual call fails.
4. Build `new AgentLoop({ client, system, hooks, history, maxTokens, temperature, tools })`.
5. Call `loop.complete(input.userText)` → `{ text, usage }`.
6. Return `{ text, providerResponseId: capturedProviderId, inputTokens, outputTokens }`.

The `history` object is mutated in place: `loop.complete` appends the user message and
assistant response. After `dispatch` returns, `history` contains the updated turns.

---

## Lifecycle: `start()` vs `handle()`

`start()` binds `Bun.serve` on the configured `port` / `hostname` and returns
`{ port, hostname }`. Throws when already started or when `Bun` is not defined.

`handle(request)` is the portable entry point. It accepts any WHATWG `Request` — tests
call it with `new Request('http://localhost/v1/chat/completions', { method: 'POST', body:
... })` without ever binding a port. Framework adapters (Cloudflare Workers, etc.) can wrap
`handle` to host the server under any runtime.

`stop()` calls `Bun.server.stop(true)` (closes active connections).

---

## Telemetry integration

`OaiServer` accepts a `HookBus` via `OaiServerConfig.hooks`. It emits:

- `onServerRequest`: before routing, after auth.
- `onServerResponse`: after every response (including errors), with `latencyMs`.
- `onAuthFail`: when `auth.verify` throws.

The same `HookBus` is passed to `dispatch`, which passes it to `AgentLoop`. This means
server-level events (`onServerRequest`, `onServerResponse`) and LLM-level events
(`onCompletion`, `onToolCallStart`, etc.) appear in the same telemetry stream, correlated
by the shared bus.

---

## Extension points

**Auth**: implement `AuthPlugin.verify`. Return `{ userId }` or throw to reject.

**Agent-per-user**: implement `AgentLoaderPlugin.load`. Return a pre-configured `AgentLoop`
(with system prompt, tools, history) for a given `(userId, model)`. The server passes the
loop to `dispatch` which reuses it without overriding its configuration.

**Conversation persistence**: implement `ConversationLoaderPlugin.load` + `.save`.
The server calls both around every request. Use `FilePersistence` or a database behind the
interface.

**Model registration**: call `server.register(entry)` at any time (even after `start()`).
`server.unregister(model)` removes it.

---

## Gotchas and edge cases

- `OaiServer` is a thin adapter layer. All business logic lives in `AgentLoop`. If an
  `AgentLoaderPlugin` is not configured and the request does not carry a `systemPrompt`,
  `dispatch` builds a loop with `system: ''`. The model receives no system prompt.
- External tools from the OAI client request are NOT executed server-side. Their `execute`
  throws. Only tools registered on the `ServerEntry.internalTools` or via
  `AgentLoaderPlugin` execute. The error message is forwarded to the model so it can
  produce a fallback text response.
- `headersToRecord` (`src/util/http.ts`) lowercases all header names. `BearerKeyAuth`
  reads `headers.authorization` (lowercase). Headers forwarded from clients may use
  `Authorization` (title-case) — `BearerKeyAuth.verify` reads both:
  `headers.authorization ?? headers.Authorization`.
- `ResponseStore` is constructed but not actively used by the current `handleChatCompletions`
  implementation. The store is populated only if a `ConversationLoaderPlugin` is wired
  separately to write to it. The store is accessible as `server.responseStore` for external
  orchestration.
- `safeJson` never throws — it returns null on empty body and the raw string on JSON parse
  failure. `validateChatRequest` then catches the non-object and returns 400.
- `conversationId` defaults to `"default:{model}"` when neither `oaiReq.user` nor `userId`
  is set. All unauthenticated requests to the same model share this id, so their
  `ConversationHistory` would collide if `conversationLoader` is configured without auth.
  Always configure `AuthPlugin` when using `ConversationLoaderPlugin`.
- The `_agentLoader` and `_conversationLoader` getters on `OaiServer` are marked
  `@internal`. Do not rely on them outside tests.
