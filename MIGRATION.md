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
