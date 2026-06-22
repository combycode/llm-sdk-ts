---
title: Cost & Estimation
---

# Cost & Estimation

Source: `src/plugins/cost-collector/collector.ts`,
`src/plugins/cost-collector/cost-collector-internal.ts`,
`src/helpers/estimate.ts`, `src/helpers/estimator.ts`,
`src/helpers/calibration-store.ts`, `src/helpers/calibration-types.ts`,
`src/plugins/model-catalog/catalog.ts`.

## Purpose and responsibilities

The cost subsystem has three independent parts:

1. **ModelCatalog** — static registry of model metadata (pricing, capabilities,
   API preferences, state-retention rules). Loaded once; queried by all other
   layers.
2. **CostCollector** — runtime accumulant. Subscribes to `onCompletion` and
   `onMediaGenerated`; computes actual cost per call; enforces budgets.
3. **`estimate()` / `Estimator`** — pre-flight cost estimation. `estimate()` is
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
  tiers?: Record<string, TierRates>;  // keyed by provider's OWN tier name
}

type TierRates = Omit<ModelPricing, 'tiers'>;

interface ModelCapabilities {
  toolUse: boolean;
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
flat rates; missing fields fall back to flat rates. Example:
`tiers['flex'] = { inputPerMTok: 0.5 }` gives discounted input at flex-tier
while the output rate stays at the flat rate.

### Internal storage

```ts
class ModelCatalog {
  private models: Map<string, ModelInfo>       // key: "provider/model" (canonical slug)
  private aliasIndex: Map<string, string>      // "provider/alias" -> "provider/canonical-slug"
}
```

`set(info: ModelInfo)` registers a model: inserts into `models` under the
canonical key, then iterates `info.aliases[]` to populate `aliasIndex`.
Aliases are stored as `"provider/alias" -> "provider/modelId"`.

`get(provider, modelId)`: checks `models` directly (canonical lookup), then
`aliasIndex` for an alias, then returns `undefined`. Does NOT throw -- callers
check for `undefined`.

`resolveModelId(provider, slug)`: follows alias chain and returns the provider's
canonical model ID (e.g. `"claude-3-5-sonnet-latest"` resolves to canonical).
Returns `slug` unchanged if no alias found.

### Provider defaults

`loadProviderDefaults()` loads the five built-in catalog JSON files via static
imports resolved at bundle time. Provider files live at:
`src/llm/providers/{provider}/catalog.json`.

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
  constructor(hooks: HookBus, catalog: ModelCatalog, opts?: CostCollectorOptions)
}

interface CostCollectorOptions {
  budgets?: BudgetSpec[];
  sessionBudget?: number;    // convenience: total USD limit for this instance
}
```

Calls `hooks.on('onCompletion', ...)` and `hooks.on('onMediaGenerated', ...)`.
Uses `hooks.emitSync` (NOT `emit`) for cost events -- `onCostEntry`,
`onBudgetWarning`, `onBudgetExceeded` are all sync.

### `handleCompletion` flow

1. Extract provider-reported cost via `extractProviderCost(response)`.
2. If no provider cost: compute via `calculateCost(catalog, provider, modelId, usage)`.
3. Build `CostEntry { provider, modelId, inputTokens, outputTokens, costUsd, tags?, timestamp }`.
4. Push to `this.entries[]`.
5. Accumulate into `this.byProvider`, `this.byModel`, `this.byTag` maps.
6. `hooks.emitSync('onCostEntry', { entry })`.
7. Call `checkBudgets(entry.costUsd)`.

### Provider cost extraction (`cost-collector-internal.ts:extractProviderCost`)

Two special-case providers:
- **openrouter**: `response.raw?.usage?.cost` -- OpenRouter injects total USD
  directly into the usage object.
- **xai** (Grok): `response.raw?.usage?.cost_in_usd_ticks / 1e10` -- xAI's
  API returns integer "USD ticks" (10-nanosecond units). Dividing by 1e10
  converts to USD.

All other providers: `undefined` (compute from token counts).

### `handleMediaGenerated` flow

Extracts `{ provider, mediaType, count?, durationSeconds? }` from the event.
Calls `mediaUnitCost(catalog, provider, mediaType, count, durationSeconds)`.
The `mediaUnitCost` helper looks up per-unit or per-second rates from the
model's pricing entry.

### Budget enforcement (`checkBudgets`)

```ts
interface BudgetSpec {
  scope?: { provider?, model?, tag? };  // undefined -> global
  limitUsd: number;
  thresholds?: number[];    // fraction of limitUsd, e.g. [0.7, 0.9]
  action?: 'warn' | 'stop'; // 'warn' default; 'stop' pauses watched agents
  watchedAgents?: AgentLoop[];
}
```

After each `CostEntry`, `checkBudgets` runs all budgets:
1. `matchesScope(entry, budget.scope)`: true if all scope fields match.
2. `getProviderTotal(this, budget.scope)`: sum of all matching entries.
3. For each `threshold` in `budget.thresholds[]`: if `total >= limitUsd * threshold`
   and not already notified -> `hooks.emitSync('onBudgetWarning', { budget, total })`.
4. If `total >= budget.limitUsd`:
   - `hooks.emitSync('onBudgetExceeded', { budget, total })`.
   - If `budget.action === 'stop'`: calls `.stop()` on each `AgentLoop` in
     `budget.watchedAgents`. Fire-and-forget (no await).
   - Budget is removed from the list to prevent repeated stop signals.

### Query API

```ts
collector.total: number                          // all-time USD
collector.byProvider: Map<string, number>
collector.byModel: Map<string, number>
collector.byTag: Map<string, number>
collector.entries: CostEntry[]
collector.query(filter): { totalUsd, breakdown }
collector.export(): SerializedCostState
collector.import(state: SerializedCostState): void  // merge into current
```

## Cost computation ladder (`cost-collector-internal.ts:computeCost`)

```text
computeCost(catalog, input: CostComputeInput)
  // CostComputeInput: { provider, model, tokens?, media?, providerEvidence?, tier? }
```

Four steps in priority order:

1. **Provider-reported total** -- if `extractProviderCost` returned a value,
   use it. Skip steps 2-4.
2. **Token cost** -- if `pricing.inputPerMTok` or `pricing.outputPerMTok`
   exist, compute via `calculateCost()`.
3. **Media unit cost** -- if this is a media generation (no tokens), compute
   via `mediaUnitCost()`.
4. **Unknown** -- return `$0.00` (honest zero, not `null`).

### `calculateCost(catalog, provider, model, tokens, providerEvidence, tier?)`

1. Fetch `pricing = catalog.getPricing(provider, model)`.
2. If `tier` is set AND `pricing.tiers?.[tier]`
   exists: merge `tiers[tier]` over flat rates (tier fields win;
   absent fields fall back to flat rates).
3. Compute:
   ```text
   inputCost      = (tokens.input / 1_000_000) * inputPerMTok
   outputCost     = (tokens.output / 1_000_000) * outputPerMTok
   cacheReadCost  = (tokens.cached / 1_000_000) * cacheReadPerMTok
   cacheWriteCost = (tokens.cacheWrite / 1_000_000) * cacheWritePerMTok
   reasoningCost  = (tokens.reasoning / 1_000_000) * outputPerMTok
   ```
   Also supports `audioInputPerMTok` / `audioOutputPerMTok` for audio tokens.
4. Cache-read tokens are billed at `cacheReadPerMTok` (defaults to `inputPerMTok * 0.1`).
   Cache-write at `cacheWritePerMTok` (defaults to `inputPerMTok * 1.25`).

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

- **`low`**: 0 output tokens. Minimum possible cost.
- **`expected`**: `resolveExpectedOutput()` -- uses `opts.expectedOutputTokens`
  if provided, else `DEFAULT_EXPECTED_OUTPUT_TOKENS = 512`.
- **`high`**: `resolveHighOutput()` -- uses `request.maxTokens`
  if set, else `catalog.get().maxOutput`, else
  `FALLBACK_MAX_OUTPUT_TOKENS = 4096`.

### Input token counting

`countInputTokens(counter, ctx, request, assumptions)`: uses `HybridTokenCounter`
for accurate per-model estimation (tiktoken / count-api / heuristic, per catalog).

`priceMediaParts(prompt, pricing, provider, model, assumptions)`: scans content
parts for images and audio, computing flat-rate media costs added to each bound.
Media cost is additive, independent of token cost.

`assumptions[]`: collects human-readable strings explaining which fallbacks
were applied. Examples: `"expected output tokens defaulted to DEFAULT_EXPECTED_OUTPUT_TOKENS=512"`,
`"max output from model catalog: 4096"`, `"image tokens approximated"`.

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
2. If entry is absent or has < 5 samples: return `base` unchanged.
3. Calibrated expected = `Math.round(entry.ewmaMean)`.
4. Calibrated high = `Math.min(Math.max(p90, ewmaMean), hardCeiling)`.
   `hardCeiling = request.maxTokens ?? catalog.maxOutput ?? FALLBACK_MAX_OUTPUT_TOKENS`.
5. Recomputes `cost.expected` and `cost.high` from the calibrated token counts.

The ceiling prevents calibrated high from exceeding the actual model maximum.
`expected` and `high` are always `>= low` (the `Math.max` guard ensures it).

## `OutputCalibrationStore` (`src/helpers/calibration-store.ts`)

Backed by the `Persistence` interface from `src/plugins/persistence/types.ts`
(same `get`/`set`/`list` interface used by the cache and context subsystems).

### Key structure

```text
OUTPUT_CALIBRATION_KEY_PREFIX + provider/model#bucket
// e.g. "output-calibration:anthropic/claude-3-5-sonnet-20241022#2000-8000"
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

P90_HISTOGRAM_BIN_WIDTH = 256   // tokens per bin
```

Bin index: `Math.min(Math.floor(outputTokens / 256), 31)` -- clamped to 31
(captures all output >= 7936 tokens in the last bin).

### `record(obs: CalibrationObservation)`

1. Resolve calibration key and load or initialize the entry.
2. EWMA update: `ewmaMean = alpha * outputTokens + (1 - alpha) * existing.ewmaMean`.
   `CALIBRATION_EWMA_ALPHA = 0.15`.
3. `histogram[binIndex] += 1`; `count += 1`.
4. Persist via `persistence.set(key, entry)`.

### `histogramQuantile(histogram, quantile)` -- p90

1. Sum all bin counts (`total`).
2. Target = `Math.ceil(quantile * total)` where `CALIBRATION_HIGH_QUANTILE = 0.9`.
3. Walk bins from 0 upward accumulating until cumulative >= target.
4. Return center of target bin: `(binIndex + 0.5) * 256`.

`p90(entry)`: returns `histogramQuantile(entry.histogram, 0.9)`.
`get(provider, model, inputTokens)`: returns `null` if entry is missing;
callers in `Estimator` check `entry.count < 5` before using calibration.

## Key invariants and gotchas

- **`computeCost` step 1 is exclusive**: if `extractProviderCost` returns a
  value (even `$0` for a free model), steps 2-4 are skipped entirely. The
  provider cost is authoritative.
- **`pricingTier` vs `serviceTier`**: `usage.serviceTier` is the provider's
  raw tier name in the response. `usage.pricingTier` is what the SDK maps it
  to for catalog lookup. `LLMClient` does the mapping in `parseResponse`.
- **Budget `action:'stop'` is not immediate**: `AgentLoop.stop()` sets a flag;
  the loop checks it at the top of the next iteration. Mid-step execution
  completes first.
- **Calibration requires >= 5 EWMA observations**: `p90()` returns `undefined`
  below this threshold; `Estimator.applyCalibratedBounds` skips calibration
  and returns the raw (uncalibrated) estimate unchanged.
- **`loadProviderDefaults()` is idempotent**: repeated calls re-register the
  same models; `set()` overwrites if the model already exists.
- **`estimate()` throws on unknown models**: callers must either handle
  `UnknownModelError` or ensure the model is registered before calling.
- **Alias resolution in the cost path**: `CostCollector` receives `modelId`
  from `CompletionResponse.modelId`, which provider adapters set to the
  canonical ID. `catalog.get()` with the canonical ID finds it directly;
  no alias lookup needed in the cost path.
- **Honest-zero applies in `calculateCost`, not `computeCost`**: the fallback
  to `estimatedInputTokens` happens inside `calculateCost` (step 2). If step 1
  short-circuits, `estimatedInputTokens` is never consulted.
