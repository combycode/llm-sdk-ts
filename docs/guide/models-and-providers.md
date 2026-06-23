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
| `active` | `boolean?` | Callable from this account right now. |

### Reading the catalog

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

Query syntax: a semicolon-separated string or string array. Each clause is one of:

| Clause | Meaning |
|---|---|
| `vision`, `tools`, `audio`, `structured` | Capability flag must be true. |
| `reasoning` | Model has a reasoning mode. |
| `type:chat` | `model.type === 'chat'`. |
| `status:stable` | `model.status === 'stable'`. |
| `price:low` | `inputPerMTok <= 1` (default threshold). |
| `price:mid` | `inputPerMTok <= 5`. |
| `price < 2` | `inputPerMTok <= 2` (numeric, per 1 M tokens). |
| `context > 200k` | `contextWindow >= 200000`. |
| `tier:flex` | Model has a `flex` pricing tier (also `priority`, etc.). |
| `provider:anthropic` | Restrict to one provider (same as `opts.provider`). |

To filter for web-search models use `type:search` or inspect `capabilities.builtinTools` on the returned `ModelInfo` object -- there is no `search` DSL clause because `webSearch` is not a standard `ModelCapabilities` field.

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
| **Alias** | `claude-haiku-4-5-20251001` | An alternate id (often the dated snapshot) that resolves to the same catalog entry. |

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

---

## Related

- [List models example](./../../examples/28-models-list/) -- `listModels` / `listModelsLive` in practice.
- [Cost tracking](./cost.md) -- estimate and track spend using catalog pricing.
- [Provider routing example](./../../examples/26-provider-routing/) -- `route()` in a real workflow.
- [/models](/models) -- interactive model browser (live catalog).
