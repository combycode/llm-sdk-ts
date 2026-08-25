# Changelog

All notable changes to `@combycode/llm-sdk` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **A provider can declare a hosted tool it will not run beside certain content** (`toolConstraints`
  in a wire spec, plus a `hasPartType` condition). Measured 2026-08-25: Google answers 400 `The mime
  type: video/mp4 is not supported for code execution` when `code_interpreter` accompanies a PDF or a
  video. Images are fine, `web_search` is fine, and OpenAI accepts every combination — so it is one
  provider's rule, and it lives in that provider's spec as data rather than as an `if` in the builder.

  A matched constraint drops the tool — `hasTool` reports it absent, so the spec's existing guard
  omits it with no further edit — and records why on the built request. `LLMClient` emits each as
  `onWarning` with code `request_adjusted`, on both `complete()` and `stream()`. Dropping it quietly
  would trade a confusing error for the silent loss of a capability the caller asked for.

### Fixed

- **An Anthropic model is reachable by the name Anthropic documents.** `claude-haiku-4-5` — the
  spelling in Anthropic's own docs, and one the API accepts — matched no catalog key and no alias,
  because `/v1/models` lists only the dated snapshot (`claude-haiku-4-5-20251001`) while our slug
  dots the version (`claude-haiku-4.5`). `get()` and `getPricing()` missed in silence, and an
  unpriced model is indistinguishable from a free one: reported from production as 72k tokens
  billed at $0.00.

  The undated form is now carried as an alias for the four affected entries (`claude-haiku-4-5`,
  `claude-sonnet-4-5`, `claude-opus-4-5`, `claude-opus-4-1`), derived in the catalog pipeline so a
  regeneration keeps it. Anthropic-only, and deliberately so — the same date-stripping applied to
  other providers invents ids that do not exist (`imagen-4.0-generate`, `command-r7b-12`), since
  only there is the undated form a truncation rather than a real alias. Each was probed live.

  `providerModelName` is untouched, so **what goes on the wire is unchanged**: a slug still
  translates to its pinned snapshot, and an alias is still sent verbatim as the floating id the
  caller chose. This widens what the catalog recognises, never what it calls.

## [3.0.0] — 2026-08-24

### Added

- **Exact token counting for xAI**, via `/v1/tokenize-text`. Their own SDK reaches the tokenizer over
  gRPC (`xai_api.Tokenize/TokenizeText`), which made it look like exact counts on xAI would cost a
  protobuf dependency and an optional peer. Asking the REST host instead: it answers 200 with the
  same token list, so this is one more spec-built request and the library stays zero-dependency.

  All seven xAI text models now declare `count_api` — measured per model rather than generalised
  from one success: the five image and video models do not answer the endpoint and stay on the
  heuristic. On a short Cyrillic line the estimate and the tokenizer differ by 30% on emoji and 23%
  on code.

  One distinction the guide now spells out: Anthropic and Google count the message array a
  completion would send, so their answer is what the completion is billed for, while xAI tokenizes
  a STRING — exact for that text, excluding the chat framing around it.

- **`createEngine({ checkResponseShapes: true })` — warn when a provider's response stops looking
  like the one we learned to read.** A bad request returns 400 and you know at once; a bad response
  returns 200, the parse succeeds, and the field we read is simply gone — for `usage.output_tokens`
  that is cost reporting silently going to zero.

  Four findings, on the warning bus as `response_shape_*`: a field never seen, a field that was
  present in every recording and is now absent (what a rename looks like from outside), a
  discriminator carrying a value nothing branches on (a new content-block type is dropped in
  silence), and a streaming event type the parser does not handle. Off by default, never changes
  what is parsed, and each distinct finding is reported **once per client** — a warning that repeats
  every request is one people switch off.

  The shapes are DERIVED from the recorded response corpus by `bun run derive:shapes`, never
  hand-written, and a test re-checks every recorded body against them so the description cannot
  drift from the recordings. Stream shapes are keyed per SSE event type: pooling them was the first
  attempt and it cost the missing-field check entirely, since `message_start` and
  `content_block_delta` share almost no fields.

  The value of deriving rather than writing showed up immediately — a hand-written "normal
  Anthropic response" in the first draft of the test was missing eight fields Anthropic sends on
  every call (`stop_details`, `usage.service_tier`, `usage.cache_read_input_tokens` among them).
  The check was right and the hand-written body was wrong.

- **A recorded corpus of what providers send BACK** (`tests/fixtures/response-golden.json`, 42 cells).
  All seven existing corpora describe REQUESTS; the parse side was exercised only against literals
  written by hand in the test files, which tests what the author believed a provider returns. This
  records the real thing — the pre-parse body, or the ordered SSE events — for seven adapters across
  six shapes (text, tool call, parallel tool calls, structured output, streaming text, streaming
  tool call), and replays them through the same `parseResponse` / `createStreamParser` with no
  network.

  `raw` is the provider's truth and moves only when `bun run record:responses --refresh` is run;
  `parsed` is our behaviour and is recomputed on every test run, so a parser change surfaces as a
  failure instead of as a quiet difference in what consumers receive. Two invariants are checked
  across all providers at once: every non-streaming response yields usage and a finish reason, and
  every stream ends in a terminal event.

  The corpus was proven to fail on a renamed provider field, on a parser that drops the finish
  reason, and on a cell quietly disappearing. It found both fixes below in its first run.

- **The SDK's event stream is one discriminated union** (`HookEvent`). `HookMap` types a
  subscription — `on('onCompletion', h)` has always known its own context — but the STREAM was
  `(name, ctx: unknown)`, which pushed the type back onto the subscriber. `HookEvent` gives it one
  variant per hook, derived from `HookMap` so the 51 cannot drift from the 51:

  ```ts
  hooks.onAny((e) => {
    if (e.type === 'onCompletion') e.ctx.response?.usage;   // narrowed, no cast
  });
  ```

  This is the shape the Python and Rust ports share: a tagged union and an `enum` over the same
  catalog. A stream typed `ctx: unknown` has no equivalent in either — the consumer's only move is
  to cast, which is exactly what the SDK's own telemetry adapter did.

- **A model ships as callable only if it has been called.** The catalog-loader's probe was
  advisory; 366 of 440 names had never been verified. Now `active: true` requires either a real
  request that answered (`verifiedBy: 'probe'`) or the provider's own model list naming it
  (`verifiedBy: 'listed'`, the only evidence available for an image or TTS model). Everything else
  ships `active: false` — present, priced, but not offered to `selectModel`.

  A name is called ONCE: later runs check the listing instead, which is free. A verified name that
  disappears from the list is marked deprecated rather than re-probed. Verification went from
  74/440 to 395/470.

- **`scripts/pin-catalog.ts` and `freeze-wire-golden.ts --add-new`** — a catalog import brings
  models with no wire-spec pin and no entry in the frozen request corpus, and the library asserts
  both. Deriving the pin and appending only the unseen models keeps those invariants true without
  re-freezing a baseline that exists to be stable.

- **The last four hand-built surfaces are spec-driven**: exact token counting, live model listing,
  file-content retrieval and the provenance check. With those, **every request the library sends
  comes from a spec** — 145 of them. Nothing in `src/` assembles a URL, a header set or a body by
  hand any more.

- **MCP is spec-driven too, transport and OAuth.** The Streamable-HTTP transport's five requests
  (call, notification, long-lived subscription, event stream, session delete) and the OAuth flow's
  five (two discovery probes, dynamic client registration, code exchange, refresh) now come from 13
  specs — as does the authorization URL the user's browser opens.

  This is the point where the spec format stops being about LLM providers. A JSON-RPC envelope,
  era-dependent routing headers, a form-urlencoded token grant and an SSE stream are all described
  with the constructs a chat request already used.

  Verified against two frozen corpora (23 transport artifacts, 11 OAuth), both shown to fail on
  deliberate corruption, plus live runs of the MCP protocol example and the five-provider MCP tool
  scenario. The OAuth half has no live coverage anywhere — that needs a real authorization server
  and a browser — so its frozen bytes are the only oracle it has, which the wire README now says
  out loud.

- **Three more spec constructs**, each added because a real request needed it: `bodyKind: 'form'`
  (the spec carries the FIELDS, the runtime encodes them — the same split multipart already used),
  a header entry with `spread` (merge an evaluated object of headers, so a caller's header map and
  a resolved bearer keep their precedence), and `queryEncoding: 'form'` (a space as `+` rather than
  `%20`, which is what RFC 6749 prescribes for an authorization request and what the library
  already sent).

- `NormalizedRequest.wireSpec` — the catalog's pin, resolved by `LLMClient` and read by
  the adapter. Absent for an uncatalogued model or an engine with no catalog, in which
  case the adapter derives the spec the way it always derived the shape.

- **`envelope.query` in the wire spec** — query parameters as data, each able to drop out on its
  own. Splicing them into a `$join` URL only works while every parameter is present, and it left
  the encoding to each caller: the hand-written backends disagreed about `encodeURIComponent`, so a
  page token containing `+` paged from the wrong place and the API answered 200.

- **`$each` in array templates** — the array analogue of `$spread`, for a `$map` that has to sit
  beside literal entries. Google's `tools` array is exactly that shape.

- **`scripts/gen-wire-registry.ts` (`bun run gen:registry`)** — regenerates the spec index from the
  files on disk, with `--check` for CI. Specs have landed without their registry entry three times
  now, and it fails silently: the spec becomes invisible to `WIRE_SPECS`, so the chain tests skip it
  and the coverage audit reports it as neither referenced nor executed.

- **A live hosted-retrieval example** (`31-hosted-retrieval`), run on OpenAI and Google by the
  quality gate. Hosted retrieval had unit tests and documentation but had never once been executed
  against a provider, which is how both defects below survived.

### Changed

- **`HookBus.onAny` receives one event object instead of `(name, ctx)`** (BREAKING). Handlers take
  `(event: HookEvent)`; `event.type` narrows `event.ctx`.

  ```ts
  hooks.onAny((name, ctx) => { ... });   // before
  hooks.onAny((event) => { ... });       // after
  ```

  The SDK's telemetry adapter was the only consumer, and it shows why the old shape was worth
  breaking: it opened with `const c = ctx as Record<string, unknown>` and then cast per field —
  `(c.response as { usage?: … })?.usage`, `c.latencyMs as number`, `(c.error as Error)?.message`.
  Rename a context field and every one of those keeps compiling and quietly reads `undefined`,
  which for the token and cost fields is a metric that silently goes to zero. All 26 casts in that
  method are gone (0 left); the switch narrows instead, and the compiler now checks each field against the
  context it actually belongs to.

  Nothing is allocated when no catch-all is subscribed, so the per-chunk hot path is unchanged.
- **The catalog is current again, and the chain that maintains it works end to end.** The
  catalog-loader's export pointed at the catalogs' old home, which was BOTH its write target and
  its merge base — so the "never drop a shipped model, never blank a price" guarantee silently
  guaranteed nothing, and a run would have dropped 10 models and all 284 `wireSpec` pins. Repointed,
  and it now refuses to run at all if the merge base is missing.

  With it fixed, a full run brought the catalog up to date: +99 models discovered, 57 prices
  changed (all four provider pricing pages had moved), 42 tokenizer strategies delivered, 61 models
  marked `active: false`, and 48 given a deprecation date the sources announced. The `wire` field
  removed in 3.0.0 was still riding along on 26 entries and is now dropped.

- **The catalog is loaded by default** (BREAKING, behaviour). `createEngine()` and `LLMClient` used
  to start with an EMPTY catalog unless the caller passed `catalog: 'defaults'`. Three things fell
  back silently as a result: the wire spec was derived from the model id instead of read from its
  pin, every price was unknown, and every token count was the 4-chars-per-token estimate. Each is
  the right answer for a model this build has never heard of, which is why nothing looked wrong.

  This is the prerequisite the 3.0.0 design named (report 037, R1): the adapters can only be driven
  by per-model data if that data is actually there. The bundled catalogs are statically imported
  either way, so leaving them unloaded never saved a byte — it cost about a millisecond of indexing
  per engine and bought silence.

  Opting out is now the explicit act: `catalog: false` or `catalog: 'empty'`.

- **`AnthropicCountApi` and `GoogleCountApi` take an `EngineFetch`, and it is required** (BREAKING).
  They defaulted to `globalThis.fetch`, so every exact token count for Anthropic and Google went out
  AROUND the NetworkEngine: no queue, no rate limiting, no retry, no telemetry span — while every
  other file in the library states that all HTTP goes through the injected fetch. `countTokens()`
  passes `engine.fetch` for you, so the documented path needs no change; a `HybridTokenCounter`
  built with `countApiKeys` but no `fetch` now says so and falls back to the heuristic instead of
  silently leaving the engine.

  The default is gone rather than replaced, because a default that silently bypasses the engine is
  what produced this.

- **MCP header assembly is one ordered list instead of three helpers.** Which headers a call
  carries — session, protocol version, the modern `Mcp-Method` / `Mcp-Name` routing pair — was
  decided by three private methods and by the order their results were spread into an object
  literal. It is now a declared sequence, and the two rules that genuinely are not data (era
  detection, and reading a subject from a different param per method) are named registry entries
  the coverage audit executes.

  One asymmetry was preserved rather than tidied: a NOTIFICATION carries no routing headers, which
  is what the transport has always sent. The freeze caught the attempt to "fix" it, and there is no
  modern server here to test the change against.

- **The chat adapters build their requests from the wire specs.** All five —
  `anthropic/messages`, `google/generateContent`, `google/interactions`,
  `openai/responses` and `openai/chat-completions`, the last two also covering the xAI
  and OpenRouter flavors — now interpret the spec the catalog pins the model to, instead
  of assembling the body by hand. 806 lines of request-building code became 147.

  The three OpenAI-compatible subclasses are the clearest case: xAI and OpenRouter each
  overrode `buildRequest` to call `super`, then rename `max_tokens`, strip `reasoning`,
  remap the service tier and merge routing options. Every one of those edits is already
  the flavor overlay in the shared spec, so naming the flavor is now the entire override.

  **The wire did not move.** A corpus frozen from 2.3.0 — 290 subjects x 22 request
  shapes, both the pinned and the id-derived route — is compared on every CI run, and all
  12,760 comparisons are byte-identical to what 2.3.0 sent. Verified live against all five
  providers as well; the specs are proven, not assumed.

  Two supporting moves: `wire-transforms` left `src/wire/` (it imports from `src/llm`, and
  the new edge would otherwise have made a cycle), and the runtime loads a chat-only spec
  set rather than the full 71-spec index, so nothing is bundled that nothing executes.
  Cost: +15 KB packed, and ~5 microseconds per request against a network call.

- **Model-band selection is data, not code.** Which chain node an UNPINNED model uses now comes
  from `src/wire/pins/*.json` — ordered regex rules plus a default — instead of version arithmetic
  written in TypeScript. The Python and Rust ports read the same file rather than each
  re-implementing the rule and drifting from it, which is how 2.2.1 happened.

  The fallback itself is unchanged and still matters: it is how the SDK behaves for a model
  released after this build, and for any engine run without a catalog. Verified against every id
  the previous code handled, plus dated snapshots, legacy family-last ids, and plausible future
  releases.

  One deliberate fix came out of it: the old pair of helpers disagreed on case — one lower-cased
  the model id and the other did not — so `CLAUDE-OPUS-4-6` lost a `top_k` that model accepts. The
  pin table lower-cases consistently.

- **The hosted retrieval backends build their requests from wire specs.** OpenAI vector stores,
  Google file search stores and xAI Grok collections — 23 hand-assembled requests across three
  files — now come from 24 specs. This was the largest remaining block of request construction
  written three times over, once per provider.

  xAI shows why it matters: collections span two hosts with two separate credentials, and which
  pair a call used was decided by whichever bearer helper the author typed next to the URL. It is
  now a property of the endpoint, declared in the spec.

  Verified against a corpus frozen from the pre-migration commit — 41 requests, byte-identical —
  and by a live end-to-end run on both providers.

### Fixed

- **An explicit `provider` was ignored whenever the model id contained a slash — sending the API key
  to the wrong company.** `resolveModel` read the model's `vendor/` prefix first and fell back to the
  explicit argument only for a bare id. Every OpenRouter model id is `vendor/model`, so the most
  ordinary OpenRouter call there is —

  ```ts
  createLLM({ provider: 'openrouter', model: 'openai/gpt-5.4-nano', apiKey })
  ```

  — resolved to the provider `openai` and sent the **OpenRouter key to api.openai.com**, which
  answered `Incorrect API key provided: sk-or-v1…`. A vendor outside our five failed differently and
  no better: the prefix was cast to a `ProviderName`, so `qwen/qwen3` produced a provider literally
  named `qwen` and died later as "no default adapter for provider 'qwen'".

  An explicit provider now wins, and a redundant leading `<provider>/` is stripped, so the catalog's
  own `openrouter/openai/gpt-5.4-nano` slug resolves to the OpenRouter model `openai/gpt-5.4-nano`.
  Prefix parsing without a provider is unchanged and stays permissive — `estimate()` prices models
  catalogued under providers nobody can call. Affects all nine call sites: `createLLM`, `batch`,
  `embed`, `moderate`, `transcribe`, `createRealtime`, `countTokens`, `estimate`, `estimator`.

- **Google's `responseId` was thrown away and replaced with a random UUID.** `parseResponse` minted
  `crypto.randomUUID()` under a comment claiming generateContent returns no id — it returns
  `responseId` at the top level, and every recorded response carries one. Two consequences: the parse
  was not deterministic, so the same bytes produced a different `response.id` each time and nothing
  keyed on it could correlate; and a cache hit, which replays the stored body, reported a different
  id than the call that populated it. The provider's id is now used, with the generated one kept as
  a fallback for older payloads.

- **`batch`, `embed`, `transcribe` and `moderate` sent our SLUG instead of the provider's id.**
  Only `createLLM` translated through the catalog, so those four worked purely for models whose
  canonical id happens to be the callable one. The moment the sample corpus moved to
  `claude-haiku-4.5`, every batch request came back `not_found_error: model: claude-haiku-4.5` —
  two requests, zero successes, and an exit code of 0 to go with it.

  All four now send `providerModelName` while keeping the slug for pricing and catalog lookups,
  which are keyed by it. A test asserts the distinction and was checked against the unfixed code.

- **Exact token counting works, for the first time.** `HybridTokenCounter` picks its strategy from
  the catalog's `tokenizer.strategy`, and no shipped model declared one — so every count fell back
  to the 4-chars-per-token estimate and neither exact path had ever run. All 455 models now carry a
  strategy: `count_api` for Anthropic and Google chat models, `tiktoken` for OpenAI, `heuristic`
  elsewhere. On one Cyrillic line the difference is 9 estimated versus **19 actual**.

  Two defects surfaced the moment the strategy was selected:

  - The count endpoint was sent our canonical SLUG (`claude-haiku-4.5`) rather than the callable id
    (`claude-haiku-4-5-20251001`), so the first model whose ids differed answered 404. The chat path
    translates through the catalog; this one did not.
  - A model marked `tiktoken` threw when the optional `tiktoken` peer was not installed, turning a
    number into an error for anyone who had not opted in — while the guide promised the opposite.
    The counter now falls back to the heuristic and says so once. Only that specific error is
    caught: a network failure inside the count API still surfaces, because quietly answering with
    an estimate when an exact count was asked for is how a wrong number gets believed.

- **xAI hosted retrieval said "ready" before anything was searchable.** `indexStatus()` derived
  readiness from the collection's `documents_count`, which reaches 1 the moment a document is
  ATTACHED — measured at about five seconds before that document can actually be found. A caller
  that polled exactly as the guide instructs still searched an empty index, and the model answered
  from its own knowledge with nothing to say why.

  It now reads the per-document status the API actually exposes (`DOCUMENT_STATUS_PROCESSING` ->
  `PROCESSED`), so `ready` means searchable, and a partial failure reports `error` instead of a
  quietly smaller corpus. xAI now passes the live hosted-retrieval scenario.

  Found with it: `listCorpora()` threw a `TypeError` on every real response — the API returns
  `{ collections: [...] }` and the code expected a bare array, as did the test fake. Both defects
  survived because the unit tests were written against invented response shapes; they now use the
  ones captured from the live API.

- **The Google API key no longer travels in the URL.** Twelve endpoints — files, batch, media
  generation, Imagen, Veo and the long-running-operation polls — sent it as `?key=`, so the
  credential was copied into every access log, proxy log and telemetry span the request passed
  through, and could leak through a `Referer`. They now send `x-goog-api-key`, which is what the
  chat adapter was already fixed to do. One endpoint was sending it BOTH ways.

  `google/realtime` still uses `?key=` and is the one documented exemption: it is a WebSocket
  handshake and a browser cannot set a header on one. A test enumerates the exemptions and fails if
  one becomes stale, so the next `?key=` cannot arrive quietly.

  Verified live before the fixtures were re-frozen — google files, image, tts and batch all pass
  with header auth — and the re-freeze was diffed pairwise: 21 artifacts changed, every one only in
  that way.

- **The cost ledger recorded a provider call that never happened.** `countTokens()` emitted its
  zero-cost count-API entry whenever the provider was Anthropic or Google and a key was present —
  that is INTENT. The counter picks its strategy from the catalog's `tokenizer.strategy`, and no
  catalogued model declares one, so the heuristic answered and nothing was called. The entry is now
  gated on the strategy that actually ran.

- **A test that was describing the bug.** The count-API cost test stubbed `globalThis.fetch` and
  handed the engine a `null` one — it could only pass while the count APIs bypassed the engine. It
  now intercepts the engine's fetch and asserts the endpoint that was called.

- **A Google hosted corpus was silently ignored.** `{ type: 'file_search' }` had no mapping in the
  Gemini chain spec, so the tool was dropped from the request and the model answered from its own
  knowledge, with no error anywhere. The live example asks a question only the uploaded document
  can answer and got a plausible wrong number back. `fileSearch` is now mapped from the tool's
  params, matching `Tool.fileSearch` in Google's own SDK.

  The same call on OpenAI failed loudly instead (`Missing required parameter:
  'tools[0].vector_store_ids'`): a hosted `asTool()` result has to be passed as the `params` of a
  `file_search` builtin. The retrieval guide now shows that, having previously said "splice into
  the provider's native call" without saying how.

- **Hosted document uploads are reproducible.** A document with no `label` was named
  `doc-<random-uuid>.txt`, so the same upload produced a different request every time: it could not
  be asserted in a test, frozen in a fixture, or matched against a log, and a retried upload
  arrived under a new name. The fallback is now derived from the document's content — the same fix
  the xAI batch name got.

### Removed

- **`ModelInfo.wire`, `NormalizedRequest.wire` and the `ModelWire` type** (BREAKING, type-level
  only). These carried per-model wire traits; `ModelInfo.wireSpec` carries the same knowledge and
  carries it once. Two
  representations of one fact drift, and this library has shipped two bugs from exactly that. See
  MIGRATION.md — behaviour is unchanged and most codebases need no edit.

  Removed with them, and never reachable from the package entry point: `anthropicThinkingShape`,
  `anthropicAcceptsTopK`, `ANTHROPIC_ADAPTIVE_THINKING_MIN`, `ANTHROPIC_THINKING_BUDGETS`,
  `DEFAULT_ANTHROPIC_THINKING_BUDGET`, `googleUsesThinkingBudget`, `GOOGLE_THINKING_BUDGETS`,
  `GOOGLE_THINKING_LEVELS`.

## [2.3.0] — 2026-08-23

### Added

- **Every catalogued chat model is pinned to a wire spec.** `ModelInfo.wireSpec` names the spec
  that builds that model's requests — `anthropic/messages@4.7`, `google/generate@2.5`,
  `openai/responses`, and so on. All 289 chat models across five providers carry one.

  The pin is what lets this SDK and the Python and Rust ports agree on a model without each
  re-deriving its wire shape from the model id — the derivation that produced the 2.2.1 and 2.2.2
  bugs.

  Carried and validated, not yet authoritative: the hand-written adapters still build requests
  from `wire` traits. Because that is two representations of one fact, and two representations
  drift, a test drives the PINNED SPEC and asserts the request it produces matches what the traits
  say the model takes. When the adapters become spec-driven in 3.0.0, `wire` goes away and that
  test is what makes the swap safe.

- **Wire specs ship in the repo** (`src/wire/`). 71 JSON specs describe how to talk to each
  provider API — field names, enum values, defaults, versioned tool-type strings, which shape a
  model version takes — covering every adapter the SDK has: chat, interactions, media, realtime,
  embeddings, files and batch.

  They exist so the Python and Rust ports consume one artifact instead of re-deriving the same
  knowledge three times, and so a provider change is one reviewable diff rather than three code
  changes. This is the knowledge that, living in regexes, produced the 2.2.1 and 2.2.2 bugs.

  **Oracle, not yet authority:** the adapters remain hand-written, and a test
  (`tests/unit/wire`) proves the specs and the adapters agree on every CI run — data that is
  never executed rots. Making the specs authoritative is the 3.0.0 step.

  They are not exported from `index.ts` and are tree-shaken out of `dist`, so they add **no bytes**
  to the published package (verified: package size unchanged).

- **Every catalogued chat model is checked against its pinned spec on every run.** The previous
  pin test drove Anthropic and Google models only — 26 of 289. The other 263, 224 of them
  OpenRouter, were covered by nothing stronger than "the pin names a spec that resolves", which a
  typo satisfies. `tests/unit/wire/every-model-reproduces-its-adapter.test.ts` now builds 17
  request shapes for every chat model, through the spec the CATALOG pins it to, and requires the
  payload to equal the one the real adapter produces — ~4,900 comparisons, under a second.

  The adapter is chosen from `preferredApi`, never from the pin. Choosing it from the pin is
  circular and silently so: mis-pin an OpenRouter model to `openai/responses` and the adapter
  moves with it, both sides agree, and the sweep stays green on a broken pin. It did exactly that
  until a deliberate corruption caught it. Mis-pinning any single model in any of the five
  providers now fails, as does a provider losing its pins entirely.

- **A consumer example for traces** (`telemetry-traces`, in the examples corpus): subscribing with
  `onTrace`, filtering by span type at the subscription rather than in the handler, head sampling,
  keeping prompt content out, joining an inbound `traceparent`, naming a run with
  `label`/`source`/`attributes`, and reading `client.routing`. The trace feed had no example at
  all, which the quality gate's example-first check was reporting.

- **Request builders on the media and realtime adapters.** These adapters used to assemble each
  request *inside* the method that also fetched and parsed it, so the only way to see what the SDK
  would send was to intercept the network. Construction is now separated:

  - `GoogleMediaAdapter`: `buildImageRequest`, `buildEditImageRequest`, `buildAudioRequest`,
    `buildVideoRequest`, plus the lower-level `buildImagenRequest` / `buildGenerateContentRequest`.
  - `OpenAIMediaAdapter`: `buildGenerateImageRequest`, `buildEditImageRequest`, `buildAudioRequest`,
    `buildVideoRequest`.
  - Realtime: `buildConnectRequest` on both adapters, and free functions
    `buildOpenAISessionUpdate` / `buildOpenAITurnFrames` and `buildGoogleSetupFrame` /
    `buildGoogleTurnFrames` for the handshake and per-turn frames.

  The public methods now call these, so the two cannot drift — and a test
  (`media-request-builders.test.ts`) asserts that what a builder returns is byte-identical to what
  its method actually sends.

  Additive: no existing signature changed.

- **The catalog now knows how to TALK to a model, not just what it can do.** `ModelInfo` gains a
  `wire` block carrying per-model wire traits — which `thinking` shape the model accepts, whether
  it takes `top_k` — and `LLMClient` resolves it onto every request as `NormalizedRequest.wire`.
  Adapters read that instead of parsing the model id.

  This is the gap behind two shipped bugs. The catalog already recorded that a model supported
  reasoning; nothing recorded which of two incompatible `thinking` shapes it accepted, so adapters
  matched on the id and got it wrong twice — in 2.2.1, and again in the 4.0 date-suffix defect
  fixed this release. Wire knowledge is now reviewable data that can be diffed and generated,
  rather than a regex nobody re-reads.

  The bundled catalog carries `wire` for all 14 Anthropic and 12 Google chat models, generated
  from the existing rules so behaviour is unchanged on day one. When the catalog is silent —
  an engine running without one, or an uncatalogued model — adapters fall back to parsing the id
  exactly as before, so nothing breaks. Removing that fallback is a later step, once every model
  is pinned.

- `EngineHandle.createClient(options)` — build an `LLMClient` bound to that engine. Added so
  `plugins/internal-tools` can obtain a client without importing `createLLM` from the helpers
  layer. Additive on a handle callers receive rather than implement.

- `util/hash` — FNV-1a 32-bit, deterministic and dependency-free, for deriving stable short ids
  from content instead of from a clock.

### Changed

- **The module graph is now a DAG.** Two dependency cycles between top-level layers were closed:
  `llm <-> plugins` and `helpers <-> plugins`. They were harmless in TypeScript and are not
  harmless in Rust, where crates cannot express a cycle, so they blocked the port.

  Shared code moved DOWN rather than sideways: the model catalog and its bundled data now live in
  `src/catalog/` instead of `src/plugins/model-catalog/` + `src/llm/providers/*/catalog.json`, and
  image-source normalisation moved from `src/plugins/media/source-image` to `src/util/source-image`.
  Where a lower layer genuinely needs a capability from a higher one it is now passed down instead
  of imported up.

  **No public API changed** — the package has a single root export and every moved symbol is
  re-exported from the same place as before. A new test (`tests/unit/architecture/layers.test.ts`)
  fails if any cycle returns.

- **Internal cleanups carried over from the 1.0 backlog.**
  - `buildContext` read `LLMClient`'s private `queueName` / `configName` / `cacheName` through
    `as unknown as` casts, which compile happily and would silently yield `undefined` the day a
    field is renamed. The client now exposes them deliberately as `client.routing`, so a rename is
    a type error.
  - Telemetry's ten exported types moved from the 1,225-line `telemetry.ts` to
    `plugins/telemetry/types.ts`, matching the rest of the codebase. Re-exported from the old path,
    so no import — public or internal — changed.
  - `sseJson()` in `providers/_shared` replaces the one line every provider's stream parser
    repeated verbatim.

- **`providerOptions` is typed.** It was `Record<string, unknown>` — the one untyped hole in the
  request, and so the one place a typo produced silence rather than an error:
  `promtCacheOptions` type-checked and was simply never sent.

  The new `ProviderOptions` interface documents every key an adapter actually reads
  (`userProfileId`; `moderationPolicy`, `promptCacheOptions`, `reasoningMode`;
  `responseModalities`, `speechConfig`, `imageConfig`, `translationConfig`, `cachedContent`;
  `openrouter`), derived from the read sites rather than invented. Two `as` casts at those sites
  became unnecessary and were removed.

  **Not breaking:** the index signature stays, so an unmodelled key is still accepted — providers
  ship parameters before the SDK models them, and refusing those would make the escape hatch
  useless. What changed is that the keys we do know are checked and discoverable.

- **`AgentLoop.complete()` and `stream()` no longer duplicate their scaffolding.** The two are the
  same loop with different plumbing, and they had drifted into near-duplicates — 167 identical
  lines across ~560. Five shared pieces are now extracted: `recordRunError`, `resolveFinalText`,
  `buildFinalResponse`, `settleRun`, and `buildStepOptions`.

  This is not tidying. The `ctx` block in `buildStepOptions` is what stops one conversation
  arriving at a collector as several unrelated traces; duplicated, a fix to one path would have
  left the other silently splitting. The same applies to the run's final-text rules and its
  error reporting.

  `complete()` 303 -> 234 lines, `stream()` 261 -> 209, identical shared lines 167 -> ~118.
  Behaviour unchanged: all 1,953 tests pass untouched.

### Fixed

- **Anthropic 4.0 models were handed the 4.6+ `thinking` shape.** `anthropicThinkingShape()`
  parsed a model id with `/^claude-[a-z]+-(\d+)(?:[-.](\d+))?/`, so an id carrying a release date
  but no minor version read the date AS the minor: `claude-opus-4-20250514` became major 4 /
  minor 20250514, cleared the `>= 4.6` test, and was sent `thinking: {type:'adaptive'}` — the
  opposite of what the file's own `ANTHROPIC_ADAPTIVE_THINKING_MIN = {major:4, minor:6}` says.

  This never shipped a failure: `claude-opus-4-20250514` and `claude-sonnet-4-20250514` are the
  only affected ids and both are `active: false` in the catalog (deprecated 2026-05-14). It is
  nonetheless the 2.2.1 regression in mirror image, so it is fixed rather than left latent. The
  minor is now bounded to one or two digits and must not be followed by another digit. Checked
  against every id in the catalog plus aliases and future-shaped ids (`claude-opus-4-10`,
  `claude-sonnet-6-1-20270101`): exactly those two change classification, the other 17 are
  untouched.

- **xAI batch creation was not reproducible.** The create call named the batch
  `` `batch_${Date.now()}` ``, which made it the only request in the provider surface that was not
  a pure function of its input: it could not be asserted in a test or reproduced from a log, and a
  retried create produced a second batch under a different name that nothing could deduplicate.
  The name is now derived from the batch contents, so identical submissions produce identical
  requests and differing ones still differ.

- **`google/files` rejected Google's own resource-name format.** `delete()` and `getInfo()`
  normalised the file id only when it contained `/files/` *with* a leading slash — true of the
  full `uri` this adapter returns from `upload()` and `list()`, and false of `files/abc`, the
  canonical `name` the Google API itself returns. Passing that back produced
  `/v1beta/files/files/abc` and a 404.

  It never broke the library's own round-trip, which is why it survived: the only way to reach it
  was to use the provider's own id format. All three forms — full uri, `files/abc`, and a bare
  name — now normalise to the same request.

## [2.2.2] — 2026-08-17

### Fixed

- **Every Gemini model rejected any tool schema carrying `additionalProperties`.** Function
  declarations were sent on Gemini's `parameters` field, which takes a narrow OpenAPI subset and
  rejects anything outside it outright:

  > `Invalid JSON payload received. Unknown name "additionalProperties" at 'tools[0].function_declarations[0].parameters'`

  Since OpenAI strict mode *requires* `additionalProperties: false`, no single tool manifest could
  satisfy both providers — a consuming app had to delete the property, degrading its OpenAI schema,
  to keep Google working. Measured against the live API, the narrow field also rejects `$schema`,
  `$ref`, `$defs`, `definitions`, `const`, `examples`, `exclusiveMinimum`/`Maximum`, `multipleOf`,
  `uniqueItems`, `patternProperties`, `propertyNames`, `if`/`then`, `readOnly`, `deprecated`, and
  `type` given as an array.

  Schemas now go on `parametersJsonSchema`, which takes full JSON Schema unchanged. Sanitising into
  the subset was the obvious alternative and is worse: it silently drops constraints and cannot
  express a `$ref` at all. Verified end to end on every tool-capable model the catalog ships —
  gemini 2.5 pro/flash/flash-lite, 3-flash, 3.1-pro (incl. customtools), 3.1-flash-lite,
  3.5-flash/-lite, 3.6-flash, gemma-4-26b/-31b: 11/11 fail before the change and drive the tool
  after it. The Interactions surface already accepted full JSON Schema and is unchanged.

## [2.2.1] — 2026-08-17

### Fixed

- **Extended thinking returned a 400 on Claude 4.7 and later.** The Anthropic adapter sent
  `thinking: {type:'enabled', budget_tokens: N}` to every model, on the reasoning that it was the
  universally accepted shape — true when written, and since reversed. Anthropic removed
  `budget_tokens` on 4.7+, so Sonnet 5, Opus 5/4.8/4.7 and Fable 5 rejected every thinking request
  outright:

  > `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive"`

  There is no shape that works everywhere: Haiku 4.5, Sonnet 4.5 and the Opus 4.x line have no
  adaptive mode at all and still require the budget (`adaptive thinking is not supported on this
  model`), so a blanket switch would have broken the other half. The shape is now chosen per model
  at 4.6 — the version that accepts both — with `effort` mapping to `output_config.effort` on the
  adaptive side instead of a token budget. An unrecognised model id gets `adaptive`, since
  `budget_tokens` is the shape being retired. Both halves verified against the live API.

- **`complete()` silently dropped `thinking`.** The one-shot helper never declared the option, so a
  reasoning request through the simplest entry point sent no thinking at all while `client.complete()`
  and agents honoured it. Found while live-testing the fix above — the run came back green because
  nothing was being sent.

## [2.2.0] — 2026-08-17

### Added

- **Agents can be named: `label`, `source` and an `attributes` bag.** An unlabelled agent
  exported as a bare `invoke_agent` carrying only a per-process id, so a trace could not say
  which agent ran or be compared across runs. `label` becomes `gen_ai.agent.name` and names
  the span (`invoke_agent briefing`); `source` records which part of the host system the
  agent belongs to, as free text because the taxonomy is the application's; `attributes`
  stamps anything else onto the run. Library attributes win on a key collision, so the bag
  cannot rewrite what a span claims to be.

- **`onTrace` -- an event surface, so this SDK can be one source in a bigger pipeline.**
  Configure it at `createEngine({ telemetry: { types, content, sample, onTrace } })` and take
  the levels you want: an operator reading business traces does not want our HTTP retries,
  and an SDK that ships its own exporter just competes with the pipeline they already run.
  Events carry `traceId` / `spanId` / `parentSpanId`, so a consumer pushes them straight
  into their own tracer. Nothing is sent anywhere by the library.

  Filtering **splices** the tree rather than punching holes in it -- drop `http` and its
  children re-parent to the nearest ancestor that subscriber still receives, because a
  dangling parent renders as a second root. Sampling is per **trace**, hashed from the
  trace id so two services sharing one agree without coordinating; sampling per span would
  shred every tree it touched. Conversation content is off by default and rides on
  `message` events only, never on spans, so spans can go to a metrics backend without
  carrying prompts into it.

- **The SDK can run inside your application's trace.** Pass `ctx.traceparent` -- the W3C header
  shape -- and every span the run emits joins that trace and hangs under that span instead of
  rooting one of its own. A business chain and the model calls it triggers now arrive as one
  request rather than two unrelated traces. A malformed header is ignored rather than fatal.

### Changed

- **Exported spans follow the GenAI semantic conventions.** `agent.run` and `tool.call` export as
  `invoke_agent` and `execute_tool {name}`, carrying `gen_ai.operation.name`, `gen_ai.agent.id`,
  `gen_ai.tool.name` and `gen_ai.tool.call.id`. Names only this library understood forced every
  consumer to write its own mapping; a backend that speaks the conventions now recognises the work
  without one. Internal names are unchanged, so `snapshot()` and the sandbox sidebar group as
  before.

  **If you read span attributes,** three keys moved: `tool.name` → `gen_ai.tool.name`,
  `agent.id` → `gen_ai.agent.id`, `agent.model` → `gen_ai.request.model`. Span *names* in
  `snapshot()` are untouched; only the exported ones changed.

### Fixed

- **Spans had no parent, so a backend drew a flat list instead of a tree.** Every span was a
  sibling, and a turn read as "nine things happened" rather than "a run, which called a tool, which
  asked a second model". Spans now carry `parentSpanId`, resolved to the innermost enclosing
  `agent.run` / `tool.call`, else the caller's span, else none.

- **An agent nested inside a tool call orphaned the run around it.** The enclosing span was tracked
  as one slot per trace, so a second run on the same trace overwrote it and then deleted it on
  close, leaving the rest of the outer run parentless. It is a stack now, and a container is removed
  by id rather than popped, because parallel tool calls close out of order.

- **`traceparent` was dropped at two layers, each by hand-picking fields off the trace.** `beginRun`
  built `{ sessionId, requestId }` and `LLMClient` handed `{ sessionId, requestId, callId }` to the
  network layer. One request became three traces: the model calls joined the caller's, while
  `agent.run`, every `tool.call`, every nested agent and every `http.request` rooted their own. The
  trace now travels whole, and `RunTrace` replaces a shape written inline at eleven signatures.

- **One agent run arrived as several unrelated traces.** The agent built a `runTrace` for its own
  spans and never handed it to the LLM calls it made, so each call fell through to mint-if-absent and
  invented its own `requestId`. Since the trace id is `sessionId:requestId`, a single conversation
  fragmented: measured against a live Grafana Tempo endpoint, one turn with one tool call produced
  SIX traces. Every span looked correct on its own, which is why it survived until telemetry was
  pointed at a real backend.

- **A caller's own trace ids were discarded, then half-honoured.** `ctx.sessionId` / `ctx.requestId`
  now win over the agent's, and the run trace is derived in ONE place from them — deriving it
  separately for agent spans and LLM calls meant a caller passing only `sessionId` split the run in
  two. `ctx.conversationId` likewise wins over the history id instead of being silently overwritten.

- **`agent.run` and `tool.call` spans used an entity id as the trace id** — the run id and the tool
  call id respectively — putting them in a different trace from the work they describe. One span's
  trace id was literally `t1`. MCP spans keyed their trace by server name, merging every call to a
  server over the process lifetime into one eternal trace.

- **Span ids collided once a run shared one trace.** The span KEY (`llm:${traceId}`) doubled as the
  span ID, so every LLM call in a run emitted the same id and the collector merged them into one
  span. Key and id are now separate.




- **`toOtlpTraces()` produced JSON that only LOOKED like OTLP, and no collector would accept it.**
  Trace ids went out as `s:r` and span ids as `llm:s:r` where the protocol requires 16- and 8-byte
  hex; `kind` was the string `'llm'` where it must be the int enum; and every attribute value was
  `String(value)`, so `gen_ai.usage.input_tokens` arrived as text and could not be summed by any
  backend. Ids are now derived deterministically from the readable internal ones, so a trace split
  across two exports still joins up.

- **LLM spans used attribute names no backend recognises.** `gen_ai.provider` / `gen_ai.model` are
  not in the OTel GenAI semantic conventions; the required names are `gen_ai.provider.name` and
  `gen_ai.operation.name`, with `gen_ai.request.model`. A span carrying the old names is not
  identified as a model call at all. Adds `gen_ai.response.model` (the model that actually answered,
  which an alias can change) and `gen_ai.conversation.id` (the agent's history id).

- **Point spans could share an id, and the backend silently dropped the duplicates.**
  `mcp:connect:${server}` repeated on every reconnect and `media:${traceId}` repeated for a second
  image in the same run; `mcp:tool:…:${Date.now()}` collided for two calls in one millisecond. A
  duplicate span id within a trace is invalid OTLP, so those runs looked like they did less work
  than they did.

  The in-memory model is unchanged — `snapshot()` still returns readable ids and the domain `kind`,
  which is what the sandbox groups by. Only the export is translated.

## [2.1.0] — 2026-08-17

Minor, not major: everything below is additive or a bug fix, and no export was removed or
renamed. One caveat worth reading before upgrading — see **`defineTool` optional parameters** under
Fixed, which tightens an inferred type and can therefore surface a compile error in code that was
already wrong at runtime.

### Added

- **Lazy tool loading — register a tool without declaring it.** `lazy: true` on `defineTool`, on an
  `AgentTool`, or on a whole MCP server via `connectMcp(cfg, { lazy: true })`. The tool is registered,
  namespaced and collision-checked exactly as before, but is not placed in the `tools` array: the
  model finds it with a built-in `tool_search`, which returns full schemas as data, and runs it
  through a built-in `call_tool`. Both are declared only when at least one lazy tool exists, so an app
  that never opts in sees nothing new.

  Measured over 308 tools, six tasks, three reps, both providers: identical correctness, **−72%** cost
  per task on `claude-haiku-4.5` and **−97%** on `gpt-5.4-nano`, for one extra round trip. The saving
  is not from caching — it is from never sending the tool block. Schemas arrive in a tool RESULT,
  which lands after the cached prefix, so the declared array never changes and no discovery event can
  invalidate it. Promoting tools into the array instead costs **+63%** versus never deferring.

  **It is not always a win.** Below roughly a hundred richly-schema'd tools it costs more than
  declaring everything, because what remains in the prefix falls under the provider's minimum
  cacheable size while a search round trip is still paid. There is deliberately no automatic
  threshold: whether deferring pays depends on schema size, not tool count.

  `ToolCallReport.toolName` names the tool that actually ran, never `call_tool`, and carries
  `discoveredVia: 'search'`. A new `onToolSearch` hook reports queries, what matched, and — the field
  worth alerting on — which queries matched nothing. Tuning via `lazyTools: { limit, maxSearches }`.

- **`CostSummary.unpriced` / `.unpricedModels` — a $0.00 total no longer hides a failed lookup.** A
  model with no catalog entry was priced at zero and summed into every total, so a report read $0.00
  when it meant "could not price this", and a budget built on that total silently never fired. The
  per-entry `cost.source: 'unknown'` tag already recorded it; nothing aggregated it. The collector
  now also emits one `onWarning` per unknown model (`code: 'unpriced_model'`) — once per model, not
  per request. Genuinely free calls are unaffected: they are priced `'calculated'` at zero with a
  note. The usual cause is a model id that reaches the provider but is not a catalog key, e.g.
  `anthropic/claude-haiku-4-5` against the catalog's `anthropic/claude-haiku-4.5`.
- **`strictSupport(schema, dialect)` — ask whether a schema can satisfy a provider's strict mode.**
  Returns `{ ok, reason }`, where `reason` names the property or keyword responsible. Exported
  because the answer differs per provider and was otherwise only discoverable by getting a 400.
- **`complete({ seed, topK })` and `CompleteResult.error`.** All three existed on `LLMClient` and the
  agent path but not on the one-shot helper, so a documented example demonstrating them did not
  compile. `error` surfaces the in-band failure some providers report instead of throwing (OpenAI
  Responses `status: 'failed'`), which otherwise reads as a successful empty answer.

- **`complete({ cache })` — prompt caching is reachable from the one-shot helper.** `CompleteOptions`
  had no `cache` field at all, so asking for it did nothing: the option was dropped in silence, with
  no error and no warning, while `LLMClient` and every adapter supported it fully. It matters most
  exactly where this helper is convenient — a long system prompt or a large tool block, which sit at
  the front of the request and are the cheapest part to cache.
  - Found by a benchmark that reported zero cached tokens for every arm it measured.

### Fixed

- **Any OpenAI tool with an OPTIONAL parameter was rejected outright.** The library forced
  `strict: true` on every function tool while sending the schema as written. OpenAI's strict mode
  requires every property to appear in `required`, at every nesting level, and answers a schema that
  does not with `400 Invalid schema: 'required' is required to be supplied` — never a degraded
  result. So `defineTool({ optional: [...] })`, a documented feature, could not be used on OpenAI at
  all, and neither could most MCP servers. The same forcing applied to structured output on both
  OpenAI APIs.

  On Responses, where strict has long been the default, it is now requested only where the schema
  can satisfy the provider. Elsewhere it stays OPT-IN — see the next entry. The rules differ per
  provider, measured live rather than read off the docs:

  | | OpenAI | Anthropic |
  |---|---|---|
  | optional properties (not in `required`) | rejected | fine |
  | `minimum` / `maximum` / `exclusive*` / `multipleOf` / `maxItems` | fine | rejected |
  | `additionalProperties: true` | rejected | rejected |
  | `{ type: 'object' }` with no `properties` key | rejected | fine |
  | more than 20 strict tools per request | fine | rejected |

  Two consequences: a generic router tool — one whose parameter must accept any shape — can never
  be strict, and past Anthropic's cap the defaulted tools give up strict together rather than the
  first 20 keeping it by array order. Passing `strict` explicitly still wins in either direction,
  including past the cap. A no-argument tool is unaffected: `properties: {}` is present but empty,
  which both providers accept.

  Nothing caught this because nothing executed it: every example declared its tool parameters as
  required, and the MCP server used throughout the corpus marks everything required. Typecheck,
  API snapshot, doc-snippet compilation and consumer install all passed on code the API refuses.

- **Strict stays OPT-IN on Anthropic and OpenAI Chat Completions.** It was briefly defaulted on
  during this cycle and reverted before release, so behaviour on both is unchanged from 2.0.1.

  What decided it: strict makes no measurable difference to argument quality — 40 of 40 calls
  conformed with it and without it on both providers, including prompts written to pull away from
  the schema. Its one real effect is that Anthropic then refuses to call a tool that was never
  declared (10/10 undeclared without it, 0/10 with it), and that only matters when something puts
  an undeclared tool in front of the model, which ordinary use does not.

  Against that, Anthropic's strict mode carries limits no per-schema check can predict: at most 20
  strict tools per request, at most 24 optional parameters summed across all strict schemas
  (nested ones included), and an opaque complexity limit on top — 24 optional parameters spread
  over four tools compiles, the same 24 in one tool answers "Schema is too complex for
  compilation". Twelve ordinary tools with five optional parameters each already exceed the second.
  The first two are aggregates, so they cannot live in a per-schema predicate; the third has no
  published formula. Opt-in is the only honest default there.

- **`defineTool` typed optional parameters as always present.** Keys listed in `optional` inferred as
  required in the `execute` args, so `args.unit.toUpperCase()` typechecked and threw at runtime on
  every call where the model omitted the argument — the expected case for an optional argument. They
  now infer as `| undefined`.

- **`complete()` sent different options depending on whether `tools` was passed.** The helper has two
  branches, and the tools branch forwarded only `structured` — silently dropping `providerOptions`,
  `audio`, `outputModalities` and `serviceTier`, which the no-tools branch honoured. Adding a tool to
  a working call could therefore change behaviour that has nothing to do with tools. Both branches
  now forward the same set.

### Added

- **MCP tool definitions carry what the spec publishes.** `McpToolDef` now models `annotations`
  (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`), `icons`, `execution`
  and `_meta`. The data always arrived — `tools/list` results are passed through unparsed — but was
  untyped, so a host could not act on it without a cast. These stay **host-facing**: no provider's
  function-tool schema has a field that could carry them, so none is sent to the model.
  - `execution.taskSupport: 'required'` means the tool MUST be invoked as a task. Task invocation is
    not implemented, so such a tool cannot be called through this client — the field being visible is
    what lets a caller see that instead of meeting it as a server error.
- **MCP `outputSchema` reaches the model when asked for** — `connectMcp(cfg, { validateOutput: true })`.
  It was read for local validation only, while OpenAI Responses accepts `output_schema` and the
  library already emitted it for hand-written tools; the two ends were never connected.
  - **Opt-in, because declaring it is a promise about the RESULT.** OpenAI then rejects the turn
    — *"expected a JSON string because the function declares output_schema"* — unless the result is
    JSON matching that schema, so the tool result changes from prose to structured data. MCP returns
    `structuredContent` exactly when a tool publishes `outputSchema`, and that is now what comes
    back — under the same flag, so nothing changes for anyone who did not ask for it.
  - Verified end to end against a live MCP server through OpenAI Responses, in both modes.
- **`moderate()` now returns the shape of its input.** Overloads: one input (a string, or one
  content-part array forming a single multimodal item) returns a `ModerationResult`; a list of
  inputs returns `ModerationResult[]`. The mapping was documented in prose from the start but the
  signature returned the bare union, so `result.flagged` was a type error and **every documented
  example failed to compile**. The wide-union overload is kept, so code that already narrows still
  compiles. No runtime change.
- **`toolKey` / `describeTool` are exported.** `AgentTool.definition` is a `Tool` union (function
  tool or builtin), so `.name` does not exist on it; reading a tool's name previously required
  hand-narrowing at every call site.
- **`createEngine({ retry })` — retry policy configurable where it belongs.** The machinery existed
  and worked, but the only way to reach it was hand-building an `HttpRequest`; nothing on
  `createEngine()` exposed it. Retry is cross-cutting, so it is now an engine-level setting inherited
  by every queue, with `createEngine({ queues })` for one provider and `HttpRequest.retry` for one
  request. Nested groups (`backoff`, `perKind`) merge rather than replace, so overriding one knob
  does not reset the schedule.
  - New type `RetryPolicyOverride`. `Partial<RetryConfig>` only makes top-level keys optional, so it
    still demanded a complete `backoff` — the partial override the merge always supported was not
    expressible. Engine, queue and `mergeRetry` now take the deeper-partial type; strictly wider, so
    existing config keeps compiling.
  - Additive: omitting all of it is byte-identical to before.

### Fixed

- **Docs: the per-request retry sample could never compile.** `docs/guide/network.md` showed
  `complete({ retry: { attempts, initialDelay, maxDelay, expBase, httpStatusCodes } })`. `complete()`
  takes no `retry` option (`TS2353`), and not one of those field names exists on
  `RequestRetryOverride` — the real fields are `maxRetries` / `totalTimeoutMs` / `attemptTimeoutMs` /
  `maxRetryAfterMs` / `backoff{initialMs,maxMs,multiplier,jitter}`, and the override rides on
  `engine.fetch()`. The feature was always correct; only its documentation was wrong. Same class as
  the 2.0.0 `agent.run()` defect, on an option object rather than a method, which is why the
  consumer-surface check did not see it.

- **MCP result cache: `ttlMs: 0` now evicts.** The hint was documented as "immediately stale — not
  the same as absent", but `set()` funnelled it through the same branch as a missing hint and stored
  nothing. Any entry already held survived, so a server that said "cache for 60s" and later "stale
  now" kept being answered from the stale entry for the rest of the original TTL — the instruction
  was accepted and inert. A non-positive `ttlMs` now drops the entry for that key. Absent hints are
  unchanged and still leave an existing entry alone, so pre-2026 servers behave exactly as before.
  - The existing unit test asserted `set(…, { ttlMs: 0 })` returned `false` and `get` was
    `undefined` — on an *empty* cache, where that holds whether or not the hint does anything. It
    passed for the wrong reason. Found by writing the MCP protocol example as a consumer.

## [2.0.1] - 2026-08-10

Three defects reported by a consumer within a day of 2.0.0 — all reachable by reading the shipped
`.d.ts`, none caught by our gate. See the note at the end.

### Fixed

- **`agent.stream()` now carries `phase` on text events.** The raw stream event had it, and the
  agent mapper *used* it internally to keep commentary out of the answer — then yielded both deltas
  through one `{ type: 'text', text }` with the phase stripped. A UI streaming those straight
  through put the model's thinking-aloud into the transcript **as if it were the reply**, with no
  way to tell them apart. `finalAnswerText()` could not help: it takes a finished message's
  `content`, not deltas.
  - Additive: `phase` is **absent** (not `undefined`) when the provider reports none, so every
    non-codex provider is byte-identical to before.
- **Docs: `agent.run()` does not exist.** The agent-loop guide recommended it for a non-throwing
  report. The class exposes `stop` / `complete` / `structuredComplete` / `stream`; the report is
  reached with `try/catch` + `agent.lastReport`. The guide now shows that.
- **Docs: the 2.0.0 changelog overstated live commentary.** It said commentary "is still yielded to
  the consumer (a UI may well want to render it live)" — true only in the sense that the bytes
  arrived; they were unlabelled, so a UI could not act on them. The 2.0.0 entry now says so and
  points here.

### Why this got out

The feature was verified end-to-end on the **buffered** path (`finalAnswerText`, `response.text`,
live-tested against real models) and never once from the **layer most consumers actually call**.
1778 tests, four MCP transports and two live corpora, and no check that a shipped type was usable
from `agent.stream()`. The gate was deep where it was pointed and blind where it was not — so the
release checklist now includes a consumer-surface pass over the published `.d.ts`.

## [2.0.0] - 2026-08-09

**Upgrading:** three things can require action, and none of them is a provider change — that is the
point of the facade. (1) Node **22+** is now required. (2) `tiktoken` is an optional **peer**: run
`npm i tiktoken` only if you use exact local OpenAI token counting. (3) If you switch exhaustively
over `FinishReason` or `ContentPart` without a `default` branch, add one — both are open by design
(CONSTITUTION R1) so future provider values arrive additively instead of breaking your build. The
only changed signature is `OpenAITranscriptionAdapter.transcribe()`, which now returns an object;
read `.text`. The `transcribe()` helper is unaffected. Full detail: [MIGRATION.md](./MIGRATION.md).

### Changed — packaging (install/runtime level; no source change for consumers)

- **Node floor raised to `>=22`** (was `>=18`). Node 18 and 20 are both end-of-life; 22 is also the
  floor `openai-node` 7 adopted.
- **`tiktoken` is now an OPTIONAL PEER dependency**, not an `optionalDependency`.
  `optionalDependencies` means *"do not fail the install if this package fails to build"* — npm
  installs it regardless, so every consumer received its ~5.6 MB wasm file. **If you use exact
  OpenAI token counting, run `npm i tiktoken`**; the error thrown when it is missing names the
  package and the alternatives (count-API and heuristic counters need no extra packages).
- **The wasm no longer lands in consumer bundles.** The dynamic import used a string literal, which
  every bundler resolves during module-graph construction — so the blob was emitted even for code
  paths that were never reached (one consumer reported it as **88% of their production output**).
  `sideEffects: false` cannot prevent this: emitting a dynamic-import chunk is a graph-resolution
  outcome, not dead-code elimination. The specifier now lives in a variable, opaque to bundlers and
  resolved identically at runtime. Verified with a control — a literal import emits a 5.3 MB
  `.wasm`; the shipped build emits none, even when the consumer imports `ContextMeasurer` directly
  and has `tiktoken` installed.
- **`tiktoken` still works in the browser.** It ships a wasm/ESM build that bundlers resolve for
  browser targets, so it is deliberately *not* stubbed out of `index.browser.js`.
- **`HybridTokenCounter` builds its tiktoken counter lazily**, on first route to that strategy,
  rather than in the constructor.
- **The "zero dependencies" claim is now qualified** as *zero **required** runtime dependencies*.
  `dependencies` genuinely is empty, but a consumer reading only that field concluded there were no
  runtime packages at all.

### Added — MCP speaks both protocol eras

`mcp` 2.0.0 shipped the **2026-07-28 revision**, which is not additive: it deletes the `initialize`
handshake, the session id, and the whole server→client back-channel. Real servers are still almost
entirely on 2025-11-25, so this is **dual-era or it is a regression** — both wires are supported and
neither is preferred.

**Verified against a real server, on every transport.** The modern wire was developed against our
own test doubles, which is not evidence: a shape that satisfies a fake can still be rejected by a
real implementation. Before release the whole surface was run against the official
`mcp` 2.0.0 Python server — negotiation, tools, resources, prompts, MRTR, `subscriptions/listen`
with live change events, result caching and era gating — over **stdio, Streamable HTTP and
WebSocket**, plus a real 2025-11-25 server (DeepWiki) to prove the fallback. That exercise found
six defects that no unit test could have caught, four of which failed *silently*: the per-request
`_meta` identity envelope was missing (on ordinary requests, and separately on the long-lived
`subscriptions/listen` POST, where the rejection surfaced as the stream simply ending — so `listen()`
returned a subscription that looked alive and delivered nothing); `connectMcp` never forwarded
`cacheResults`, making the opt-in cache a no-op; the discover probe omitted the
`MCP-Protocol-Version` header that modern servers route on; the routing headers keyed off an era
that is not yet set during the probe; and the long-lived POST accepted only `text/event-stream`,
which a modern server answers with `406`. All are fixed and pinned by regression tests.

- **`server/discover` negotiation with handshake fallback.** `ConnectMcpOptions.protocolMode`:
  `'auto'` (default) probes the modern wire and falls back to `initialize`; `'legacy'` skips the
  probe entirely (byte-identical to 1.x); a version string adopts that revision directly.
- **The fallback is a denylist, not an allowlist.** *Every* JSON-RPC error falls back to the
  handshake, except a `-32022` whose `supported` list is modern-only and shares nothing with us —
  a genuine incompatibility that must surface rather than be papered over. **Transport and network
  errors are never treated as an era verdict**: silently downgrading the wire because a socket
  blipped would be the worst available failure mode.
- **`McpClient.info` is unchanged on both wires.** A modern server has no `initialize` result, so
  one is synthesised from the discover result and its `_meta` server-info stamp. Callers never
  branch on the era (CONSTITUTION.md R2 — absorb the difference, never expose a union). The stamp is
  display-only per spec, so absent *or* malformed degrades to a placeholder instead of failing the
  connection.
- **New (additive):** `McpClient.protocolVersion`, `.era`, `.discoverResult`, the
  `McpDiscoverResult` type, and the version registry (`MCP_KNOWN_PROTOCOL_VERSIONS`,
  `mcpEraOf`, …). Versions are treated as an **enumerated set, not an ordered scalar** — comparing
  `'zzz' > '2025-11-25'` is true and meaningless, so era questions go through the registry.
- **Methods the revision removed are gated by era.** `logging/setLevel` and `resources/subscribe`
  throw on a modern session with a message naming the negotiated version and the replacement,
  instead of letting the server answer a bare `-32601`. The `ping` keep-alive is not started on a
  modern session. All of them are untouched on a handshake session.
- **A 4xx carrying a JSON-RPC error body no longer loses it.** The HTTP transport collapsed every
  4xx into `ConnectionClosed`, which discarded exactly the `-32022` that negotiation depends on — a
  modern-only server looked like a dead connection.
- New error codes: `HeaderMismatch` (-32020), `MissingRequiredClientCapability` (-32021),
  `UnsupportedProtocolVersion` (-32022).

**Multi-round-trip requests (MRTR, SEP-2322)** — the modern replacement for the back-channel. Where
a handshake-era server *pushes* a `sampling/createMessage` at us mid-call, a 2026-07-28 server
*returns* `resultType: 'input_required'` with the questions it needs answered, and the client
re-issues the same call carrying the answers plus the server's opaque `requestState`.

- **One handler serves both wires.** MRTR is dispatched through the same `onServerRequest` path as
  a pushed request, so a caller who wired up sampling/elicitation/roots once gets it on either wire
  without knowing which is in play.
- **`McpCallResult` did not become a union.** Upstream models this as a separate
  `InputRequiredResult`, which would break every consumer reading `.content`. We attach
  `resultType` / `inputRequests` / `requestState` as optional fields instead (CONSTITUTION.md R2).
  An **absent `resultType` reads as `'complete'`**, so every pre-2026 result behaves exactly as
  before and costs no extra round-trip.
- Applied to `tools/call`, `prompts/get` and `resources/read`. `requestState` is echoed back
  byte-exact and never inspected.
- A leg carrying state but no questions backs off (50 ms doubling to a 250 ms cap, reset by any leg
  with real questions) rather than spinning against the server.
- `inputRequiredMaxRounds` (default **10**, matching the other SDKs) bounds the loop, because a
  handler that never satisfies the server would otherwise retry forever.

**`subscriptions/listen` (SEP-2575)** — the single change-notification stream that replaces
`resources/subscribe` and the standalone notification channel at 2026-07-28.

- `McpClient.listen(filter, onEvent)` returns an `McpSubscription`. Every kind is **opt-in**
  (`toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions[]`) and
  the server acknowledges with the subset it actually honoured — which **can be narrower than what
  was requested**, so `subscription.honored` / `isHonored(kind)` is worth checking rather than
  assuming. Frames are attributed by the `io.modelcontextprotocol/subscriptionId` stamp, so frames
  for another subscription are ignored.
- Refused with a clear error on a handshake session, which keeps `subscribeResource()` the right
  answer there instead of silently returning a subscription that never fires.
- **Works on every transport** — stdio, WebSocket and Streamable HTTP. On HTTP a listen is a POST
  whose *response body* is the long-lived stream, so it goes through the streaming fetch rather than
  the buffered POST path (which would surface frames only once the stream closed — i.e. never, for
  a healthy subscription). Frames route identically on all three, so the client sees no difference.
- **The end of a stream is observable.** `subscription.active` / `.ended` report whether the stream
  is still live and, if not, the error that killed it — a rejected subscription, a dropped
  connection, or a clean server-side teardown. A subscription that silently stopped delivering is
  otherwise indistinguishable from one where nothing has changed yet; failures also surface on the
  `onMcpError` hook. `close()` on the client tears down every open stream.

**Hardening**

- **The stdio read buffer is bounded** (`maxBufferSize`, default **10 MB**, matching mcp-ts 1.30).
  JSON-RPC over stdio is newline-delimited, so a server that never emits `\n` — a crash dump, a
  binary blob on the wrong stream, a runaway log line — grew the buffer until the process died.
  The limit applies to a single *unterminated* line, so a large burst of complete messages is
  unaffected; on overflow the pending requests fail with a message naming the likely cause.
- **`Content-Type` is compared by media-type essence, not substring.** `contentType.includes(...)`
  routed anything merely *containing* `text/event-stream` — e.g. `application/json;
  profile="text/event-stream"` — into the SSE parser.
- **RFC 9207 `iss` validation** on the OAuth authorization response, checked **before** the code is
  redeemed. This is the mix-up-attack defence: without it a malicious authorization server can hand
  back a code minted by a different server and have the client replay the user's credentials
  against it. Comparison is exact string equality per §2.4 — deliberately *not* URL-normalised,
  since that leniency is what an attacker looks for. A **missing** `iss` is rejected when the server
  advertises `authorization_response_iss_parameter_supported`, otherwise stripping the parameter
  would skip the check. Pass it via `finishMcpAuth(..., { iss })`; optional, so existing callers
  keep working.
- **`application_type: 'native'` is sent at dynamic client registration** (SEP-837). MCP clients are
  normally local processes with a loopback redirect, and some authorization servers apply stricter
  redirect-URI rules when the type is left to be guessed as `web`. An explicit value from the caller
  still wins.
- **The WebSocket transport is kept** and now documents itself as non-standard. Upstream removed
  theirs as "never part of the MCP specification"; ours is public API we shipped, and an upstream
  deletion is not our deletion (R7). It is also duplex, so it supports `subscriptions/listen` today.

**Result cache hints (`ttlMs` / `cacheScope`)** — opt-in via `cacheResults`, off by default.
Settable on `connectMcp(config, { cacheResults: true })` as well as on `McpClient` directly, along
with `inputRequiredMaxRounds`.

- Honours the server's freshness hint on `tools/list`, `prompts/list`, `resources/list`,
  `resources/templates/list` and `resources/read`. **A server that sends no hints caches nothing**,
  so this is a no-op against every pre-2026 server.
- **`ttlMs: 0` means "immediately stale"** — a real instruction, not a missing value to be replaced
  with a default.
- A paginated list is only as fresh as its shortest-lived page, so the effective TTL is the
  **minimum** across pages.
- Entries are dropped on the matching `*_changed` notification **before** the caller's handler
  runs, so a handler that re-lists synchronously never reads a stale entry. A
  `notifications/resources/updated` drops only the named resource.
- `cacheScope` is recorded but never used to widen sharing: this cache lives inside one client with
  one credential, where `public` buys nothing.

### Changed — `FinishReason` is now an OPEN union

- **`FinishReason` = `KnownFinishReason | (string & {})`.** Providers keep inventing terminal
  states — four did so in a single upstream cycle — and against a closed union every one of those is
  a breaking change for **every** consumer, including consumers of providers that changed nothing.
  Opening it is what CONSTITUTION.md R1 exists for, and it means this is the **last** time this type
  breaks anyone. Write a `default` branch; use `KnownFinishReason` for the documented set alone.
- **New known value `'malformed_tool_call'`** — the model tried to call a tool and produced
  something unusable. Distinct from `error` (the request failed) and `tool_use` (a call we can
  run), because this one is *recoverable*.
- **Google's `MALFORMED_FUNCTION_CALL` is now mapped.** It previously wasn't mapped at all, so it
  fell through to `'stop'`: a turn where the model failed to produce a usable tool call looked like
  a clean finish with no content.

### Added — agent + network

- **`reflectAndRetry` on `AgentLoop`** (google-adk 2.6 `ReflectAndRetryModelPlugin`).
  Self-healing recovery from a model failure the model itself can fix: it receives structured
  guidance naming the attempt and forbidding an identical retry, then the step runs again within a
  bounded budget. **Off unless configured** — a retry costs a real request.
  - **Not a network retry.** The engine already retries transport failures; this is for a request
    that *succeeded* and came back unusable, which resending unchanged would never fix.
  - The failed turn is **not appended to history**, so the model never learns from its own broken
    output; usage from it *is* counted, because a wasted turn still costs money.
  - Counts **consecutive** failures, so an agent that recovers and fails again later gets a fresh
    budget rather than inheriting a spent one.
  - `throwIfExceeded` (default `true`) decides raise-vs-return when the budget is spent; the error
    names the option so the alternative is discoverable.

- **`checkProvenance()`** — detect provider provenance signals in a file (C2PA manifest, SynthID
  watermark) via OpenAI's new `POST /v1/content_provenance_checks`. Bytes in, structured verdict
  out, same shape as `moderate()`, with an honest-zero cost entry so the ledger records the call.
  It is the only "was this AI-generated" primitive any tracked SDK ships.
  - The result separates **`detected`** from **`trusted`**, and the docs say why: signals are
    strippable — a re-encode, crop or screenshot usually removes them — so `detected: false` is
    absence of evidence, not evidence a human made the file. Only a detected manifest that
    *validated* is a positive statement.
  - `detected` is true if ANY signal fired: audio carries SynthID only, so requiring both schemes
    would report every audio file as clean.
- **`AnchoredStrategy`** for ContextGuard — one growing scratchpad instead of a chain of summaries
  (ported from google-adk 1.5 `AnchoredContextCompactor`). `LayeredStrategy` emits a new summary
  per compaction, so old facts get summarised repeatedly and drift; anchored merges each compaction
  into a single head entry, so every fact is summarised from raw text exactly once. The trade is
  stated in the file: one anchor means one blast radius.
  - **Never splits a tool call from its result.** The retain boundary walks backwards past a
    `tool_result` whose `tool_call` would be cut away — several providers reject an orphaned
    result outright and the rest silently misread it.
  - **A summariser returning nothing declines rather than dropping entries**: trading a context
    overflow for silent data loss is strictly worse.

- **`toolNameCollisionPolicy`** on `AgentLoop` (`'warn'` default, `'error'`). Tools are registered
  in a map keyed by function name / builtin type, so two tools sharing a key meant one **silently
  replaced** the other and the model never saw it — surfacing much later as "the model called the
  wrong tool", with nothing in the logs pointing at the cause. `'warn'` keeps last-write-wins (an
  app relying on a deliberate override still works — R4) but emits an `onWarning`
  (`code: 'tool_name_collision'`) naming the key and which tool lost; `'error'` throws at
  construction or `addTool()`, before the model is called. Re-registering the *same* tool object is
  not a collision.
- **Per-request retry overrides** — `HttpRequest.retry` (`maxRetries`, `totalTimeoutMs`,
  `attemptTimeoutMs`, `maxRetryAfterMs`, `backoff`). A queue's retry policy is shared by every call
  on it, so a one-off that needs to be more or less patient — a long batch submit, a health check
  that should fail fast — previously had to accept the shared policy or get its own queue. Mirrors
  Google moving `retryOptions` from client-level to per-request `HttpOptions` (google-ts 2.15).
  `perKind` deliberately stays queue-level: one request cannot redefine which error classes are
  retryable for everyone sharing the queue. Precedence is per-request → per-kind → queue default.

### Added — OpenAI Responses parity

- **Assistant `phase` (`commentary` | `final_answer`)** on `TextPart` and on streamed text events.
  Codex-family models narrate before answering; `response.text` concatenates both, so **an agent's
  final output used to include its own thinking-out-loud**. `AgentLoop` now derives its answer with
  the new `finalAnswerText()` helper, which drops commentary. `response.text` and `contentText()`
  are unchanged — callers who want everything still get everything.
  - Open union (R1), and `finalAnswerText` excludes only what is explicitly `'commentary'` rather
    than keeping only `'final_answer'`: the day a provider adds a third phase, an allow-list would
    silently drop the answer.
  - Streaming carries it too. `phase` is announced once on `response.output_item.added` and belongs
    on every delta of that item, so the parser keeps per-stream item→phase state; concurrent streams
    cannot leak phases into each other. Commentary is yielded to the consumer and preserved in the
    assembled content as its own phase-tagged part. (In 2.0.0 the agent-layer event dropped the
    phase, so a UI could not act on it — corrected in 2.0.1.)
  - Nothing is inferred: a model that reports no phase produces parts with no phase, exactly as
    before.
- **`name` + `namespace` on `function_call_output`.** The tool name is taken from the matching
  call — tracked across messages while building the input, never invented, so a result with no
  matching call simply omits it. `ToolResultPart.namespace` round-trips the namespace of a
  namespaced tool. Probe-verified 2026-08-06: accepted, and a non-string `namespace` is rejected,
  so the fields are validated rather than tolerated.

### Added — programmatic tool calling (the model writes code that calls your tools)

A model can now write a short program that orchestrates your tools itself, instead of
emitting one call at a time and waiting for each result. Previously the `program` items
in the response were dropped on the floor.

- **`ToolCaller` on `ToolCallPart` and `ToolResultPart`** — `{ type: 'direct' | 'program',
  callerId? }`. Absent means what it always meant (the model called the tool itself), so
  nothing changes for existing code. Open union with an optional payload rather than
  `{type:'direct'} | {type:'program', callerId}` (R1 + R2), so a future caller kind is
  additive; an unknown type is preserved rather than flattened to `direct`.
- **`ProgramCallPart` (`program_call`) and `ProgramResultPart` (`program_result`)** —
  the code the model wrote, and what it returned. The code is plain readable JavaScript
  and worth surfacing: it is the plan the model is executing.
- **`allowedCallers` is now enforced locally**, not only by the provider. A tool without
  it is `direct`-only, so model-written code cannot reach a tool that never opted in. A
  violation denies that one call with an error result to the model — the way a guardrail
  trip does — rather than ending the run.
- **Round-tripping is the whole feature**, and three wire rules make it work (all found
  live, none of them in any SDK's types):
  - The `program` item is **rejected without the `reasoning` item that produced it**, so
    that item is captured and re-emitted with it.
  - **Dropping the program item is worse than an error**: the model silently re-emits the
    program and runs it again from the start.
  - `program_output` **requires its `id`** when replayed as history — unlike
    `function_call_output`, which needs none. Without it a follow-up question 400s on a
    conversation that had just succeeded.
- **Availability, checked model by model:** of the 53 gpt-5 / o3 / o4 / codex models
  visible on the test account, only the **`gpt-5.6` family** (`luna`, `sol`, `terra`)
  accepts the `programmatic_tool_calling` tool. Every other one returns
  *"Tool 'programmatic_tool_calling' is not supported with &lt;model&gt;"*.

### Added — structured transcription

`transcribe()` returned `{ text }` and nothing else, so segments, speakers and word timings that
the provider had already computed were parsed and thrown away.

- **New request options:** `keywords` (spelling control for names and jargon), `languages`
  (candidate languages when the language is unknown), `wordTimestamps`, and `diarization`.
- **New response fields, all optional:** `segments` (with `speaker` when diarizing), `words`,
  detected `languages`, and `durationSeconds`. **`text` stays required** (R3), so existing code is
  untouched — the additions appear only when the chosen model produces them.
- **Behaviourally verified, not just accepted** (E2). `keywords` changes the transcript: an invented
  name that comes back as *"Zalbrequist"* without it comes back as *"Zylberquist"* with it, on
  identical audio. `languages` changes what the model reports detecting, and an invalid code is
  rejected. Both are `gpt-transcribe`-only; word timings are `whisper-1`-only; speaker labels are
  `gpt-4o-transcribe-diarize`-only. **No model returns speakers and word timings together**, so
  combining `wordTimestamps` with `diarization` throws before any request is sent.
- **Model-gated options are still sent.** A field the chosen model rejects produces a 400 naming
  the parameter, rather than being dropped on our side — the caller learns their keywords did
  nothing (R4: gating is internal, but silence is not a gate). On generateContent providers, which
  have no structured endpoint at all, the same request emits an `onWarning`
  (`transcription_option_unsupported`).
- **Transcription cost is now measured, not estimated.** These models return the audio duration
  they billed for (`usage.seconds`, or a top-level `duration`), which is used when the caller
  supplies none. Previously a non-WAV file with no `audioDurationSeconds` could only produce an
  honest zero.
- **Google's equivalent is deliberately absent.** `audioTranscriptionConfig` is accepted *and
  type-validated* by the Gemini Developer API and then completely ignored: a two-speaker round-trip
  returned a response structurally identical to the control — no `speakerLabel`, no `words[]`
  anywhere (2026-08-09). It is the second confirmed accepted-but-inert field after `top_k`. Shipping
  it on the strength of the green probe would have meant a diarization feature that silently
  returns nothing.

**Breaking (2.0):** `OpenAITranscriptionAdapter.transcribe()` returns
`OpenAITranscriptionResult` instead of `string`; read `.text`. The `transcribe()` helper is
unaffected — it already returned an object.

### Fixed — correctness

- **Parallel tool calls were broken on every chat-completions backend.** The loop answers a round
  of parallel calls with one tool message holding a `tool_result` part per call, and this API wants
  a separate `{role:'tool'}` message per `tool_call_id` — but only the **first** was emitted. Every
  call after the first went unanswered and the provider rejected the whole request with
  *"No tool output found for function call &lt;id&gt;"*. Affected OpenRouter and any use of
  `api: 'completions'` on OpenAI/xAI; the Responses path was always correct. Present in 1.7.0 and
  earlier; found by running the examples corpus, not by a unit test.
- **`serviceTier: 'fast'` is actually sent to OpenAI.** The value shipped in openai-ts 7.x but was
  missing from our known-tier set, so `openaiRequestTier('fast')` fell through to `'auto'` — a
  caller asking for Fast mode silently got the project default, with no error and no warning.
  Probe-verified on `gpt-5.5`: `fast` accepted, `hyperfast` rejected, so the value is validated
  rather than merely tolerated. Applies to Responses and chat-completions.
- **A `Retry-After` longer than we will honour now fails fast instead of parking the request.** New
  config `RetryConfig.maxRetryAfterMs` (default **120s**). Previously an un-capped value was obeyed
  verbatim: `Retry-After: 86400` held the request for a day, which from the caller's side is
  indistinguishable from a hang. Worse, on the rate-limit path it also paused the **entire**
  limiter — every request on that queue, not just the one that was throttled. Both paths are now
  clamped, and an over-cap value is treated as a refusal rather than a delay.
- **`Retry-After` parsing hardened.** The HTTP-date form (RFC 9110) is now parsed instead of being
  silently ignored, and malformed values (`NaN`, negative, non-finite, a past date) are discarded
  rather than propagated — `setTimeout(fn, NaN)` fires immediately, which turned one bad header
  into an instant retry storm.

### Unchanged, deliberately

- **Google Interactions keeps sending `temperature` and `top_p`.** google 2.15 deleted both from its
  Interactions `GenerationConfig` type, which resembles the pattern behind two earlier live
  breakages — but the wire disagrees: probed 2026-08-06 on `gemini-3.6-flash`, both are accepted
  (200) and *validated* (`"warm"` / `-7` → 400). The removal is SDK-typing-only; stripping them
  would have been the regression. Recorded at the call site so a later cycle does not "fix" it.

---

Upstream reconciliation for the 2026-07-27 clone refresh (10 SDKs). This batch is dominated by
**terminal-state correctness**: three providers widened response enums that our adapters silently
flattened to `'stop'`, so a caller could not distinguish a refusal, a context overflow, a queued
interaction or an outright failure from a clean finish.

### Fixed
- **Google Interactions no longer sends `cached_content`.** google 2.13 removed it from the
  Interactions request model and the endpoint now hard-rejects it — live-probed:
  `400 Unknown parameter 'cached_content'`. Any call passing `providerOptions.cachedContent` on
  Interactions failed outright. The passthrough **moved to `generateContent`**, which still accepts
  and validates it (top-level `cachedContent`), so the capability is preserved rather than dropped.
- **Anthropic `refusal` → `finishReason: 'content_filter'`** (was `'stop'`). A safety decline is a
  block, not a clean finish; it now lines up with every other provider's block signal. The refusal
  category enum also gained `general_harms` (anthropic 0.115).
- **Anthropic `model_context_window_exceeded` → `finishReason: 'length'`** (was `'stop'`), on both
  the buffered and streamed reason maps.
- **OpenAI Responses `status: 'failed'` → `finishReason: 'error'`** (was `'stop'`), and `cancelled`
  → `'error'`. A Responses call can fail *inside a 200*, so there was no exception to catch and the
  caller silently received an empty success.
- **Google Interactions `queued` no longer ends a stream.** The status is non-terminal, but the
  stream parser emitted a terminal `done` for it, truncating the run.

### Security
- **`TelemetryAdapter` can redact provider error text.** New option
  `includeSensitiveData` (default `true` — unchanged behaviour, and the same default as the OpenAI
  Agents SDK's `trace_include_sensitive_data`). A provider's `error.message`/`error.raw` can echo
  request content back (a refusal quotes the prompt, a validation error names the field and value),
  and we stored it verbatim. With `includeSensitiveData: false` the message becomes `***REDACTED***`
  and `raw` is dropped, while `name`/`code`/`status` are kept so traces stay triageable. URLs and
  headers were, and remain, always redacted.

### Fixed (hardening)
- **SSE streams are now cancelled, not just unlocked.** `parseSSEStream` released the reader lock in
  its `finally` but never cancelled the body, so a consumer that broke out early (abort, error, or a
  `break` after the first token) left the HTTP response open until GC. Verified live on Anthropic,
  OpenAI and Google: full streams unchanged, early `break` tears down cleanly.
- **Non-replayable request bodies are never retried.** A streamed body is consumed by the first
  attempt, so a retry would send an empty/partial body. Our own `rawBody` callers all pass FormData
  or bytes (replayable), so this is a guard against a caller-supplied stream rather than a live bug.
- **Case-insensitive response-header lookup.** `google/files.ts` guessed three casings of
  `x-goog-upload-url` and would have missed any fourth. Header reads now go through one shared
  `header()` helper in `util/http` (de-duplicated with the private copy in `llm/files/retrieve.ts`).

### Added
- **`topK` and `seed` sampling options.** Both were reachable on several providers and exposed by
  none of our surface — parity gaps found by the new feature-matrix audit and closed the same day.
  Each is emitted **only where the wire accepts it**, verified by live probe rather than inferred:
  `topK` → Anthropic, Google (generateContent *and* Interactions), xAI chat, OpenRouter chat;
  dropped for OpenAI, which defines no top-k. `seed` → OpenAI **chat-completions**, Google (both
  surfaces), xAI (chat *and* responses), OpenRouter chat; dropped for Anthropic and OpenAI
  **Responses**, which both reject it (400). Sending either to a surface that refuses it is a hard
  error, so the gating is locked by unit tests and was live-verified end to end.
- **`docs/feature-matrix.json` — the parity matrix.** Every capability an official SDK exposes, how
  each provider spells it, and where we stand, with citations into the version-pinned clones.

  > **Corrected 2026-08-10.** This entry also described the release tooling that consumes the
  > matrix. That does not belong in a library changelog — a consumer of the package cannot see it,
  > run it, or care about it — and the tool it named did not exist. Only the shipped data is
  > described here now.
- **`FinishReason` gains `'pending'`** — non-terminal: the provider accepted the request but has not
  produced a completion (Google Interactions `queued`, OpenAI Responses `queued`/`in_progress` in
  background mode). Treat as "poll/retry", never as a result. *Additive union member: exhaustive
  `switch` statements over `FinishReason` should add a case.*
- **`CompletionResponse.error?: { code?, message? }`** — populated when `finishReason === 'error'`,
  carrying the provider's own failure detail (e.g. OpenAI's new `data_residency_mismatch` code,
  openai 6.49). Optional field; absent unless the provider reported a failure.
- Documented the OpenAI `reasoning.context` default (the `gpt-5.6` family defaults to `all_turns`,
  earlier models to `current_turn`).
- **`itemId` on `text` / `thinking` stream events.** OpenAI Responses reports which output item a
  delta belongs to (`item_id`); a turn can interleave deltas from several items, so consumers that
  reassemble per item — rather than concatenating into one string — now can. Optional and additive:
  ignoring it gives exactly the previous behaviour, and providers that report no item id (chat
  completions) simply omit it. Live-confirmed present on every delta from the Responses API.

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
