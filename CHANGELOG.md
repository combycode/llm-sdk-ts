# Changelog

All notable changes to `@combycode/llm-sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.7.0] - 2026-07-16

### Added
- **Video extend + edit (xAI grok-imagine-video).** `VideoGenRequest` gains `sourceVideo?: DataSource`
  and `params.videoMode?: 'extend' | 'edit'`. When a source video is present the xAI adapter routes to
  the right endpoint instead of plain generation: `extend` (default) → `POST /v1/videos/extensions`
  (continues from the last frame; takes `duration`, ignores aspect/resolution), `edit` →
  `POST /v1/videos/edits` (prompt + video only). The clip is passed as a public URL, a Files-API id, or
  an inline base64 data-URL. `MediaCapabilities` gains `videoExtension`; `MediaOutput.generateVideo`
  throws if a `sourceVideo` is sent to a provider that doesn't support it (rather than silently
  generating). `generateVideo(req)` is unchanged — the new fields flow through. Verified live end-to-end
  on `grok-imagine-video`: generate → extend → edit all return video bytes. (Note: extend/edit require
  `grok-imagine-video`, not `grok-imagine-video-1.5`, which is generation-only.)
- **`onMediaProgress` hook.** Long-running async video ops (generate/extend/edit) now emit an
  `onMediaProgress` event once per poll (`{ type, provider, operationId, progress, model }`), so a UI can
  render a progress bar. Progress values confirmed live (0→100).
- **`RawMediaResult.sourceUrl` + `MediaMeta.sourceUrl`.** Async video results now carry the provider's
  hosted URL, so callers can render or re-submit the asset without holding the bytes.
- **Unified reasoning visibility.** `ThinkingConfig` gains `visibility: 'full' (default) | 'summary' |
  'hidden'`, mapping to Anthropic `enabled.display`, OpenAI Responses `summary`, and Google
  `includeThoughts` — one knob for "how much reasoning comes back" across providers (best-effort; a
  provider without a middle state degrades `summary` to full). Default `full` = prior behaviour.
- **OpenAI reasoning execution mode.** `providerOptions.reasoningMode: 'standard' | 'pro'` maps to
  `reasoning.mode` on the OpenAI **Responses** path (chat-completions rejects it). Kept in
  `providerOptions` rather than a first-class knob since only one provider/API honours it.
- **Google `translationConfig` passthrough.** `providerOptions.translationConfig` forwards to
  `generationConfig.translationConfig` on generateContent (Gemini Developer API; live-verified 200).
- **OpenAI native moderation blocking.** `providerOptions.moderationPolicy`
  (`{ input?: { mode: 'score'|'block' }, output?: {…} }`) forwards to OpenAI's `moderation.policy` on
  Responses + chat for server-side blocking. Unified moderation stays report-only by design (blocking is
  `moderationGuardrail` at the agent layer); this is an OpenAI-specific opt-in, so it lives in
  `providerOptions`. Live-verified the field is accepted.
- **OpenAI explicit prompt caching.** `providerOptions.promptCacheOptions`
  (`{ mode: 'implicit'|'explicit', ttl: '30m' }`) forwards to `prompt_cache_options` (gpt-5.6+),
  true-OpenAI only (xai/openrouter inherit the builder and don't emit it). Note: OpenAI caches
  **implicitly by default**, so the unified `cache` config already works there with no config — this
  passthrough is for manual control. (`prompt_cache_retention` is deprecated upstream in favour of
  `prompt_cache_options.ttl`.)
- **OpenAI programmatic tool calling (Responses).** `BuiltinTool` gains `programmatic_tool_calling`, and
  `FunctionTool` gains `allowedCallers?: ('direct'|'programmatic')[]` + `outputSchema?` — emitted on the
  OpenAI Responses path only. Live-verified on gpt-5.6 (tool calls succeed; older models reject the
  builtin, which is model-gated). (Surfacing the `program`/`program_output` output items is deferred; the
  parser already tolerates them without error.)

### Fixed
- **OpenAI prompt-cache write tokens were dropped.** Both usage parsers hardcoded `cacheWriteTokens: 0`;
  they now read `input_tokens_details.cache_write_tokens` (Responses) / `prompt_tokens_details.
  cache_write_tokens` (chat), so cost accounting no longer under-reports explicit prompt caching.
- **Google reasoning was live-broken (two paths).** generateContent sent `thinkingLevel`, which the
  Gemini Developer API 400s on **2.5** models (it is 3.x-only) — now routed per series: 2.5 →
  `thinkingBudget` (token count), 3.x → `thinkingLevel`. The Interactions path wrapped `thinking_config`
  (rejected outright) and used uppercase values — it takes `thinking_level` **flat** on `generation_config`
  and **lowercase** (`minimal/low/medium/high`). Both live-verified across gemini-2.5 + 3.5.
- **Google Interactions rejected sampling penalties.** We emitted `presence_penalty`/`frequency_penalty`
  on the Interactions path, which the API 400s ("Unknown parameter") — upstream removed them from its
  Interactions config. No longer emitted there (still valid on generateContent).
- **Streamed tool-call id collision on OpenAI-compatible backends.** The chat-completions stream parser
  keyed tool-call fragments by `id ?? ''`, so parallel calls from backends that omit ids (LiteLLM/Bedrock,
  some OpenRouter routes) merged into one. Fragments are now correlated by `index`, with a stable
  `call_<uuid>` synthesized once per index when the backend omits ids.
- **`content_filter` finish reason was flattened to `stop`/`length`.** The chat-completions stream reason
  map lacked `content_filter`, `AgentLoop` derived every normal-completion finish as `stop`, and the
  Responses parser mapped `status: 'incomplete'` to `length` regardless of `incomplete_details.reason` —
  all discarding the provider's actual reason. Now the stream map, the loop, and the Responses parser
  (reading `incomplete_details.reason`) all surface `content_filter` (and `length`) to consumers — so a
  moderation/safety block is distinguishable from a token cap. (Our loop already terminates on non-tool
  finishes, so it never retry-looped on an empty filtered turn.)
- **Browser: xAI video result was unusable (CORS).** The generated clip lives on a cross-origin bucket
  (`vidgen.x.ai`) that sends no `Access-Control-Allow-Origin`, so `downloadVideo`'s programmatic
  byte-fetch was blocked in the browser and video generation failed outright. In the browser the adapter
  now returns the hosted URL (via `sourceUrl`) with empty bytes instead of fetching — `<video src>` plays
  it cross-origin without CORS, and it can be re-submitted as a `sourceVideo`. Node/Bun still download the
  bytes. (Node-only tests couldn't surface this; CORS isn't enforced off-browser.)
- **Google `editImage` aspect ratio / size (same bug, second code path).** The 1.6.1 fix moved
  `aspectRatio` / `imageSize` to `generationConfig.imageConfig` only in `generateImage`; the sibling
  `editImage` method still wrote `generationConfig.responseFormat.image` and so 400'd on any edit that
  passed an aspect ratio or size. Now both image paths use `imageConfig`. Verified live end-to-end:
  generate → edit round-trip both return an image at `16:9` / `2K`. Locked with a unit regression on the
  `editImage` request body.
- **xAI video generation polled forever after the job finished.** `getVideoStatus` only treated
  `status: "completed"`/`"ready"` (or a `download_url`) as done, but xAI reports terminal success as
  `status: "done"` with the URL under `video.url` — so a finished job kept polling until the wait cap and
  never returned. `downloadVideo` likewise read `download_url`/`url` and missed `video.url` (and duration
  under `video.duration`). Both now read the real `video.*` shape (flat fallbacks kept), and terminal
  `status: "done"`/`"expired"` are handled. Progress is now carried on the processing status. Verified
  live end-to-end (grok-imagine-video-1.5 image-to-video: progress 0→75→100 → downloaded 2.5 MB); locked
  with a unit test replaying the real server payload.

## [1.6.1] - 2026-07-13

### Fixed
- **Google gemini-image aspect ratio / size (broken image generation).** The `generateContent` image
  path put `aspectRatio` / `imageSize` under `generationConfig.responseFormat.image`, which the API
  rejects (`Invalid value at 'generation_config.response_format.image.aspect_ratio'`) — so any image
  request that passed an aspect ratio 400'd. They belong under `generationConfig.imageConfig`. Verified
  live: `imageConfig.aspectRatio` returns an image for every ratio. (Regressed into view once the 1.6.0
  catalog started advertising `aspectRatio` media params, so the sandbox began sending it.)
- **Per-model image sizes in the catalog.** The gemini-image `imageSize` options were a blanket
  `512/1K/2K/4K`, but the models 400 on sizes they don't support. Narrowed per model
  (live-probed + confirmed against the official docs): `gemini-3.1-flash-lite-image` → `1K` only;
  `gemini-3-pro-image` / `nano-banana-pro` → `1K/2K/4K` (no 512); `gemini-3.1-flash-image` keeps all four.

## [1.6.0] - 2026-07-11

### Added
- **Typed structured-output failure + opt-in repair.** Structured output that can't be parsed now throws
  a typed `InvalidFinalOutputError` (extends `AgentRunError`, carries `reason: 'invalid_final_output'` and
  the model's `rawText`) instead of a bare `SyntaxError`, so callers can `instanceof`/inspect/retry.
  `structuredComplete` gains an opt-in `structured.repairAttempts` (default 0): on a parse failure it
  re-prompts with the error up to N times before throwing. Exports `AgentRunError`,
  `InvalidFinalOutputError`. (`max_steps` / `model_refusal` stay returned results, differentiated by
  `finishReason` / `AgentRunReport.reason`; run-error handler hooks can layer on later.)
- **`user_profile_id` + Interactions `cached_content`.** Anthropic forwards `providerOptions.userProfileId`
  to the `anthropic-user-profile-id` header; Google Interactions maps `providerOptions.cachedContent` to
  its `cached_content` resource.
- **Sampling penalties.** `presencePenalty` / `frequencyPenalty` ([-2, 2]) on `complete()` / `stream()`
  (and `NormalizedRequest`), mapped to the providers that accept them — OpenAI/xAI **chat-completions**
  (`presence_penalty` / `frequency_penalty`), OpenRouter (inherited), Google **generateContent**
  (`generationConfig.presencePenalty` / `frequencyPenalty`) and **Interactions** (snake_case). Ignored by
  OpenAI/xAI **Responses** and Anthropic, which don't accept them (verified against the SDK sources — the
  Responses API has no penalty fields). Verified live on OpenAI, Google, and xAI.
- **Unified `web_fetch` hosted tool.** New `{ type: 'web_fetch' }` builtin that reads a
  user-provided URL, mapped to Anthropic's `web_fetch_20260318` (GA; `params` like `allowed_domains`
  / `blocked_domains` / `citations` / `max_content_tokens` / `max_uses` forwarded verbatim, with
  `allowed_callers: ['direct']` defaulted so it works on chat models) and Google's `urlContext` tool.
  The fetched URL surfaces on `response.builtinToolCalls` (`{ tool: 'web_fetch', url }`) and the
  streamed `builtin_tool_start` / `builtin_tool_end` events, normalized across both providers.
  `capabilities.builtinTools` / `catalog.supportsBuiltinTool()` / `select('web_fetch')` report it on
  Anthropic + Google (OpenAI's `web_search` already opens pages; xAI / OpenRouter expose no fetch
  tool). Verified live on Anthropic and Google.
- **Builtin-tool call payloads.** `BuiltinToolCall` (and the `builtin_tool_end` stream event) now
  carry what the tool ran: `code` + `output` (stdout) for `code_interpreter`, and `query` (search
  step) or `url` (page-open step) for `web_search` — normalized across every provider (OpenAI/xAI
  `code_interpreter_call.code` + `web_search_call.action` `query`/`queries[]`/`url`, Anthropic
  `server_tool_use.input` streamed via `input_json_delta` and correlated to its `*_tool_result`
  stdout, Google `executableCode`/`codeExecutionResult` + grounding `webSearchQueries`). A single
  OpenAI web search is a multi-step agent: `search` actions carry a query, `open_page`/`find`
  actions carry the URL they read. Available on both `complete()` and streamed responses; verified
  live on all four providers.

### Changed
- **Anthropic web-search bumped to `web_search_20260318`** (from `web_search_20250305`) and now forwards
  the unified `BuiltinTool.params` verbatim — `allowed_domains`, `blocked_domains`, `user_location`,
  `response_inclusion`, `max_uses` (previously all silently dropped). The new version defaults to
  *programmatic* tool calling (via code execution), which chat models like haiku reject, so the adapter
  sends `allowed_callers: ['direct']` by default to preserve the classic direct-call behaviour; callers
  override any default through `params`. Live-verified across all providers (scenario 27, 5/5).

### Fixed
- **xAI `service_tier` maps to xAI's own enum.** The xAI adapter inherited OpenAI's tier map and could
  emit `auto` / `flex` / `scale`, which xAI's API rejects (its `ServiceTier` is `default` | `priority`
  only). It now remaps from the unified tier — `standard` → `default`, `priority` → `priority`, and any
  value xAI can't honor is omitted (the server picks its default) rather than 400'ing. Live-verified:
  `priority` sent and billed back (`usage.serviceTier`/`pricingTier`), `flex` no longer errors.
- **Agent loop no longer swallows failed runs into empty text.** `AgentLoop.complete()` and
  `.stream()` caught any mid-run LLM error, set `finishReason:'error'`, and returned an empty
  `CompletionResponse` (or ended the stream) with the error message dropped — so a tool-using
  `complete()` / `delegate()` / `handoff()` returned `""` on an auth failure, rate limit, context
  overflow, etc., while the same call *without* tools threw. Both now **re-throw** the original error
  (preserving `LLMError` kind/status) after finalizing metrics/hooks, matching the no-tools path and
  the raw client stream. `AgentLoop.run()` is unchanged — it still returns an `AgentRunReport` with
  `reason:'error'` + `error` for callers that want partial results. Live-verified (bad key → thrown
  `auth` error, not empty text).
- **Agent loop now continues stateful turns server-side.** After a tool call the loop stamped its
  assistant turn without provenance, so multi-turn runs on a stateful API always resent the full
  transcript. On Google Interactions that transcript replay is *rejected* (the API requires resuming
  by `previous_interaction_id`), which surfaced as an **empty final answer** on agentic tool use. The
  loop now stamps `id` / `createdAt` / `origin.serverStateId` (via the shared `buildAssistantMessage`),
  so the server-state brain continues by id and sends only the new turn — gated, as before, by catalog
  support, the retention TTL (openai/xai 30d, google 72h), and model binding. Live-verified: Interactions
  agentic round-trip now answers; OpenAI Responses / Anthropic tool loops unchanged.
- **Google Interactions streaming (opt-in `api: 'interactions'`) brought current with the 2.10 wire.**
  The regenerated Interactions client replaced the old `content.delta` / `interaction.complete` events
  with a step machine — `step.start` / `step.delta` / `step.stop`, `interaction.created` /
  `interaction.completed` / `interaction.status_update` — so the previous parser produced no output.
  The parser now reads `step.delta` payloads (`text`, `thought_summary` → thinking, `arguments_delta`),
  opens/attaches/closes a function call across `step.start` → `arguments_delta` → `step.stop` (the
  `arguments_delta` carries no id, so a per-stream parser correlates it), and finishes on
  `interaction.completed` / `interaction.failed` with usage from `interaction.usage`. Live-verified
  against the 2.10 API (streamed text, tool calls, usage). The default Google path (`generateContent`)
  is unaffected.
- **OpenAI web-search query precedence.** OpenAI deprecated the singular `web_search_call.action.query`
  in favour of `action.queries[]`; the Responses adapter now prefers the array and falls back to the
  scalar, so `BuiltinToolCall.query` stays populated on the new wire.
- **Duplicate OpenAI code-execution files.** When code calls `plt.show()` *and* saves the figure,
  OpenAI emits an extra auto-display container file alongside the saved one — surfacing the same
  chart twice on `response.files`. The Responses adapter now drops the auto-display artifact (an
  image citation named after its own file id, with a zero-width span) when the same image was also
  saved, matching ChatGPT's own UI. A display-only run keeps its sole figure; distinct saved files
  are never collapsed. Investigated across providers: only OpenAI has this pattern (Anthropic/xAI
  return only saved files; Google returns one artifact per output) — so the fix is scoped to the
  OpenAI Responses adapter.

## [1.5.1] - 2026-07-06

### Changed
- `retrieveFile` / `streamFile` now send Anthropic's `anthropic-dangerous-direct-browser-access:
  true` header in the browser, for consistency with the completion adapter. **Note:** this does
  NOT make Anthropic hosted-tool files downloadable from a browser — Anthropic's Files API
  (`GET /v1/files/{id}/content`) does not return CORS headers (unlike `/v1/messages`), so file
  retrieval for Anthropic is **server-side only** (verified against the API + the official docs).
  OpenAI works in-browser; Google and xAI return files inline (no fetch), so they work too.

## [1.5.0] - 2026-07-06

### Added
- **Builtin-tool activity in streams + a durable trail.** Provider-run hosted tools (web search,
  code execution) now surface `{ type: 'builtin_tool_start' }` / `{ type: 'builtin_tool_end' }`
  stream events as they run, and a `response.builtinToolCalls` trail (`BuiltinToolCall[]` —
  `{ tool, id? }` with unified tool names) on both `complete()` and streamed responses (propagated
  through `AgentLoop`). Informational only — unlike `tool_call_*` (a function call the client must
  execute), the provider runs these itself. Normalized across providers (Anthropic `server_tool_use`
  / `*_tool_result`, OpenAI/xAI `web_search_call` / `code_interpreter_call` output items, Google
  `executableCode` / `codeExecutionResult` parts + `googleSearch` grounding, OpenRouter
  `:online` `url_citation` annotations → `web_search`). Verified live on Anthropic, OpenAI,
  Google, xAI, and OpenRouter. Exports `BuiltinToolCall`.

## [1.4.0] - 2026-07-06

### Fixed
- **xAI hosted code-execution files** now surface on `response.files` (parity with the other
  providers). xAI returns code-interpreter output files inline inside the `code_interpreter_call`
  `logs` JSON (`output_files:[{file_name, mime_type, data:[…bytes]}]`) and only when the request
  asks for them — so `XAIResponsesAdapter` now sends `include:['code_interpreter_call.outputs']`
  when `code_interpreter` is used and extracts the inline bytes into `FileOutput`. Verified live on
  `complete()` and `stream()`. `OpenAIResponsesAdapter.filesFromOutputItem` is now a `protected`
  overridable method so Responses-compatible providers can extend file extraction.

### Added
- **Adapter-sourced builtin-tool capabilities in the catalog.** Every tool-capable (chat-family)
  model now carries `capabilities.builtinTools` — `['web_search', 'code_interpreter']` for
  anthropic/openai/google/xai, `['web_search']` for openrouter (it doesn't route hosted code
  execution) — injected at catalog load from a single provider map (`PROVIDER_BUILTIN_TOOLS`) that
  mirrors what the adapters actually support. New `catalog.builtinToolsFor()` /
  `supportsBuiltinTool()` accessors and `select('web_search')` / `select('code_interpreter')`
  queries (`search` stays an alias for `web_search`). Non-tool models (embeddings/tts/image) get
  none. A reliable per-model source can refine this later.

## [1.3.0] - 2026-07-06

### Added
- **Streaming file parity.** `stream()` now surfaces hosted code-execution output files with the
  same coverage as `complete()`: a new `{ type: 'file', file }` `StreamEvent` is emitted as each
  file finalizes mid-stream, and the files are collected onto the streamed final response's
  `files` (via `onCompletion` / the agent final response). New `ProviderAdapter.createStreamParser()`
  returns a per-stream parser so adapters can hold per-stream state — used by Google to route an
  inline code-execution artifact (whose "code ran" marker and bytes arrive in separate SSE events)
  to `files` rather than conversational `media`. Verified live on Anthropic, OpenAI, and Google.
- **File-content retrieval** for hosted-tool output files. `CompleteResult`, `LLMClient`, and
  the agent result now expose `retrieveFile(file)` → `{ blob, name, mimeType, size }` and
  `streamFile(file)` → `{ stream, name, mimeType, size }`, resolving a `FileOutput`'s inline
  `data`, `url`, or provider file `id` through the same model + key the call used — no
  re-passing credentials. `streamFile` pipes large files to a sink without buffering. Name /
  mime / size come from the download response headers (Content-Disposition / Content-Type /
  Content-Length, with a filename-extension mime fallback). New network `responseType: 'stream'`
  returns the raw body and releases the queue slot immediately. Exports `RetrievedFile`,
  `FileStream`. Auth is sent only to the provider's own host.

## [1.2.0] - 2026-07-05

### Fixed
- Anthropic hosted code-execution **file outputs** now surface on `response.files` (verified
  live). Three fixes, found by real-key testing: (1) the producer parsed the outdated
  `code_execution_tool_result` shape, but the current `code_execution_20260521` tool emits
  `bash_code_execution_tool_result` → `bash_code_execution_output.file_id` (now both are
  handled); (2) code execution needs the beta endpoint — requests using `code_interpreter` now
  hit `/v1/messages?beta=true`, without which no file outputs are returned; (3) `AgentLoop`'s
  final response dropped `files` (and `moderation`) — both are now propagated from the final
  LLM response in `complete()` and `stream()`.

### Added
- `AgentLoopConfig.toolInputGuardrails` (`ToolInputGuardrail[]`) — per-tool-call input
  guardrails that validate a call's arguments before the permission/approval check. A trip
  denies just that call (error result to the model) without halting the run or invoking the
  HITL approver; a pass runs the normal permission/approval/execution path.
- `AgentTool.customDataExtractor` — optional hook to derive out-of-band metadata from a
  successful tool result, attached to that call's `ToolCallReport.customData`. The model never
  sees it (for your own telemetry/routing/audit); a throwing extractor is swallowed.
- Code-execution **file outputs** now surface on `response.files` across **all** providers
  (completes the channel shipped in 1.1, which had only the Anthropic producer):
  - OpenAI Responses: code-interpreter image outputs (by URL) and downloadable container
    files (`container_file_citation` → file id + name).
  - Google: hosted code-execution `inlineData` artifacts (base64), routed to `files`
    instead of `media` when the turn used code execution.
  - xAI: inherited from the OpenAI Responses adapter.
  - `FileOutput` gains a `url` field (for providers that return a fetchable URL).

## [1.1.0] - 2026-06-30

### Added
- Hosted MCP tool `tunnel_id` target (OpenAI Secure MCP Tunnel) — reach a private/local MCP
  server with no public URL alongside the existing `server_url` / `connector_id` targets. The
  `mcp` builtin already forwards `params`; added the exported `McpToolParams` type for editor
  help and a regression test locking the forwarding. (Realtime MCP tooling tracked separately.)
- `ThinkingConfig.context` (`'auto' | 'current_turn' | 'all_turns'`) — maps to OpenAI's
  Responses `reasoning.context`, controlling which prior-turn reasoning items are rendered back
  to the model across a stateful conversation. OpenAI Responses-only; ignored by other providers.
- Inline moderation via the `moderation` request option on `complete()`/`stream()`
  (parity with OpenAI's `moderation` request field, extended to all providers). Report-only:
  results attach to `CompletionResponse.moderation` (`ModerationReport`) and never block the call.
  Native on the OpenAI provider (one round-trip on both Responses and Chat Completions); emulated
  via OpenAI's moderations endpoint on every other provider (`mode: 'native' | 'emulate'`).
  Streaming supports three strategies (`buffer` default / `parallel` / `post`) trading latency for
  how early the flag reaches the consumer, surfaced as a `moderation` stream event. Emulation
  requires an OpenAI key (reused from the client when it is the OpenAI provider, else
  `moderation.apiKey`); missing key throws.
- Unified `CompletionResponse.files` (`FileOutput[]`) - files produced by hosted tools
  (code execution, etc.), independent of `media`. The Anthropic adapter surfaces
  code-execution file outputs there by file id; OpenAI/Google/xAI producers to follow.
- Model catalog: new `ModelInfo.availability` field (`limited` / `preview`, vs default
  generally-available) so gated / early-access models are distinguishable from the
  `status` lifecycle. (Entries for specific limited/preview models are populated by the
  catalog pipeline.)
- Anthropic: the unified `code_interpreter` builtin now maps to Anthropic's hosted
  `code_execution` tool (GA on Messages) - it was previously silently skipped. Hosted
  code execution is now usable across Anthropic / OpenAI / Google through one interface.
- Google service tier, both directions (parity with OpenAI/Anthropic): a requested
  unified `serviceTier` (`flex`/`standard`/`priority`) maps to Google's top-level
  request field, and the billed `usageMetadata.serviceTier` is read back into
  `usage.serviceTier` / `usage.pricingTier` for tiered cost tracking.
  (New `providers/google/tiers.ts`.)

## [1.0.0] - 2026-06-13

First public release.

### Added
- Unified API across Anthropic, OpenAI, Google, xAI, and OpenRouter.
- Model catalog: normalised slug names, `model:tier` selectors, and
  capability-based `select()`.
- Tiered pricing with cost tracking and budget limits.
- Service tiers end to end (request → bill → cost).
- Cross-environment: runs on Node, Bun, and the browser. ESM, zero runtime deps.

[1.6.1]: https://github.com/combycode/llm-sdk-ts/releases/tag/v1.6.1
[1.6.0]: https://github.com/combycode/llm-sdk-ts/releases/tag/v1.6.0
[1.2.0]: https://github.com/combycode/llm-sdk-ts/releases/tag/v1.2.0
[1.1.0]: https://github.com/combycode/llm-sdk-ts/releases/tag/v1.1.0
[1.0.0]: https://github.com/combycode/llm-sdk-ts/releases/tag/v1.0.0
