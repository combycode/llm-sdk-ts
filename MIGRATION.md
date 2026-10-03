# Migrating to 3.0.0

Upgrading from 2.x almost certainly needs no source changes. One type member was removed, and it
was one the SDK set for its own adapters to read rather than something an application was ever
expected to write.

**Already on 3.x? Nothing below applies to you.** 3.0.0 is the only release in the line that
broke anything. 3.1.0 through 3.4.0 removed no public symbol and changed no signature — the one
later `Removed` entry, in 3.2.0, took out five private functions whose names already began with
an underscore. 3.4.0 added 245 symbols and removed none.

One 3.4.0 change is worth knowing about even though it breaks no signature: on Anthropic models
served by the `@4.7` wire era, `temperature`, `topP` and `topK` are now dropped from the request
instead of sent. Those models answer `400` to all three, so a request that set them used to fail
outright; it now succeeds, with an `onWarning` naming what was dropped. If you were relying on
that failure to tell you a model ignores sampling, read the warning instead.

## `ModelInfo.wire`, `NormalizedRequest.wire` and the `ModelWire` type are gone

`wire` carried per-model traits (`{ thinking, topK }`) that told an adapter which shape a model
takes. `ModelInfo.wireSpec` — which names the wire spec that builds the request — now carries the
same knowledge, and it carries it exactly once.

That duplication was the point of removing it. Two representations of one fact drift apart, and
this library has already shipped two bugs from precisely that: 2.2.1 sent Anthropic the retired
`thinking` shape, and 2.2.2 sent Gemini tool schemas on the wrong field. Keeping `wire` alongside
`wireSpec` would have been the same mistake with better tests.

**What to do:** nothing, unless you read `.wire` off a catalog entry. If you did:

```ts
// before
const shape = catalog.get('anthropic', model)?.wire?.thinking;   // 'adaptive' | 'budgeted'

// after — the pin names the spec, and the spec defines the shape
const spec = catalog.get('anthropic', model)?.wireSpec;          // 'anthropic/messages@4.7'
```

If you were SETTING `wire` on a custom catalog entry to steer an adapter, set `wireSpec` instead:

```ts
catalog.set('anthropic', 'my-model', { pricing: {}, wireSpec: 'anthropic/messages@4.1' });
```

**Behaviour is unchanged.** Every catalogued model produces the byte-identical request it produced
in 2.3.0 — checked on every CI run against a corpus frozen from the 2.3.0 tag: 290 subjects across
23 request shapes, on both the pinned and the id-derived route.

## The catalog is loaded by default

`createEngine()` and `LLMClient` now start with the bundled provider catalogs instead of an empty
one. **Almost certainly no source change** — and if you were already passing `catalog: 'defaults'`,
that still works and now says the same thing twice.

What changes if you were NOT passing it: prices become known, token counts can use the exact
strategies, and requests are built from the model's wire-spec pin rather than from a rule over its
id. All three were falling back before, silently.

```ts
// before — an empty catalog unless you asked
const engine = createEngine({ apiKeys });            // no pricing, no pins
const engine = createEngine({ apiKeys, catalog: 'defaults' });  // the data

// after — the data, unless you opt out
const engine = createEngine({ apiKeys });            // the data
const engine = createEngine({ apiKeys, catalog: false });       // no entries, on purpose
```

If you relied on an empty catalog — to be certain no bundled price was used, say — pass
`catalog: false` (or `'empty'`).

## The token-count APIs need the engine's fetch

`AnthropicCountApi` and `GoogleCountApi` used to default their second argument to
`globalThis.fetch`. That default is gone: the fetch is required, and it is an `EngineFetch` — the
same request-object fetch every other adapter takes — rather than a WHATWG `(url, init)` one.

**Almost certainly no source change.** `countTokens()` and `HybridTokenCounter` build these for you,
and `countTokens()` passes `engine.fetch`. You only touch this if you construct one directly:

```ts
// before — went around the NetworkEngine entirely
const api = new AnthropicCountApi(apiKey);

// after
const api = new AnthropicCountApi(apiKey, engine.fetch);
```

If you build a `HybridTokenCounter` yourself and want the exact count APIs, pass `fetch`:

```ts
new HybridTokenCounter({ catalog, countApiKeys, fetch: engine.fetch });
```

Without it the exact strategies are unavailable and counting falls back to the heuristic, with a
warning — rather than quietly calling the provider outside the queue, the rate limiter, the retry
policy and the telemetry, which is what the old default did.

## `hooks.onAny` receives one event instead of `(name, ctx)`

Only affects code that subscribes to the WHOLE event stream. `hooks.on('onCompletion', h)` — the
named subscription — is unchanged.

```ts
// before
hooks.onAny((name, ctx) => {
  if (name === 'onCompletion') {
    const c = ctx as { response?: { usage?: { inputTokens?: number } } };
    record(c.response?.usage?.inputTokens ?? 0);
  }
});

// after — `event.type` narrows `event.ctx`, so the cast is gone
hooks.onAny((event) => {
  if (event.type === 'onCompletion') {
    record(event.ctx.response.usage?.inputTokens ?? 0);
  }
});
```

The old shape forced every subscriber to cast, and a cast keeps compiling after the field it names
is renamed — which for a usage or cost field is a metric that silently reads zero. `HookEvent` is
derived from `HookMap`, so a hook added later becomes a variant your `switch` is told about.

## Google requests carry the API key in a header, not the URL

Behaviour, not signature: no source change, and no key of yours moves. Twelve Google endpoints —
files, batch, media, embeddings, count — used to append `?key=…` to the URL; they now send
`x-goog-api-key`. Nothing to update unless something in your infrastructure reads the key OUT of
the URL: an allowlist matching on the query string, a log scrubber written against `key=`, or a
proxy that routes on it. Those stop seeing it, which was the point — a URL travels through logs,
proxies and error reports that a header does not.

## Nothing else was removed

The band helpers that went with it — `anthropicThinkingShape`, `anthropicAcceptsTopK`,
`googleUsesThinkingBudget`, and the thinking-budget tables — were never exported from the package
entry point, and the `exports` map has always blocked deep imports, so no application could reach
them. They now live as data in `src/wire/pins/`, which is what the Python and Rust ports read.

---

# Migrating to 2.0.0

**Most codebases need no source changes.** The point of this library is that provider churn is our
problem to absorb, not yours — and a whole cycle of it (a new MCP protocol revision, a new OpenAI
major, four SDK majors) landed here without becoming a breaking change for you.

Three things can require action, and none of them is a provider change.

## 1. Node 22+ is required

```json
"engines": { "node": ">=22", "bun": ">=1.1.0" }
```

Node 18 and 20 are both end-of-life. 22 is also the floor `openai-node` 7 adopted.

**What to do:** upgrade the runtime. Nothing in your code changes.

## 2. `tiktoken` is now an optional PEER dependency

It used to be an `optionalDependency`, which means *"do not fail the install if this package fails
to build"* — npm installed it **anyway**. Every consumer received its ~5.6 MB wasm file, and
bundlers emitted it into production builds even when local token counting was never used. One
consumer measured it at **88% of their shipped output**.

**What to do:** if you use exact local OpenAI token counting, install it yourself:

```sh
npm install tiktoken
```

If you don't, do nothing — you now stop paying for a feature you never asked for. Token counting
still works without it: `countTokens` falls back to the provider count-API (Anthropic/Google) or a
calibrated heuristic. The error thrown when the package is genuinely needed names it and the
alternatives.

It still works in the **browser** when you do install it; it is deliberately not stubbed out.

## 3. Two unions are now open — add a `default` branch

`FinishReason` and `ContentPart` gained members and are now open unions
(`KnownFinishReason | (string & {})`). If you `switch` over either **exhaustively, with no
`default`**, TypeScript will now complain.

```ts
switch (res.finishReason) {
  case 'stop': …
  case 'tool_use': …
  default: …   // <- add this
}
```

**This is deliberate, and it is the reason most of this release is not breaking.** Providers grew
four new terminal statuses in a single cycle. With a closed union, every one of those is a breaking
change for *every* consumer — including consumers of providers that changed nothing. Open unions
convert that into an additive change, at the cost of one `default` branch written once
(CONSTITUTION.md R1).

New members you can now handle if you want them: `'pending'` (queued / in-progress — previously
flattened to `'stop'`, claiming a clean finish for a response that had not run), and
`'malformed_tool_call'`. `ContentPart` gained `program_call` / `program_result`.

## 4. One changed signature

`OpenAITranscriptionAdapter.transcribe()` returns `OpenAITranscriptionResult` instead of `string`:

```ts
// before
const text = await adapter.transcribe(req, fetch);

// after
const { text } = await adapter.transcribe(req, fetch);
```

The result also carries optional `segments`, `words`, `languages` and `durationSeconds`.

**The `transcribe()` helper is unaffected** — it already returned an object, and `text` is still
required on it. Only the low-level adapter class changed.

## What did NOT break

Worth stating, because it is the whole design goal:

- **MCP 2025-11-25 keeps working, untouched.** The 2026-07-28 revision deletes the `initialize`
  handshake, the session id and the entire back-channel — but this client speaks **both** wires and
  prefers neither. No legacy path was removed. Even the WebSocket transport stays, documented as
  non-standard, though upstream deleted theirs.
- **Every response type only gained optional fields.** Nothing was removed, narrowed, or made
  required.
- **Every request option is still accepted.** Where a provider stopped taking one, we decide
  internally whether it reaches the wire — your build does not break because of their typings.

Full detail in [CHANGELOG.md](./CHANGELOG.md).
