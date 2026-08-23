# Wire specs

Data describing **how to talk to each provider API**: field names, enum values,
defaults, versioned tool-type strings, and which shape a given model version
takes.

This is the artifact the Python and Rust ports consume. A provider change should
be one reviewable diff here, not three code changes in three languages.

## Why it exists

The catalog records what a model *can do*. Until this existed, nothing recorded
how to *say* it, so adapters matched on the model id with regexes — and got it
wrong twice in production:

- **2.2.1** — Anthropic flipped its `thinking` shape at 4.6; the adapter sent the
  retired one.
- **2.2.2** — Gemini takes tool schemas on `parametersJsonSchema`, not
  `parameters`; every Gemini model rejected any schema with
  `additionalProperties`.

Both were found by a consuming app, not by us, because the knowledge lived in a
regex nobody re-read rather than in data anyone could diff.

## Layout

```
interpreter.ts    the spec schema + evaluator. No outbound imports — pure.
inherit.ts        resolves `extends` chains and trees into a flat spec.
pins.ts + pins/   which chain node an UNPINNED model uses, as ordered rules.
registry.ts       GENERATED index of every shipped spec, by id.
chat-specs.ts     ┐
media-specs.ts    │ per-family runtime loaders. Adapters import one of these,
service-specs.ts  │ never `registry.ts`, so a chat call does not drag every
retrieval-specs.ts│ batch, media and MCP spec into the bundle.
mcp-specs.ts      ┘
specs/            the specs themselves.
```

The named-code registry lives OUTSIDE this folder, in `src/llm/wire-transforms.ts`:
it imports from `src/llm`, and keeping it here would make `wire` cyclic. MCP adds
two more rules of its own (`src/plugins/mcp/wire-rules.ts`) because `llm -> plugins`
is a forbidden edge; it composes them onto the shared registry rather than the
shared registry reaching down into a plugin.

## Status: authoritative

The specs BUILD the requests. Every provider adapter, every hosted-retrieval
backend, the MCP transport and the MCP OAuth flow interpret a spec; none of them
assembles a request by hand any more.

What is deliberately not in a spec: response parsing, streaming, retry, session
and cursor bookkeeping, and the engine metadata (`provider` / `model` /
`responseType`) that routes a call inside the NetworkEngine. A spec describes a
REQUEST, and the adapter wraps that with what the runtime needs.

Every migration was checked against a corpus frozen from the commit BEFORE it, so
"the wire did not move" is measured rather than asserted — and each of those
corpora has been shown to fail when the code is deliberately corrupted.

Coverage is uneven in one place worth naming: the MCP OAuth flow has no live
exercise anywhere, because it needs a real authorization server and a browser
round-trip. Its frozen bytes are the only oracle it has.

## Conventions

- **Id**: `provider/api@version`. The version is omitted when the wire shape does
  not vary by model — `openai/responses`, `google/interactions`. It is present
  where a chain exists: `anthropic/messages@4.7`, `google/generate@3`.
- **Chains, not matrices.** Every wire trait measured across the catalogs is
  keyed by version alone, so a spec `extends` exactly one parent. `extends` also
  supports branching (a tree) at no extra cost, which is what a preview or beta
  fork would need. See `update-reports/038` §9.
- **Flavor overlays**, not separate specs, for OpenAI-compatible backends: xAI
  and OpenRouter patch the base spec rather than copying it.
- `$note` is the comment form **inside** a template. A plain `note` key would
  ship to the provider as payload — it did, once.
- **Spec, not provider.** The format describes HTTP, not LLM APIs: a spec covers a
  JSON-RPC envelope, a form-urlencoded token grant and a long-lived SSE stream with
  the same constructs a chat request uses. `provider: 'mcp'` is a namespace, not a
  claim that MCP is a model vendor.

### The constructs

| | |
|---|---|
| `envelope.url` / `method` / `headers` | the request line and its headers, in declaration order |
| `envelope.query` | query parameters, each able to drop out on its own; `queryEncoding: 'form'` switches a space from `%20` to `+`, which is what RFC 6749 prescribes for an authorization request |
| `envelope.bodyKind` | `json` (default), `form`, `multipart`, `none`, `raw` — the last three hand the payload back to the caller to fill in |
| `fields` / `blocks` | the body, by path or by template |
| a header entry with `spread` | merge an evaluated OBJECT of headers — a caller's header map, a resolved bearer |
| `$each` | splice a mapped array into a literal one; `$spread` is its object form |
| `variants` / `overlays` | model-version flags and per-flavor patches |

## Adding or changing a spec

1. Edit the JSON.
2. `bun run gen:registry` if you added or removed a file. It is generated from the
   directory, and `--check` fails a stale index in CI. A spec missing from the
   index does not fail loudly — it becomes invisible to the chain tests and to the
   coverage audit, which are the two things meant to catch it.
3. `bun test tests/unit/wire` — the differentials fail if the wire moved.
4. `bun run scripts/audit-wire-coverage.ts` — every name a spec can reach must be
   EXECUTED, not merely defined.

Two suites guard the specs in-repo:

- `spec-differential.test.ts` — one representative case per rule family, against
  every adapter shape.
- `every-model-reproduces-its-adapter.test.ts` — every catalogued chat model, 17
  request shapes each, through the spec the CATALOG pins it to. ~4,900
  comparisons in under a second, so OpenRouter's 224 models are covered by
  execution rather than by a pin that merely resolves.

The lab in `wire-spec-lab/` (outside the package) keeps the wider corpus — 116
chat cases, the media/realtime/CRUD rehearsals, and the mutation suite that
proves the differential can actually fail. It derives each pin from the model's
version, so it validates the derivation RULE; the in-repo sweep reads the
`wireSpec` that actually ships.
