---
title: LLM Client
---

# LLM Client

Layer 2. Format adapter only. Source: `src/llm/`.

## Purpose and responsibilities

- Hold a fixed `(provider, model, apiKey, system)` binding, immutable after construction.
- Accept universal `(string | ContentPart[] | Message[])` input and normalize it
  into a provider-specific HTTP body via a `ProviderAdapter`.
- Route the resulting request through the injected `EngineFetch` /
  `EngineFetchStream` — never calls `fetch` directly.
- Parse the provider's raw HTTP response body into a normalized `CompletionResponse`
  or `AsyncIterable<StreamEvent>`.
- Emit lifecycle hooks: `onClientCreate`, `onMessageResolve`, `onBeforeSubmit`,
  `onCompletion`, `onClientDestroy`.

Does NOT own: a queue, retry policy, cache, or rate limiter. Those belong to
`NetworkEngine` (queue/retry) and the Cache plugin (`onBeforeSubmit` intercept).

## Key types

### `src/llm/types/provider.ts`

```ts
type ProviderName = 'anthropic' | 'openai' | 'google' | 'xai' | 'openrouter';
type ApiType = 'completions' | 'responses' | 'messages' | 'interactions' | 'generate';

interface ProviderAdapter {
  readonly name: ProviderName;
  buildRequest(req: NormalizedRequest): ProviderHttpRequest;
  parseResponse(raw: unknown, latencyMs: number): CompletionResponse;
  parseStreamEvent(event: SSEEvent): StreamEvent[];
  authHeaders(): Record<string, string>;
  baseURL(): string;
  completionPath(): string;
  enableStreaming?(providerReq: ProviderHttpRequest, req: NormalizedRequest): void;
}

interface ProviderHttpRequest {
  body: Record<string, unknown>;
  headers?: Record<string, string>;   // extra request headers (e.g. Anthropic beta flags)
  path?: string;                      // override default completionPath()
}
```

### `src/llm/types/request.ts`

```ts
interface NormalizedRequest {
  model: string;
  messages: Message[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  structured?: { schema: Record<string, unknown>; name?: string; strict?: boolean };
  thinking?: ThinkingConfig;    // discriminated union — see below
  cache?: CacheConfig;          // 'auto' | 'off' | { system?, tools?, ttl? }
  serviceTier?: ServiceTier;
  moderation?: ModerationRequest; // inline moderation (report-only); native on OpenAI, emulated elsewhere
  providerOptions?: Record<string, unknown>;
  audio?: AudioOptions;
  outputModalities?: Array<'text' | 'audio'>;
  previousResponseId?: string;  // Responses/Interactions API chain continuation
  timeout?: number;
  signal?: AbortSignal;
}
```

`ThinkingConfig` is a discriminated union. `effort` is present only on the `'auto'` and
`'on'` members; the `'off'` member has no `effort` field:

```ts
type ThinkingConfig =
  | { mode: 'auto'; effort?: 'low' | 'medium' | 'high' | 'max' }
  | { mode: 'on';   effort?: 'low' | 'medium' | 'high' | 'max' }
  | { mode: 'off' };
```

### `src/llm/types/response.ts`

```ts
interface CompletionResponse {
  id: string;
  model: string;
  content: ContentPart[];
  finishReason: FinishReason;       // 'stop' | 'tool_use' | 'length' | 'content_filter' | 'error'
  usage: Usage;
  text: string;                     // convenience: joined text parts
  toolCalls: ToolCallPart[];
  thinking: string | null;
  media: MediaOutputPart[];          // generated media (image/audio/video)
  files?: FileOutput[];              // hosted-tool file outputs (e.g. code execution): {id?,name?,mimeType?,data?,source?}
  moderation?: ModerationReport;     // inline-moderation outcome when the `moderation` option was used: {input?,output?,source}
  latencyMs: number;
  raw: unknown;                     // provider's raw HTTP response body
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  serviceTier?: string;    // raw provider tier name (e.g. 'batch', 'priority')
  pricingTier?: string;    // adapter-normalized tier key → for cost lookup
}
```

### `src/llm/types/stream.ts`

```ts
type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call_start'; id: string; name: string; _meta?: Record<string, unknown> }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; error: Error }
  | { type: 'media_start'; mediaType: 'image'|'audio'|'video'; mimeType: string }
  | { type: 'media_chunk'; data: string; progress?: number }
  | { type: 'media_end'; mediaId?: string };
```

## `LLMClient` class (`src/llm/client.ts`)

Immutable fields set at construction: `id` (UUID), `sessionId`, `provider`,
`model`, `system`, `hooks`, `api` (`ApiType`), `mode` (`'foreground'|'background'`),
`batchable`, `adapter` (`ProviderAdapter`), `fetchFn`, `fetchStreamFn`,
`priority`, `queueName`, `configName`, `cacheName`, `cacheKeyFn`, `catalog`.

### `resolveApi` (`src/llm/client-internal.ts`)

Provider defaults when `api` is omitted or `'auto'`:
- `anthropic` → `'messages'`
- `openai` → `'responses'`
- `google` → `'generate'`
- `xai` → `'responses'`
- `openrouter` → `'completions'`

### `resolveAdapter`

If `config.adapter` is a function (factory), calls `adapter(provider, apiKey, api,
baseURL)` to get the concrete `ProviderAdapter`. Otherwise uses the object directly.

## Input normalization (`src/llm/client-internal.ts`)

`normalizeInput(input)`:
- `string` → `[{ role: 'user', content: string }]`
- `ContentPart[]` (first element lacks `role`) → `[{ role: 'user', content: parts }]`
- `Message[]` → used as-is

`extractSystem(messages)`: lifts every `role: 'system'` message out of the
messages array and concatenates their text content. Adapters never see
`role: 'system'`; they receive only `system` as a top-level field in
`NormalizedRequest`. This makes per-call system text work on all providers
(Anthropic rejects `role: 'system'` in the messages array).

System composition in `complete()`:
```text
composedSystem = [options.system, systemFromMessages, this.system]
  .filter(truthy)
  .join('\n\n')
```

## `complete()` flow (`src/llm/client.ts:147`)

1. `normalizeInput(input)` → `rawMessages`.
2. `extractSystem(rawMessages)` → `{ system: systemFromMessages, messages }`.
3. Compose `composedSystem` (three-way join above).
4. `buildContext(this, options)` → `RequestContext` with minted `requestId`
   (`req_<12-char UUID>`), `callId` (`call_<8-char UUID>`), `sessionId`,
   `queueName`, `configName`, `cacheName`, `cacheKey`.
5. Build `NormalizedRequest` from config + per-call options.
6. Emit `onMessageResolve` (async). Handlers (FilesRegistry, ContextGuard) may:
   - Mutate `resolveCtx.messages` and `resolveCtx.system` in place.
   - Set `resolveCtx.abort = true` (+ optional `abortReason`) to cancel.
7. Re-anchor `normalized.messages` and `normalized.system` from the (possibly
   mutated) `resolveCtx`.
8. Server-state resolution: unless `previousResponseId` is explicitly set or
   `options.stateful === false`, call `resolveServerState(...)` to determine
   whether to send `previous_response_id` and trim the messages array to just
   the new turn.
9. `adapter.buildRequest(normalized)` → `ProviderHttpRequest`.
10. Compute `url = adapter.baseURL() + (providerReq.path ?? adapter.completionPath())`.
11. `cacheKeyFn` applied if configured.
12. Emit `onBeforeSubmit` (async). Cache plugin may set `intercepted = true` +
    `resultPromise` to bypass the network entirely.
13. If intercepted: `rawResult = await submitCtx.resultPromise`, wrap in `HttpResponse`.
14. Else: build `HttpRequest` (merging `adapter.authHeaders()` + `providerReq.headers`),
    call `fetchFn(httpReq, { queueName, priority, estimatedTokens })`.
15. `adapter.parseResponse(response.body, latencyMs)` → `CompletionResponse`.
16. Emit `onCompletion` (async) with full request + response metadata.
17. Return `CompletionResponse`.

`estimatedInputTokens` (passed to the queue for rate-limit token accounting):
`Math.ceil(JSON.stringify(normalized.messages).length / 4)`.

## `stream()` flow (`src/llm/client.ts:310`)

Steps 1–7 identical to `complete()`. No server-state resolution. No
`onBeforeSubmit` (caching streaming is out of scope). Then:

8. `adapter.buildRequest(normalized)` → `providerReq`.
9. `adapter.enableStreaming?.(providerReq, normalized)` — adapter mutates the
   body (e.g. sets `stream: true`).
10. Build `HttpRequest` with `stream: true`.
11. Accumulate as the SSE stream flows:
    ```ts
    for await (const sseEvent of fetchStreamFn(httpReq, ...)) {
      const events = adapter.parseStreamEvent(sseEvent);
      for (const event of events) {
        if (event.type === 'text') text += event.text;
        if (event.type === 'thinking') thinking += event.text;
        if (event.type === 'usage') usage = event.usage;
        if (event.type === 'done') finishReason = event.finishReason;
        yield event;
      }
    }
    ```
12. Synthesize a `CompletionResponse` from accumulated `text`, `usage`, `finishReason`.
13. Emit `onCompletion` (async) — same hook as `complete()`, so `CostCollector`
    and `ContextMeasurer` price and measure streamed calls identically.

`structuredComplete<T>()` wraps `complete()` with `structured: { schema }` and
then calls `parseStructured<T>(res.text)` (from `client-internal.ts`): strips
leading/trailing markdown fences (```` ``` ````), then `JSON.parse`.

## Provider adapters

Five provider directories: `src/llm/providers/{anthropic,openai,google,xai,openrouter}/`.

### Anthropic — `src/llm/providers/anthropic/messages.ts`

`AnthropicAdapter` implements the Messages API (`/v1/messages`).

**`buildRequest`**:
- Maps `NormalizedRequest.messages` to Anthropic message blocks via
  `buildMessage(msg, req, forceCache)`.
- `cache: 'auto'` adds `cache_control: { type: 'ephemeral' }` to the last
  message's last block (conversation prefix) and to the system and tools arrays.
- `thinking` → `{ type: 'enabled', budget_tokens: N }` where `N` is mapped from
  `effort` via `ANTHROPIC_THINKING_BUDGETS`. Lifts `max_tokens` above `budget_tokens`.
- `structured` → `output_config.format.type = 'json_schema'`.
- File refs (source type `provider_ref` or `file`) in content parts trigger the
  `anthropic-beta: files-api-2025-04-14` header.
- Tool role `'tool'` is remapped to `'user'` (Anthropic's wire format).
- `web_search` builtin maps to `{ type: 'web_search_20250305', name: 'web_search' }`;
  `code_interpreter` maps to `{ type: 'code_execution_20260521', name: 'code_execution' }`
  (both GA on Messages, no beta header). Other builtins are skipped. Code-execution
  file outputs (`code_execution_tool_result` blocks) are surfaced as `response.files`.
- Service tier: `'auto'` → `'auto'`; `'standard'` → `'standard_only'`;
  `'priority'` → `'auto'`; `'flex'`/`'scale'` → `'standard_only'` or `'auto'`.

**`parseResponse`**: reads `content[]` blocks; `type: 'text'` → `TextPart`,
`type: 'thinking'` → sets `thinking`, `type: 'tool_use'` → `ToolCallPart`.
Usage: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`.

**`parseStreamEvent`** dispatches on `data.type`:
- `content_block_delta` + `text_delta` → `{ type: 'text' }`
- `content_block_delta` + `thinking_delta` → `{ type: 'thinking' }`
- `content_block_delta` + `input_json_delta` → `{ type: 'tool_call_delta' }`
- `content_block_start` + `tool_use` block → `{ type: 'tool_call_start' }`
- `message_delta` → `{ type: 'usage' }` + `{ type: 'done' }`
- `message_start` → `{ type: 'usage' }` (initial usage with input tokens)

In-browser: adds `anthropic-dangerous-direct-browser-access: true` header
(detected via `isBrowser()` from `src/runtime/runtime.ts`).

### OpenAI Responses — `src/llm/providers/openai/responses.ts`

`OpenAIResponsesAdapter` targets the Responses API (`/v1/responses`).

**`buildRequest`**:
- Converts `messages` → flat `input[]` array of typed items:
  - User/system text → `{ role, content: string }` or content-part array with
    `input_text`, `input_image`, `input_file` types.
  - Assistant → `{ type: 'message', role: 'assistant', content: [{ type: 'output_text' }] }`
    and tool calls as `{ type: 'function_call', id: 'fc_<id>', call_id, name, arguments }`.
  - Tool results → `{ type: 'function_call_output', call_id, output }`.
- `system` → `instructions`.
- `previousResponseId` → `previous_response_id` (server-state chain).
- Function tools → `{ type: 'function', name, description, parameters, strict }`.
- Builtin tools pass through with `...t.params`; `code_interpreter` defaults
  `container = { type: 'auto' }` when absent.
- `structured` → `text.format = { type: 'json_schema', name, schema, strict }`.
- `thinking` → `reasoning = { effort, summary: 'auto' }`.

**`parseResponse`**: iterates `output[]` items; `type: 'message'` → text content;
`type: 'reasoning'` → extracts summary text as `thinking`; `type: 'function_call'`
→ `ToolCallPart`; `type: 'image_generation_call'` → `ImageOutputPart`.

**`parseStreamEvent`** dispatches on SSE event types prefixed `response.`:
- `response.output_text.delta` → `{ type: 'text' }`
- `response.function_call_arguments.delta` → `{ type: 'tool_call_delta' }`
- `response.output_item.added` with `function_call` → `{ type: 'tool_call_start' }`
- `response.output_item.done` → `tool_call_end`, `media_end`, or `thinking`
- `response.image_generation_call.partial_image` → `{ type: 'media_chunk' }`
- `response.completed` → `usage` + `done`

Inline file data requires a `filename` field with the correct extension
(`filenameForMime` helper at `responses.ts:34`).

### OpenAI Completions — `src/llm/providers/openai/completions.ts`

Legacy Chat Completions (`/v1/chat/completions`). Maps `messages` directly to
OpenAI's `role: user|assistant|tool` format. Tool calls serialized as
`{ id, type: 'function', function: { name, arguments } }`.

### Google — `src/llm/providers/google/generate.ts`

Targets `generateContent` (`/v1beta/models/{model}:generateContent`). Maps
messages to `contents[]` with `role: user|model`. `system` → `systemInstruction`.
Tools → `tools[].functionDeclarations[]`.

### xAI and OpenRouter

xAI (`src/llm/providers/xai/`) supports both `responses.ts` and
`completions.ts` (same Responses API shape as OpenAI). OpenRouter
(`src/llm/providers/openrouter/`) uses Chat Completions with provider-passthrough.

### Shared utilities (`src/llm/providers/_shared/`)

- `response-utils.ts`: `extractFinishReason(hasToolCalls, providerReason, reasonMap)` —
  maps provider stop reason strings to `FinishReason`. If `hasToolCalls` is true,
  always returns `'tool_use'`.
- `constants.ts`: `DEFAULT_MAX_TOKENS = 4096`.

`parseUsage` is NOT shared — each provider's usage schema differs too much.

## Queue routing and priority

`queueName` defaults to `"${provider}/${model}"`. Overridable via:
1. `LLMClientConfig.queueName` (construction time)
2. `RequestContext.queueName` (per-call via `options.ctx.queueName`)

Priority: `mode: 'background'` → `PRIORITY_BACKGROUND = 2`;
foreground → `PRIORITY_INTERACTIVE = 1`. Retries use `Priority.RETRY = 0`.

## RequestContext propagation (`src/types/request-context.ts`)

`buildContext(client, options)` in `client-internal.ts` mints:
- `sessionId` from `client.sessionId` (or override from `options.ctx`)
- `requestId` minted as `req_<12-char>` if not already set
- `callId` minted as `call_<8-char>` if not already set
- `queueName`, `configName`, `cacheName`, `cacheKey`

The `trace` object attached to every `HttpRequest` is
`{ sessionId, requestId, callId }` from this context.

## Server-state (Responses API chain)

`resolveServerState` (`src/llm/server-state.ts`) checks:
1. Last assistant message in history has `origin.serverStateId` and
   `origin.provider === this.provider`.
2. `catalog.supportsPreviousResponseId(provider, model)` returns true.
3. State retention period has not elapsed (uses `catalog.getStateRetention`).
4. `catalog.isStateModelBound` — if true, the model must match across turns.

When all pass: sets `normalized.previousResponseId = origin.serverStateId` and
trims `normalized.messages` to only the new turn (the provider reconstructs
context from its stored state).

## Extension points — adding a provider

1. Create `src/llm/providers/<name>/` with a class implementing `ProviderAdapter`.
2. Add a `catalog.json` in that directory; `ModelCatalog.loadProviderDefaults()`
   auto-loads it.
3. Register the new `ProviderName` in `src/llm/types/provider.ts`.
4. Add a default `ApiType` in `resolveApi` (`client-internal.ts`).
5. Export an adapter factory from the provider directory's index.

## Key invariants

- `LLMClient` is immutable after construction: `provider`, `model`, `apiKey`,
  `system`, and `adapter` are all fixed.
- It never calls `fetch` directly; it always calls the injected `EngineFetch`.
- `onMessageResolve` is the only hook where handlers may mutate the request
  in place. All other hooks are observational.
- `onBeforeSubmit` is the only interception point for the Cache plugin to
  short-circuit a network call.
- `role: 'system'` messages are extracted by `extractSystem` before any adapter
  sees the messages array — adapters never receive `role: 'system'`.
- `onCompletion` fires for both `complete()` and `stream()` (with a synthesized
  response for the streaming case). `CostCollector` subscribes to this single event.
