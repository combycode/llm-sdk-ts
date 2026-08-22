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
interpreter.ts   the spec schema + evaluator. No library imports — pure.
inherit.ts       resolves `extends` chains and trees into a flat spec.
transforms.ts    the named-code registry: what genuinely CANNOT be data
                 (message/content transformation, schema-shape rules).
registry.ts      generated index of every shipped spec, by id.
specs/           the specs themselves.
```

## Status: oracle, not yet authority

The adapters are still hand-written. These specs are proven to **agree** with
them on every CI run (`tests/unit/wire`), which is what keeps the data honest —
data that is never executed rots.

Making the specs authoritative, so the adapters are driven by them, is the 3.0.0
step. It needs the catalog to carry a `wireSpec` pin per model, which in turn
needed the catalog to become core (done) and the adapters to have a
request-building seam (done).

The specs are deliberately **not** exported from `index.ts` and are tree-shaken
out of `dist` — they add no bytes to the published package until the runtime
uses them.

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

## Adding or changing a spec

1. Edit the JSON.
2. Re-generate `registry.ts` if you added a file.
3. `bun test tests/unit/wire` — the differential fails if the spec and the
   adapter disagree.

The exhaustive corpus (116 chat cases, and all 289 catalogued chat models across
17 request shapes) lives in `wire-spec-lab/` outside the package, along with the
mutation suite that proves the differential can actually fail.
