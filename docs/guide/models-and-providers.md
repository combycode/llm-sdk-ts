# Models & Providers

The SDK ships with built-in support for five providers. Every call routes through a
central catalog that knows each model's pricing, capabilities, and the exact wire
name the provider API expects.

---

## Supported providers

| Provider | Key | Notes |
|---|---|---|
| **Anthropic** | `anthropic` | Claude family; Messages API (`messages`). |
| **OpenAI** | `openai` | GPT / o-series; Responses API preferred, Chat Completions as fallback. |
| **Google** | `google` | Gemini family; Generate API (`generate`), Interactions for stateful sessions. |
| **xAI** | `xai` | Grok family; OpenAI-compatible (Responses + Completions). |
| **OpenRouter** | `openrouter` | Aggregator gateway -- routes to 200+ upstream models under a single key. Not bundled in the local catalog; model info is fetched live. |

You can also point OpenAI-compatible local servers (Ollama, vLLM, LM Studio) at the
`openai` adapter by overriding the base URL in `clientOptions`.

---

## The model catalog

The SDK bundles a versioned JSON catalog for every provider (except OpenRouter,
which is inherently dynamic). The catalog is loaded once at engine startup -- no
network required.

### What `ModelInfo` carries

| Field | Type | Meaning |
|---|---|---|
| `provider` | `string` | Provider key (e.g. `"anthropic"`). |
| `model` | `string` | Canonical normalized slug (e.g. `"claude-haiku-4.5"`). |
| `providerModelName` | `string?` | Exact id sent on the wire (may include a date suffix). |
| `aliases` | `string[]?` | Alternate callable ids (snapshots, dated forms). |
| `pricing.inputPerMTok` | `number?` | USD per 1 M input tokens. |
| `pricing.outputPerMTok` | `number?` | USD per 1 M output tokens. |
| `pricing.cacheReadPerMTok` | `number?` | USD per 1 M cache-read tokens. |
| `pricing.cacheWritePerMTok` | `number?` | USD per 1 M cache-write tokens. |
| `pricing.perImage` | `number?` | USD per image (image-gen models). |
| `pricing.perMinute` | `number?` | USD per minute of audio (STT models). |
| `pricing.tiers` | `Record<string, TierRates>?` | Per-service-tier rate overrides (e.g. `batch`, `priority`, `flex`). The flat fields are the implicit `standard` tier. |
| `capabilities.toolUse` | `boolean` | Supports tool/function calling. |
| `capabilities.builtinTools` | `string[]?` | Names of provider-native built-in tools (e.g. `"web_search"`, `"code_interpreter"`). |
| `capabilities.streaming` | `boolean` | Supports token streaming. |
| `capabilities.structuredOutput` | `boolean` | Supports JSON-schema-constrained output. |
| `capabilities.vision` | `boolean` | Accepts image inputs. |
| `capabilities.audio` | `boolean` | Accepts audio inputs. |
| `capabilities.video` | `boolean` | Accepts video inputs. |
| `capabilities.imageGeneration` | `boolean` | Produces images. |
| `capabilities.audioGeneration` | `boolean` | Produces audio (TTS). |
| `capabilities.videoGeneration` | `boolean` | Produces video. |
| `capabilities.videoExtension` | `boolean?` | Accepts an existing video to extend/edit (`sourceVideo` + `params.videoMode`). xAI `grok-imagine-video`. |
| `reasoning.supported` | `boolean` | Model has an extended thinking / reasoning mode. |
| `reasoning.effortControl` | `boolean` | Reasoning effort level is configurable. |
| `reasoning.automatic` | `boolean` | Reasoning activates automatically (no explicit toggle). |
| `contextWindow` | `number?` | Max input context in tokens. |
| `maxOutput` | `number?` | Max output tokens per request. |
| `preferredApi` | `ApiType` | API variant the SDK uses by default (`messages`, `responses`, `completions`, `generate`, `interactions`). |
| `supportedApis` | `ApiType[]` | All API variants the model can use. |
| `type` | `string?` | Model role: `chat`, `code`, `image`, `video`, `tts`, `stt`, `embedding`. |
| `inputModalities` | `string[]?` | Content kinds accepted: `text`, `image`, `audio`, `video`, `pdf`. |
| `outputModalities` | `string[]?` | Content kinds produced: `text`, `image`, `audio`, `video`. |
| `family` | `string?` | Model family (e.g. `"claude-opus"`, `"gpt"`). |
| `version` | `string?` | Version string (e.g. `"4.5"`, `"5.4"`). Used as a ranking tiebreak when two models have equal input price. |
| `status` | `string?` | Lifecycle: `stable`, `preview`, `legacy`. |
| `availability` | `string?` | Access tier (independent of lifecycle): undefined = generally available; `limited` = gated / not enabled for every account; `preview` = early access. |
| `active` | `boolean?` | Callable from this account right now. |
| `unavailable` | `{ since, reason }?` | A MEASURED refusal: somebody called this model's endpoint and it was gone. Forces `active: false`. |

### Reading the catalog

**The catalog is loaded for you.** `createEngine()` builds it from the bundled provider data unless
you say otherwise -- the examples below pass `catalog: 'defaults'` explicitly, which is the same
thing spelled out.

It is not decoration. The catalog is where an adapter reads, per model, which wire spec builds the
request, what the model costs, and which tokenizer counts it. With an empty one all three fall back
at once -- the spec is derived from the model id, the price is unknown, the count is a 4-chars-per-
token estimate -- and each of those is silent, because each is the correct answer for a model this
build has never heard of.

To opt out, say so: `catalog: false` (or `'empty'`). To supply your own, pass a `ModelCatalog` or
`{ entries }`.

```ts
import { listModels, createEngine } from '@combycode/llm-sdk';

const engine = createEngine({
  catalog: 'defaults',
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});

// All models in the catalog
const all = listModels();

// One provider only
const anthropicModels = listModels({ provider: 'anthropic' });

// Inspect a model
const haiku = engine.catalog.get('anthropic', 'claude-haiku-4.5');
console.log(haiku?.pricing.inputPerMTok);   // e.g. 1.0
console.log(haiku?.capabilities.vision);    // true / false
console.log(haiku?.contextWindow);          // 200000
```

For live availability (not just catalog entries), `listModelsLive()` hits the
provider's `/models` endpoint and merges results with the local catalog:

```ts
import { listModelsLive } from '@combycode/llm-sdk';

// Enriched ModelInfo[], cached 24 h in memory
const live = await listModelsLive({ provider: 'openai' });

// Bare id strings only
const ids = await listModelsLive({ provider: 'openai', raw: true });

// Force a fresh fetch (bypass cache)
const fresh = await listModelsLive({ provider: 'anthropic', refresh: true });
```

Browse all models interactively at [/models](/models).

---

## Overriding the catalog

Use `engine.catalog.set()` to register a model the bundled catalog does not know,
or to override pricing and capabilities for an existing entry.

```ts
import { createEngine } from '@combycode/llm-sdk';

const engine = createEngine({
  catalog: 'defaults',
  apiKeys: { openai: process.env.OPENAI_API_KEY! },
});

// Register a custom / fine-tuned model
engine.catalog.set('openai', 'my-ft-gpt-5.5', {
  pricing: { inputPerMTok: 10, outputPerMTok: 30 },
  preferredApi: 'responses',
  supportedApis: ['responses', 'completions'],
  contextWindow: 1050000,
  capabilities: {
    toolUse: true,
    streaming: true,
    structuredOutput: true,
    vision: true,
    audio: false,
    video: false,
    imageGeneration: false,
    audioGeneration: false,
    videoGeneration: false,
  },
  // The exact id your fine-tune endpoint expects on the wire:
  providerModelName: 'ft:gpt-5.5-2026-04-23:acme::AbcXyz',
});

// Now usable like any catalog model:
const { text } = await complete({
  model: 'openai/my-ft-gpt-5.5',
  prompt: 'Hello',
});
```

`set()` signature:

```ts
catalog.set(
  provider: string,
  model: string,          // normalized slug — what you pass to complete()
  info: Partial<Omit<ModelInfo, 'provider' | 'model'>> & { pricing: ModelPricing }
): void
```

Only `pricing` is required; everything else falls back to safe defaults
(`toolUse: true`, `streaming: true`, `structuredOutput: true`, all media flags
`false`, `preferredApi: 'completions'`, `supportedApis: [preferredApi]`).

To load a batch of entries at once (same format as the bundled `catalog.json`
files), use `catalog.load(data)`:

```ts
engine.catalog.load({
  'openai/my-model': {
    pricing: { inputPerMTok: 2, outputPerMTok: 6 },
    contextWindow: 32000,
    preferredApi: 'responses',
    supportedApis: ['responses'],
    capabilities: { toolUse: true, streaming: true, structuredOutput: true,
                    vision: false, audio: false, video: false,
                    imageGeneration: false, audioGeneration: false, videoGeneration: false },
  },
});
```

---

## Selecting a model

### By name

The SDK accepts two forms everywhere (`complete`, `stream`, `agent`, `estimate`, ...):

**Namespaced** — `"provider/model"` (recommended):
```ts
const { text } = await complete({ model: 'anthropic/claude-haiku-4.5', prompt: '...' });
```

**Bare model + explicit `provider` field**:
```ts
const { text } = await complete({ model: 'claude-haiku-4.5', provider: 'anthropic', prompt: '...' });
```

Both forms are equivalent. The namespaced form is preferred because it is
unambiguous and self-contained.

**Service tier suffix** -- append `:tier` to any namespaced id to pick a *synchronous*
service tier (recognized values: `auto`, `standard`, `priority`, `flex`, `scale`):
```ts
// Routes through the flex tier (cheaper, higher latency)
const { text } = await complete({ model: 'openai/gpt-5.4:flex', prompt: '...' });
```

Per provider: OpenAI (`flex`/`priority`/`fast`), Anthropic (`standard`/`priority`), and Google
(`flex`/`standard`/`priority`) map the requested tier to their own request field; unsupported
tiers are a no-op. In every case the tier the provider actually **billed** is read back into
`usage.serviceTier` / `usage.pricingTier` so cost is priced against the right rate.

OpenAI's `fast` tier is recognised on Responses and chat-completions. Note the response echoes
`service_tier: priority` for either `fast` or `priority`, so read `usage.serviceTier` as *what was
billed*, not as confirmation of which of the two you asked for. Being an entitlement-level tier, a
200 does not by itself prove the request was served in Fast mode.

**The accepted set differs per surface, and a downgrade is never silent.** `ultrafast` is a
Responses value -- GA and beta -- and chat-completions rejects it; it is also access-controlled and
served only by `gpt-5.6-sol`, so an account without access gets a 400 naming `service_tier`, which
is the honest answer. Ask for a tier the surface will not take and the request still goes out as
`auto`, but you are TOLD: the build records it and the client raises `onWarning` with code
`request_adjusted`, naming the tier, the surface and what was sent instead.

That warning exists because the quiet version cost two releases. `fast` arrived in 2026-08 and was
downgraded to the project default for a month before anyone noticed, and `ultrafast` was on course
to repeat it. A tier is a billing and latency decision; substituting a different one without saying
so is making that decision on your behalf.

Note: `batch` is NOT a service tier. Batch is a separate, asynchronous request flow --
the Batch API (`submitBatch` / the [Batch guide](/docs/examples/22-batch/)), with its own
~50% pricing. The `batch` key under `pricing.tiers` exists only so the cost layer can
price batch jobs; you never select it as a `:tier`.

Note: `:free` and `:online` are NOT parsed as tiers -- they are OpenRouter variant
suffixes and are passed through verbatim.

### Smart selection: `select()` and `selectModels()`

`select()` returns the single best `"provider/model"` string for a capability
query; `selectModels()` returns the full ranked list. Both are availability-aware:
only providers with a configured API key are considered.

```ts
import { select, selectModels } from '@combycode/llm-sdk';

// Cheapest vision-capable model across all configured providers
const model = select('vision; price:low');

// All reasoning-capable models, cheapest first
const candidates = selectModels('reasoning');

// Multiple constraints
const coder = select('type:code; tools; context > 100k');

// Restrict to one provider
const gemini = select('vision; streaming', { provider: 'google' });
```

**What `select()` will never hand you.** Two kinds of model are filtered out
before any clause is evaluated, because recommending one is worse than returning
one fewer candidate:

- **Measured unavailable** -- `unavailable` is set, meaning somebody called the
  endpoint and it was gone. These also carry `active: false`. Ask
  `catalog.unavailableReason(provider, model)` to refuse *without* a round trip:
  it returns the reason and when it was measured, or `null` when nothing says
  the model is dead.
- **Past its announced shutdown date** -- `deprecation.shutdownDate` is in the
  past. Checked when you query, not when the catalog was built, because a
  catalog exported yesterday cannot know a date passed overnight.

A model that is merely **deprecated** (`deprecation.date`, no shutdown yet) is
still offered: it announced an end-of-life but still answers, and hiding it would
take away something that works. Add an explicit `active:no` clause when you want
the whole set anyway -- a model browser, an audit.

In production, prefer a fallback chain over relying on any single id: a model can
retire between your deploy and your traffic.

### Refusing before the request leaves

`catalog.unavailableReason()` is the knowledge; `catalog.refuseCall()` is the
decision built on it. It returns the sentence to refuse with, or `null` to go
ahead. The media plugins call it themselves, so `generateImage`, `editImage`,
`generateAudio` and `generateVideo` fail with an explanation instead of a 404
from the provider.

```ts
import { createEngine } from '@combycode/llm-sdk';

const engine = createEngine({ catalog: 'defaults' });

const refusal = engine.catalog.refuseCall('google', 'imagen-4');
// -> 'google/imagen-4 is not callable: Imagen :predict is Enterprise-only. ...
//     To request it anyway, name the provider's own id: "imagen-4.0-generate-001".'

engine.catalog.refuseCall('google', 'imagen-4.0-generate-001'); // -> null
```

**Naming the provider's own id is the force mode.** We measured one account, not
every account, and an endpoint that is Enterprise-only is exactly the kind that
answers for somebody. `imagen-4` is this library's slug: asking for it is asking
the catalog, and the catalog answers with what it measured. `imagen-4.0-generate-001`
is Google's id, and typing it is a deliberate request for that endpoint -- most
plausibly from someone whose deployment does serve it. The measurement does not
change either way: `unavailableReason()` still reports it for both spellings, and
only the refusal is lifted. Where the slug and the provider id are the same string
-- `openai/sora-2`, whose whole API shut down -- there is nothing to force, and
the refusal says so by offering no override.

Query syntax: a semicolon-separated string or string array. Each clause is one of:

| Clause | Meaning |
|---|---|
| `vision`, `tools`, `audio`, `structured` | Capability flag must be true. |
| `web_search`, `code_interpreter` | Model supports that hosted builtin tool (checks `capabilities.builtinTools`). `search` is an alias for `web_search`. |
| `reasoning` | Model has a reasoning mode. |
| `type:chat` | `model.type === 'chat'`. |
| `status:stable` | `model.status === 'stable'`. |
| `price:low` | `inputPerMTok <= 1` (default threshold). |
| `price:mid` | `inputPerMTok <= 5`. |
| `price < 2` | `inputPerMTok <= 2` (numeric, per 1 M tokens). |
| `context > 200k` | `contextWindow >= 200000`. |
| `tier:flex` | Model has a `flex` pricing tier (also `priority`, etc.). |
| `provider:anthropic` | Restrict to one provider (same as `opts.provider`). |

Filter for hosted-tool support directly: `select('web_search')` or `select('code_interpreter')`
match against `capabilities.builtinTools` (populated for every tool-capable model — `web_search`
on all providers, `code_interpreter` on all except OpenRouter). `catalog.builtinToolsFor(provider,
model)` and `catalog.supportsBuiltinTool(provider, model, tool)` expose the same data
programmatically.

Ranking: cheapest input price first; tiebreak: newest version.

```ts
const opts = {
  prefs: {
    thresholds: { 'price.low': 0.5 },          // redefine what "low" means
    tags: { 'my-tag': 'vision; context > 128k' }, // custom shorthand
  },
  tier: 'flex',   // evaluate price against the flex pricing tier
};
const model = select('my-tag', opts);
```

### Fallback routing: `route()`

`route()` tries each candidate model in order, falling over on retryable errors
(rate limits, server errors, timeouts). Non-retryable failures (auth, bad request,
content filter) propagate immediately.

```ts
import { route } from '@combycode/llm-sdk';

const result = await route({
  models: ['anthropic/claude-opus-4.8', 'openai/gpt-5.5', 'google/gemini-3.1-pro'],
  prompt: 'Summarize this document.',
  maxTokens: 1024,
});

console.log(`Served by: ${result.servedBy}`);
console.log(`Attempts:`, result.attempts);
```

When every model in the list belongs to `openrouter`, a single request is sent with
a `models` array and OpenRouter routes server-side (one round-trip, no client-side
retry needed).

---

## Name types

Three distinct identifiers exist for every model. Keeping them straight prevents
subtle bugs.

| Name type | Example | Where you use it |
|---|---|---|
| **Normalized id** (slug) | `anthropic/claude-haiku-4.5` | Pass to `complete()`, `select()`, `catalog.get()`, everywhere in the SDK. |
| **API name** (`providerModelName`) | `claude-haiku-4-5-20251001` | What the adapter sends in the HTTP request body. You never write this -- the SDK translates it. |
| **Alias** | `claude-haiku-4-5-20251001`, `claude-haiku-4-5` | An alternate id (the dated snapshot, or the provider's own undated name) that resolves to the same catalog entry. |

Resolution flow:

```text
You pass:   "anthropic/claude-haiku-4.5"
              |
              v
catalog.get("anthropic", "claude-haiku-4.5")   <- direct slug lookup
              |
              v
catalog.resolveModelId("anthropic", "claude-haiku-4.5")
              |
              v
adapter sends on the wire: "claude-haiku-4-5-20251001"  (<-- providerModelName)
```

If you pass an alias (e.g. the dated form `"anthropic/claude-haiku-4-5-20251001"`),
the alias index resolves it to the canonical slug first, then the same translation
applies. If you pass a completely unknown id, the SDK sends it verbatim -- no error,
no translation.

```ts
// All three of these resolve to the same wire request:
await complete({ model: 'anthropic/claude-haiku-4.5', prompt: '...' });
await complete({ model: 'anthropic/claude-haiku-4-5-20251001', prompt: '...' });  // alias
await complete({ model: 'claude-haiku-4.5', provider: 'anthropic', prompt: '...' });
```

To inspect the wire name directly:

```ts
const wireName = engine.catalog.resolveModelId('anthropic', 'claude-haiku-4.5');
// -> "claude-haiku-4-5-20251001"
```

### Any spelling of a version works

Providers spell the same version more than one way and docs, dashboards and blog
posts disagree: `gpt-4.1` and `gpt-4-1`, `gemini-2.5-flash` and `gemini-2-5-flash`,
`claude-haiku-4.5` and `claude-haiku-4-5`. Whichever you write, the catalog finds
the model -- lookups are insensitive to the separator between two digits, and to
case:

```ts
engine.catalog.get('google', 'gemini-2-5-flash')?.model; // -> "gemini-2.5-flash"
engine.catalog.get('openai', 'GPT-4-1')?.model;          // -> "gpt-4.1"
```

This matters beyond convenience: a spelling the catalog missed had no price and no
capabilities, so it silently billed as free and lost tool/vision detection.

**What gets sent** is always an id the provider accepts. If the spelling you wrote
is itself callable, it is sent unchanged; if it is not, the canonical id goes
instead, rather than forwarding a 404 back to you:

```ts
engine.catalog.resolveModelId('google', 'gemini-2-5-flash'); // -> "gemini-2.5-flash"  (corrected)
engine.catalog.resolveModelId('openai', 'gpt-4-1');          // -> "gpt-4.1"           (corrected)
```

Every helper shares this one step -- `complete()`, `createLLM()`, `createAgent()`,
`embed()`, `moderate()`, `transcribe()`, `countTokens()`, `batch()`, media and
realtime all resolve identically, so a model id behaves the same everywhere.

An id we have never seen is still sent verbatim, so a fine-tune or a model released
this morning keeps working.

### Undated Anthropic names

Anthropic's docs put an undated name in front of you -- `claude-haiku-4-5` rather
than the dated `claude-haiku-4-5-20251001` -- and the API accepts it. The catalog
carries it as an alias, so it resolves and **prices** like any other id:

```ts
engine.catalog.getPricing('anthropic', 'claude-haiku-4-5'); // -> pricing, not null
```

It is not the same request as the slug, though, and that difference is deliberate:

```ts
engine.catalog.resolveModelId('anthropic', 'claude-haiku-4.5');  // "claude-haiku-4-5-20251001"  (pinned)
engine.catalog.resolveModelId('anthropic', 'claude-haiku-4-5');  // "claude-haiku-4-5"           (floating)
```

The slug pins the snapshot the catalog knows. The undated alias is sent verbatim,
because it means "the current 4.5 haiku" -- rewriting it to a date would pin a
caller who deliberately asked not to be. Use the slug when you want reproducibility,
the undated name when you want to follow the provider's latest.

---

## Related

- [List models example](./../../examples/28-models-list/) -- `listModels` / `listModelsLive` in practice.
- [Cost tracking](./cost.md) -- estimate and track spend using catalog pricing.
- [Provider routing example](./../../examples/26-provider-routing/) -- `route()` in a real workflow.
- [/models](/models) -- interactive model browser (live catalog).
