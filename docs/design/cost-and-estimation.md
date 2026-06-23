---
title: Cost & Estimation
---

# Cost & Estimation

Source: `src/plugins/cost-collector/collector.ts`,
`src/plugins/cost-collector/cost-collector-types.ts`,
`src/plugins/cost-collector/cost-collector-internal.ts`,
`src/helpers/estimate.ts`, `src/helpers/estimator.ts`,
`src/helpers/estimate-types.ts`,
`src/helpers/calibration-store.ts`, `src/helpers/calibration-types.ts`,
`src/plugins/model-catalog/catalog.ts`.

## Purpose and responsibilities

The cost subsystem has three independent parts:

1. **ModelCatalog** -- static registry of model metadata (pricing, capabilities,
   API preferences, state-retention rules). Loaded once; queried by all other
   layers.
2. **CostCollector** -- runtime accumulant. Subscribes to `onCompletion` and
   `onMediaGenerated`; computes actual cost per call; enforces budgets.
3. **`estimate()` / `Estimator`** -- pre-flight cost estimation. `estimate()` is
   a pure function (no network, no state). `Estimator` wraps it with
   EWMA-calibrated output-token bounds derived from observed completions.

## `ModelCatalog` (`src/plugins/model-catalog/catalog.ts`)

### Data model

```ts
interface ModelInfo {
  provider: string;
  model: string;           // canonical slug, e.g. "claude-opus-4.8"
  pricing: ModelPricing;
  preferredApi: ApiType;
  supportedApis: ApiType[];
  contextWindow?: number;
  maxOutput?: number;
  capabilities: ModelCapabilities;
  reasoning: ModelReasoning;
  tokenizer?: TokenizerInfo;
  aliases?: string[];
  supportsPreviousResponseId?: boolean;
}

interface ModelPricing {
  inputPerMTok?: number;          // USD per 1M input tokens
  outputPerMTok?: number;         // USD per 1M output tokens
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  audioInputPerMTok?: number;
  audioOutputPerMTok?: number;
  perImage?: number;              // flat USD per generated image
  perSecond?: number;             // USD per second (video)
  perMinute?: number;             // USD per minute (STT/transcription)
  perMChars?: number;             // USD per 1M chars (TTS)
  perUnit?: Record<string, number>; // per-resolution overrides
  tiers?: Record<string, TierRates>;  // keyed by provider's OWN tier name
}

type TierRates = Omit<ModelPricing, 'tiers'>;

interface ModelCapabilities {
  toolUse: boolean;
  builtinTools?: string[];
  streaming: boolean;
  structuredOutput: boolean;
  vision: boolean;
  audio: boolean;
  video: boolean;
  imageGeneration: boolean;
  audioGeneration: boolean;
  videoGeneration: boolean;
}

interface ModelReasoning {
  supported: boolean;
  automatic: boolean;
  effortControl: boolean;
  effortValues?: string[];
  encryptedContent: boolean;
  summaryAvailable: boolean;
}
```

Service-tier pricing: when a completion returns `usage.pricingTier` (set by
provider adapters from `usage.serviceTier`), `calculateCost` overlays
`tiers[pricingTier]` on top of flat rates. Fields in the tier entry override
flat rates; missing fields fall back to flat rates. The guard also excludes
`'standard'` (`tier && tier !== 'standard'`), so passing the implicit standard
tier is a no-op. Example: `tiers['flex'] = { inputPerMTok: 0.5 }` gives
discounted input at flex-tier while the output rate stays at the flat rate.

### Internal storage

```ts
class ModelCatalog {
  private models: Map<string, ModelInfo>       // key: "provider/model" (canonical slug)
  private aliasIndex: Map<string, string>      // "provider/alias" -> "provider/canonical-slug"
}
```

`set(provider, model, info)` (3-arg) registers a model: inserts into `models`
under the canonical key, then iterates `info.aliases[]` to populate
`aliasIndex`. Aliases are stored as `"provider/alias" -> "provider/modelId"`.

`get(provider, modelId)`: checks `models` directly (canonical lookup), then
`aliasIndex` for an alias, then returns `undefined`. Does NOT throw -- callers
check for `undefined`.

`resolveModelId(provider, slug)`: follows alias chain and returns the provider's
canonical model ID (e.g. `"claude-sonnet-4-6-20251120"` resolves to canonical).
Returns `slug` unchanged if no alias found.

### Provider defaults

`loadProviderDefaults()` loads five built-in catalog JSON files via static
imports resolved at bundle time from `PROVIDER_DEFAULT_CATALOGS`. Provider files
live at: `src/llm/providers/{provider}/catalog.json`.

`PROVIDER_STATE` constant holds per-provider defaults for `stateRetentionDuration`
(a duration string e.g. `"30d"`, `"72h"`, or `null`) and `modelBound`.
Applied when a model entry omits those fields.

### Query API

```ts
catalog.getPricing(provider, model): ModelPricing | null
catalog.getPreferredApi(provider, model): ApiType | null
catalog.supportsApi(provider, model, apiType): boolean
catalog.supportsPreviousResponseId(provider, model): boolean
catalog.getStateRetention(provider, model): string | null  // duration string e.g. "30d", or null
catalog.isStateModelBound(provider, model): boolean
```

## `CostCollector` (`src/plugins/cost-collector/collector.ts`)

### Construction and subscription

```ts
class CostCollector {
  constructor(config: CostCollectorConfig)
}

interface CostCollectorConfig {
  hooks: HookBus;
  catalog: ModelCatalog;
  sessionId?: string;
  defaultTags?: Record<string, string>;
}
```

Calls `hooks.on('onCompletion', ...)` and `hooks.on('onMediaGenerated', ...)`.
Uses `hooks.emitSync` (NOT `emit`) for cost events -- `onCostEntry`,
`onBudgetWarning`, `onBudgetExceeded` are all sync.

### Budget management

Budgets are added and removed via methods after construction:

```ts
collector.addBudget(budget: Budget): void
collector.removeBudget(id: string): void
collector.watchAgent(agent: { stop(): void }): void  // shared set for 'stop' action
collector.setTag(key: string, value: string): void   // update defaultTags at runtime
```

```ts
interface Budget {
  id: string;
  limit: number;                        // USD limit (NOT limitUsd)
  scope: Record<string, string | undefined>;
  thresholds: number[];                 // fractions of limit, e.g. [0.7, 0.9]
  action: 'warn' | 'stop';
}
```

### `handleCompletion` flow

1. Build `tokens` from `response.usage`; falls back to
   `request.estimatedInputTokens` when `response.usage.inputTokens` is 0.
2. Call `extractProviderCost(provider, response.raw)` to get the evidence Record.
3. Compute cost via `calculateCost(catalog, provider, model, tokens, providerEvidence, pricingTier)`.
4. Build `CostEntry { id, timestamp, provider, model, tokens, cost, serviceTier?, providerEvidence, tags }`.
5. Push to `this.ledger[]`; accumulate into `this._runningTotal`.
6. `hooks.emitSync('onCostEntry', { entry, runningTotal })`.
7. Call `checkBudgets(entry)`.

### Provider cost extraction (`cost-collector-internal.ts:extractProviderCost`)

`extractProviderCost(provider, raw)` returns a `Record<string, unknown>` of
evidence fields pulled from the raw provider response. Numeric total is obtained
separately via `getProviderTotal(provider, evidence)`.

Two special-case providers:
- **openrouter**: `usage.cost` -- OpenRouter injects total USD directly into the
  usage object.
- **xai** (Grok): `usage.cost_in_usd_ticks / 1e10` -- xAI's API returns integer
  sub-unit ticks; dividing by 1e10 converts to USD.

All other providers: `{}` (empty evidence; cost computed from token counts).

### `handleMediaGenerated` flow

Extracts provider evidence via `extractProviderCost(provider, ctx.providerEvidence)`,
then calls the central `computeCost(catalog, { provider, model, tokens?, media, providerEvidence })`.
The result follows the same 4-step ladder (provider total -> token cost -> media
unit cost -> unknown). `mediaUnitCost` is a private 2-arg helper inside
`cost-collector-internal.ts` used only by `computeCost`.

### Budget enforcement (`checkBudgets`)

After each `CostEntry`, `checkBudgets` runs all budgets:
1. `matchesScope(entry, budget.scope)`: true if all defined scope keys match the
   entry's tags.
2. `this.total(budget.scope).total`: sums all matching entries' cost totals.
3. For each `threshold` in `budget.thresholds[]`: if `spent >= budget.limit * threshold`
   and not already in `triggeredThresholds`: `hooks.emitSync('onBudgetWarning', ...)`.
4. If `spent >= budget.limit` and not already triggered at 1.0:
   - `hooks.emitSync('onBudgetExceeded', ...)`.
   - If `budget.action === 'stop'`: calls `.stop()` on each agent in the
     collector-wide `this.watchedAgents` set.
   - Threshold `1.0` is added to `triggeredThresholds` (a Set per budget id) to
     prevent repeated stop signals. Budgets are NOT removed from the list.

Budget hook payloads:

```ts
// onBudgetWarning
{ budgetId, scope, limit, current, threshold, percentage }

// onBudgetExceeded
{ budgetId, scope, limit, current, overage }
```

### Query API

All query members are **methods**, not property getters (except the three getters
listed below).

```ts
// Methods -- accept an optional CostFilter
collector.total(filter?: CostFilter): CostSummary
collector.byProvider(filter?: CostFilter): Record<string, CostSummary>
collector.byModel(filter?: CostFilter): Record<string, CostSummary>
collector.byTag(tag: string, filter?: CostFilter): Record<string, CostSummary>
collector.entries(filter?: CostFilter): CostEntry[]

// Budget mutations
collector.addBudget(budget: Budget): void
collector.removeBudget(id: string): void
collector.watchAgent(agent: { stop(): void }): void
collector.setTag(key: string, value: string): void

// Import / export
collector.export(): CostEntry[]
collector.import(entries: CostEntry[]): void

// Getters (no filter)
collector.entryCount: number
collector.runningTotal: number
collector.modelCatalog: ModelCatalog
```

### `CostEntry` shape

```ts
interface CostEntry {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  tokens: {
    input: number;
    output: number;
    cached: number;
    cacheWrite: number;
    reasoning: number;
    audioInput?: number;
    audioOutput?: number;
  };
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    total: number;
    source: 'provider' | 'calculated' | 'unknown';
  };
  serviceTier?: string;
  providerEvidence: Record<string, unknown>;
  tags: Record<string, string | undefined>;
}
```

Storage is `this.ledger[]` plus `this._runningTotal` (a running numeric
accumulator updated on every push -- no per-provider or per-model accumulator
maps; aggregation is done on demand by the query methods).

## Cost computation ladder (`cost-collector-internal.ts`)

### `computeCost(catalog, input: CostComputeInput)`

```ts
// CostComputeInput: { provider, model, tokens?, media?, providerEvidence?, tier? }
```

Four steps in priority order:

1. **Provider-reported total** -- if `getProviderTotal(provider, providerEvidence)`
   returns non-null, use it. Skip steps 2-4.
2. **Token cost** -- if the catalog has `inputPerMTok` or `outputPerMTok` for
   this model AND `tokens` is provided, compute via `calculateCost()`.
   When a model entry is missing, also tries `catalog.getPricing(provider, media.type)`.
3. **Media unit cost** -- if this is unit-priced media (no token rates), compute
   via the private `mediaUnitCost(pricing, media)` helper.
4. **Unknown** -- return `$0.00` with `source: 'unknown'` (honest zero, not `null`).

### `calculateCost(catalog, provider, model, tokens, providerEvidence, tier?)`

1. Call `getProviderTotal(provider, providerEvidence)`. If non-null: return a
   zero-breakdown entry with `total = providerTotal`, `source: 'provider'`.
2. Fetch `pricing = catalog.getPricing(provider, model)`.
3. If `tier` is set AND `tier !== 'standard'` AND `pricing.tiers?.[tier]` exists:
   merge `tiers[tier]` over flat rates (tier fields win; absent fields fall back
   to flat rates).
4. Compute:
   ```text
   inputCost      = (tokens.input / 1_000_000) * inputPerMTok
                  + (tokens.audioInput / 1_000_000) * audioInRate
   outputCost     = (tokens.output / 1_000_000) * outputPerMTok
                  + (tokens.audioOutput / 1_000_000) * audioOutRate
   cacheReadCost  = (tokens.cached / 1_000_000) * cacheReadPerMTok
   cacheWriteCost = (tokens.cacheWrite / 1_000_000) * cacheWritePerMTok
   reasoningCost  = (tokens.reasoning / 1_000_000) * outputPerMTok
   ```
5. Cache-read defaults to `inputPerMTok * 0.1`. Cache-write defaults to
   `inputPerMTok * 1.25`. Audio rates default to the text rates when absent.

The `estimatedInputTokens` fallback (for when `response.usage.inputTokens` is 0)
happens in `handleCompletion` before `calculateCost` is called -- it is not
inside `calculateCost` itself.

## `estimate()` (`src/helpers/estimate.ts`)

```ts
async function estimate(request: EstimateRequest, opts?: EstimateOptions): Promise<EstimateResult>
```

Async, pure (no network). Throws `UnknownModelError` when the model is absent
from the catalog. Model is specified as `"provider/model"` in `request.model`
or as separate `request.model` + `request.provider`.

```ts
interface EstimateRequest {
  model: string;         // "provider/model" or bare slug (needs provider field)
  provider?: ProviderName;
  prompt: string | ContentPart[] | Message[];
  system?: string;
  maxTokens?: number;
}

interface EstimateOptions {
  model?: string;
  expectedOutputTokens?: number;
  engine?: EngineHandle;
}

interface EstimateResult {
  model: string;
  inputTokens: number;
  estOutputTokens: number;
  cost: { low: number; expected: number; high: number };
  breakdown: { inputUsd: number; outputUsd: number; imageUsd?: number; audioUsd?: number };
  currency: 'USD';
  assumptions: string[];
}
```

### Three-bound system

- **`low`**: 0 output tokens. Minimum possible cost (input + media only).
- **`expected`**: `resolveExpectedOutput()` -- uses `opts.expectedOutputTokens`
  if provided; if `maxTokens < DEFAULT_EXPECTED_OUTPUT_TOKENS`, caps at
  `maxTokens`; else defaults to `DEFAULT_EXPECTED_OUTPUT_TOKENS = 512`.
- **`high`**: `resolveHighOutput()` -- uses `request.maxTokens` if set, else
  `catalog.get().maxOutput`, else `FALLBACK_MAX_OUTPUT_TOKENS = 4096`.

### Input token counting

`countInputTokens(counter, ctx, request, assumptions)`: uses `HybridTokenCounter`
for per-model token estimation (tiktoken / count-api / heuristic, per catalog).
Always appends `"no local tokenizer: heuristic used for input token count"` to
`assumptions`.

`priceMediaParts(prompt, pricing, provider, model, assumptions)`: scans content
parts for images and audio. Image parts are priced via `pricing.perImage` (a
flat per-image rate). Audio parts cannot be priced at estimation time (token
count requires runtime data); a note is appended to `assumptions` instead.
`audioUsd` in the breakdown is always 0. `imageUsd` is only non-zero when
`pricing.perImage` exists.

Real `assumptions[]` strings (examples):
- `"no local tokenizer: heuristic used for input token count"`
- `"expected output tokens defaulted to DEFAULT_EXPECTED_OUTPUT_TOKENS=512"`
- `"output bounded by maxTokens=256 (used as expected)"`
- `"high bound: output capped at request maxTokens=2048"`
- `"high bound: output capped at catalog maxOutput=8192"`
- `"high bound: catalog maxOutput unknown, using FALLBACK_MAX_OUTPUT_TOKENS=4096"`
- `"3 image part(s) priced at perImage=$0.04 each"`
- `"2 audio part(s) present but unpriced: audio token count requires runtime data"`

## `Estimator` (`src/helpers/estimator.ts`)

Stateful wrapper that calibrates `estimate()`'s expected and high bounds using
EWMA mean + p90 histogram learned from observed completions.

```ts
class Estimator {
  constructor(opts?: EstimatorOptions)
  async estimate(request: EstimateRequest, opts?: EstimateOptions): Promise<EstimateResult>
  async record(obs: CalibrationObservation): Promise<void>
  subscribeToEngine(engine: EngineHandle): () => void
  subscribeToHooks(hooks: HookBus): () => void
}
```

`subscribeToEngine` and `subscribeToHooks` are alternative wiring points.
Both feed `onCompletion` events into `record()` automatically.

### `applyCalibratedBounds` (private)

1. Load the calibration entry for `(provider, model, inputBucket)`.
2. If entry is absent (`!entry`): return `base` unchanged. There is no minimum
   sample-count gate -- any non-null entry is used.
3. Calibrated expected = `Math.round(entry.ewmaMean)`.
4. Calibrated high = `Math.min(Math.max(p90, ewmaMean), hardCeiling)`.
   `hardCeiling = request.maxTokens ?? catalogEntry?.maxOutput ?? FALLBACK_MAX_OUTPUT_TOKENS`.
5. Recomputes `cost.expected` and `cost.high` from the calibrated token counts.

The ceiling prevents calibrated high from exceeding the actual model maximum.
`expected` and `high` are always `>= low` (the `Math.max` guard ensures it).

## `OutputCalibrationStore` (`src/helpers/calibration-store.ts`)

Backed by the `Persistence` interface from `src/plugins/persistence/types.ts`
(same `get`/`set`/`list` interface used by the cache and context subsystems).

### Key structure

```text
OUTPUT_CALIBRATION_KEY_PREFIX + provider/model#bucket
// e.g. "output-calibration:anthropic/claude-sonnet-4.6#2000-8000"
```

`inputBucketLabel(inputTokens)`: maps to one of five labels.
`INPUT_SIZE_BUCKET_EDGES = [500, 2000, 8000, 32000]`:
- `"0-500"`, `"500-2000"`, `"2000-8000"`, `"8000-32000"`, `"32000+"`

### Histogram structure

```ts
interface OutputCalibrationEntry {
  key: string;
  ewmaMean: number;        // EWMA-smoothed mean of observed output tokens
  histogram: number[];     // P90_HISTOGRAM_BIN_COUNT = 32 bins
  count: number;           // total observations recorded
  lastUpdated: number;
}

const P90_HISTOGRAM_BIN_WIDTH = 256   // tokens per bin (top-level const)
```

Bin index: `Math.min(Math.floor(outputTokens / 256), 31)` -- clamped to 31
(captures all output >= 7936 tokens in the last bin).

### `record(obs: CalibrationObservation)`

1. Resolve calibration key and load or initialize the entry.
2. EWMA update: `ewmaMean = alpha * outputTokens + (1 - alpha) * existing.ewmaMean`.
   `CALIBRATION_EWMA_ALPHA = 0.15`. First observation initializes `ewmaMean`
   to the raw value directly.
3. `histogram[binIndex] += 1`; `count += 1`.
4. Persist via `persistence.set(key, entry)`.

### `histogramQuantile(histogram, quantile)` -- p90

1. Sum all bin counts (`total`). If `total === 0`: return `0`.
2. Target = `quantile * total` where `CALIBRATION_HIGH_QUANTILE = 0.9`.
3. Walk bins from 0 upward accumulating until cumulative >= target.
4. Return center of target bin: `(binIndex + 0.5) * 256`.

`p90(entry)`: returns `histogramQuantile(entry.histogram, 0.9)` -- always a
`number` (returns `0` for an empty histogram, never `undefined`).

`get(provider, model, inputTokens)`: returns `null` when no entry exists for
that key.

## Key invariants and gotchas

- **Provider total is authoritative**: if `getProviderTotal` returns non-null
  (even `0` for a free model), token-based steps are skipped entirely.
- **`pricingTier` vs `serviceTier`**: `usage.serviceTier` is the provider's raw
  tier name in the response. `usage.pricingTier` is what the SDK maps it to for
  catalog lookup. The adapter does the mapping in `parseResponse`.
- **Budget `action:'stop'` is not immediate**: `AgentLoop.stop()` sets a flag;
  the loop checks it at the top of the next iteration. Mid-step execution
  completes first.
- **No calibration sample-count gate**: `applyCalibratedBounds` uses any non-null
  entry from the store, even a single observation. There is no `count < 5` check
  anywhere in the codebase.
- **`loadProviderDefaults()` is idempotent**: repeated calls re-register the
  same models; `set()` overwrites if the model already exists.
- **`estimate()` throws on unknown models**: callers must either handle
  `UnknownModelError` or ensure the model is registered before calling.
- **Alias resolution in the cost path**: `CostCollector` receives `model`
  from `CompletionContext.model`, which provider adapters set to the canonical
  slug. `catalog.get()` with the canonical slug finds it directly; no alias
  lookup needed in the cost path.
- **`calculateCost` honest-zero**: when the catalog has no pricing for the model,
  `calculateCost` returns `source: 'unknown'` with all cost fields at `0`.
  `computeCost` does the same at step 4. Neither returns `null`.
