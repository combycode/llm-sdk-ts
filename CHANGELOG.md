# Changelog

All notable changes to `@combycode/llm-sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[1.2.0]: https://github.com/combycode/llm-sdk-ts/releases/tag/v1.2.0
[1.1.0]: https://github.com/combycode/llm-sdk-ts/releases/tag/v1.1.0
[1.0.0]: https://github.com/combycode/llm-sdk-ts/releases/tag/v1.0.0
