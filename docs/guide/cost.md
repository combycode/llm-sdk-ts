---
title: Cost Tracking and Estimation
description: Pre-flight cost estimation, live session tracking, budget alerts, and adaptive calibration.
---

# Cost Tracking and Estimation

## What you will achieve

By the end of this guide you will be able to (1) get a three-bound cost estimate before sending a request, (2) block requests that exceed a budget limit before any network call is made, (3) track a live running total across every completion in a session, and (4) optionally enable adaptive calibration so estimates improve over time from real observed output-token counts.

## When and why you need this

- You run batch jobs where a single mis-configured request could cost dollars instead of fractions of a cent.
- You want a soft warning and a hard stop when session spend approaches a ceiling.
- You are building a multi-agent system and need per-agent or per-tag cost breakdowns.
- You want pre-flight estimates to be progressively more accurate as you accumulate real completions.

## Step by step

### Step 1 -- pre-flight estimate with `estimate()`

`estimate()` is a pure function: no network calls, no LLM provider involved. It counts input tokens via the built-in `HybridTokenCounter` (heuristic when no local tokenizer is available) and prices the result using the same `ModelCatalog` rates that the live `CostCollector` uses.

```ts
import { estimate } from '@combycode/llm-sdk';

const est = await estimate({
  model: 'anthropic/claude-haiku-4.5',
  prompt: 'Write a 500-word essay on climate change.',
  maxTokens: 800,
});

console.log(`Low (0 output):      $${est.cost.low.toFixed(6)}`);
console.log(`Expected (~${est.estOutputTokens} tokens): $${est.cost.expected.toFixed(6)}`);
console.log(`High (max output):   $${est.cost.high.toFixed(6)}`);
console.log('Assumptions:', est.assumptions);
```

The `assumptions` array explains every default the function applied -- which output-token default was used, whether a heuristic counted the input, and whether images or audio were present but unpriced.

### Step 2 -- understand the three bounds

| Bound | Output tokens used | Use this to... |
|---|---|---|
| `low` | 0 (input cost only) | Confirm the minimum you will be charged |
| `expected` | `opts.expectedOutputTokens` or `DEFAULT_EXPECTED_OUTPUT_TOKENS` (512) or `maxTokens` if smaller | Day-to-day budget planning |
| `high` | `maxTokens` (if set) or `catalog.maxOutput` | Worst-case capacity planning |

Supply your own expected output count when you have context:

```ts
const est = await estimate(
  { model: 'openai/gpt-4.1-nano', prompt: 'Summarize in one sentence.', maxTokens: 200 },
  { expectedOutputTokens: 40 },   // you expect ~40 output tokens
);
```

### Step 3 -- block requests with a budget guard

Pass `maxCostUsd` to `complete()` (or any one-shot helper). The SDK runs `estimate()` internally, compares the chosen bound against the limit, and throws `BudgetExceededError` before making any network call.

```ts
import { complete, BudgetExceededError } from '@combycode/llm-sdk';

try {
  const { text } = await complete({
    model: 'anthropic/claude-opus-4.5',
    apiKey: process.env.ANTHROPIC_API_KEY,
    prompt: 'Write a 10,000-word historical novel.',
    maxTokens: 10_000,
    maxCostUsd: 0.05,      // reject before sending if estimate > $0.05
    budgetBound: 'high',   // compare the worst-case bound (default: 'expected')
  });
  console.log(text);
} catch (err) {
  if (err instanceof BudgetExceededError) {
    console.error('Blocked:', err.message);
    console.log('Bound checked:', err.bound);      // 'high'
    console.log('Estimated cost:', err.costUsd);   // cost for that bound
    console.log('Limit was:', err.maxCostUsd);
  }
}
```

`BudgetExceededError` carries the full `EstimateResult` in `err.estimate` so you can log the breakdown or show it to the user.

### Step 4 -- live tracking with `CostCollector`

`engine.cost` is a `CostCollector` instance wired automatically when you call `createEngine()` with `catalog: 'defaults'`. Every completion fires the `onCompletion` hook and the collector records a `CostEntry` in its in-process ledger.

```ts
import { createEngine, complete } from '@combycode/llm-sdk';

const engine = createEngine({
  catalog: 'defaults',
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});

await complete({ model: 'anthropic/claude-haiku-4.5', prompt: 'Hello' });
await complete({ model: 'anthropic/claude-haiku-4.5', prompt: 'World' });

// Aggregate the whole session:
const summary = engine.cost.total();
console.log(`Total:        $${summary.total.toFixed(6)}`);
console.log(`Input tokens: ${summary.tokens.input}`);
console.log(`Output tokens: ${summary.tokens.output}`);
console.log(`Entries:      ${summary.entries}`);
```

All summary fields are in USD. The `CostSummary` type:

```ts
interface CostSummary {
  input: number;       // input token cost (USD)
  output: number;      // output token cost (USD)
  cacheRead: number;   // cache-read token cost (USD)
  cacheWrite: number;  // cache-write token cost (USD)
  reasoning: number;   // reasoning token cost (USD)
  total: number;       // sum of all above (USD)
  tokens: {
    input: number;
    output: number;
    cached: number;
    cacheWrite: number;
    reasoning: number;
  };
  entries: number;     // number of completions included
}
```

### Step 5 -- slice by provider, model, or tag

```ts
// Break down spend by provider:
const byProvider = engine.cost.byProvider();
console.log(byProvider['anthropic'].total);

// Break down by 'provider/model' key:
const byModel = engine.cost.byModel();
console.log(byModel['anthropic/claude-haiku-4.5'].total);

// Tag completions at the collector level:
engine.cost.setTag('feature', 'summarizer');
// ... run some completions ...
const byFeature = engine.cost.byTag('feature');
console.log(byFeature['summarizer'].total);
```

Pass a `CostFilter` to any query method to narrow the window:

```ts
const recentSummary = engine.cost.total({
  provider: 'anthropic',
  after: Date.now() - 60_000,  // last 60 seconds
});
```

### Step 6 -- budget rules with alerts and auto-stop

```ts
import { createEngine } from '@combycode/llm-sdk';

const engine = createEngine({
  catalog: 'defaults',
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});

// Add a budget: warn at 80%, stop at 100%.
engine.cost.addBudget({
  id: 'session',
  limit: 0.10,          // $0.10 ceiling (real field name: limit, not limitUsd)
  scope: {},            // empty scope = matches all entries
  thresholds: [0.8],    // fire onBudgetWarning at 80% (real field: thresholds, not warningThresholds)
  action: 'warn',       // 'warn' logs; 'stop' calls stop() on watched agents
});

engine.hooks.on('onBudgetWarning', (ctx) => {
  // ctx: { budgetId, scope, limit, current, threshold, percentage }
  console.warn(`Budget "${ctx.budgetId}" at ${ctx.percentage.toFixed(0)}%:`,
    `$${ctx.current.toFixed(6)} of $${ctx.limit}`);
});

engine.hooks.on('onBudgetExceeded', (ctx) => {
  // ctx: { budgetId, scope, limit, current, overage }
  console.error(`Budget "${ctx.budgetId}" exceeded by $${ctx.overage.toFixed(6)}`);
});
```

To automatically stop a running agent when a budget is exceeded, use `action: 'stop'` and register the agent with `watchAgent`:

```ts
import { createAgent } from '@combycode/llm-sdk';

const agent = createAgent({ model: 'anthropic/claude-haiku-4.5', engine });

engine.cost.addBudget({
  id: 'agent-run',
  limit: 0.02,
  scope: {},
  thresholds: [0.9],
  action: 'stop',
});

engine.cost.watchAgent(agent);  // agent.stop() is called when budget is exceeded
```

## Your options

### `estimate()` request and options

```ts
// Request shape (same fields complete() understands):
interface EstimateRequest {
  model: string;          // 'provider/model' or bare model name
  provider?: ProviderName; // required when model is bare
  prompt: string | ContentPart[] | Message[];
  system?: string;        // system prompt; included in input-token count
  maxTokens?: number;     // controls the 'high' bound
}

// Options:
interface EstimateOptions {
  expectedOutputTokens?: number;  // overrides DEFAULT_EXPECTED_OUTPUT_TOKENS for 'expected' bound
  engine?: EngineHandle;           // falls back to the global engine (coreRegistry)
}
```

`estimate()` throws `UnknownModelError` when the model is not in the catalog. This is intentional -- returning $0 silently would be worse. Register custom models via `engine.catalog.set()`.

### Budget `addBudget` options

```ts
interface Budget {
  id: string;                        // unique key; used in hook payloads
  limit: number;                     // spending ceiling in USD
  scope: Record<string, string | undefined>; // filter: {} matches all; { provider: 'anthropic' } scopes
  thresholds: number[];              // fractions of limit that trigger onBudgetWarning (e.g. [0.5, 0.8])
  action: 'warn' | 'stop';          // 'warn' = event only; 'stop' = also calls stop() on watched agents
}
```

`removeBudget(id)` removes a budget without affecting already-recorded entries.

### `CostFilter` options

```ts
interface CostFilter {
  provider?: string;
  model?: string;
  runId?: string;
  conversationId?: string;
  sessionId?: string;
  after?: number;   // Unix timestamp (ms)
  before?: number;  // Unix timestamp (ms)
  [key: string]: string | number | undefined; // any tag key
}
```

### `maxCostUsd` and `budgetBound` on `complete()`

| Option | Default | What it controls |
|---|---|---|
| `maxCostUsd` | none (guard disabled) | Ceiling in USD; throws `BudgetExceededError` when exceeded |
| `budgetBound` | `'expected'` | Which estimate bound is compared: `'low'`, `'expected'`, or `'high'` |

Use `budgetBound: 'high'` when you want the guard to fire only if the absolute worst case exceeds the limit. Use `budgetBound: 'low'` to block anything whose input alone is already too expensive.

## Opt-in adaptive calibration with `Estimator`

The free `estimate()` function uses `DEFAULT_EXPECTED_OUTPUT_TOKENS = 512` as the expected output when you do not supply `expectedOutputTokens`. The `Estimator` class replaces that heuristic with learned statistics gathered from real completions.

### How calibration works

For each `provider/model` + input-size bucket the store maintains:
- An EWMA mean of observed output-token counts (`alpha = 0.15` -- slow, stable).
- A 32-bin fixed-width histogram with bins of 256 tokens each, from which it reads the p90.
- `expected` uses the EWMA mean; `high` uses the p90, capped at `maxTokens` or the catalog's `maxOutput`.

The input is bucketed by token count: `0-500`, `500-2000`, `2000-8000`, `8000-32000`, `32000+`. This means a short prompt and a long prompt for the same model get separate calibration statistics.

When no data exists for a key the `Estimator` falls back exactly to `estimate()` behavior -- there is no penalty for using it before data has accumulated.

### In-memory calibration (ephemeral)

```ts
import { createEngine, Estimator } from '@combycode/llm-sdk';

const engine = createEngine({
  catalog: 'defaults',
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});

const estimator = new Estimator({ calibration: { store: 'memory' } });

// Wire to the engine: every completion automatically updates the store.
const unsub = estimator.subscribeToEngine(engine);

// After a few completions, estimates improve:
const est = await estimator.estimate({
  model: 'anthropic/claude-haiku-4.5',
  prompt: 'Hello',
});
// est.assumptions includes: "calibrated: expected from N samples (claude-haiku-4.5#0-500)"
console.log(est.cost.expected);

// Clean up when done:
unsub();
```

### File-backed calibration (survives restarts)

```ts
const estimator = new Estimator({
  calibration: { store: 'file', path: './calibration-data' },
});
const unsub = estimator.subscribeToEngine(engine);
// JSON files in ./calibration-data/ accumulate observations across process restarts.
```

The `path` directory is created automatically on the first write. Each `provider/model#bucket` key gets its own JSON file. The files are small: one per key, containing only the EWMA mean, histogram array, count, and timestamp.

### Manual recording without engine wiring

```ts
await estimator.record({
  provider: 'anthropic',
  model: 'claude-haiku-4.5',
  inputTokens: 320,
  outputTokens: 740,
});
```

Use this in testing harnesses or when you process completions from a log file.

### Calibration option constants

| Exported constant | Value | Meaning |
|---|---|---|
| `DEFAULT_EXPECTED_OUTPUT_TOKENS` | 512 | Default output tokens when neither `expectedOutputTokens` nor `maxTokens` is set |
| `FALLBACK_MAX_OUTPUT_TOKENS` | 4096 | Used for the `high` bound when the catalog has no `maxOutput` for the model |
| `CALIBRATION_EWMA_ALPHA` | 0.15 | EWMA smoothing factor; lower = slower to adapt, more stable |
| `INPUT_SIZE_BUCKET_EDGES` | [500, 2000, 8000, 32000] | Upper boundaries for input-size buckets |
| `INPUT_SIZE_BUCKET_LABELS` | [0-500, ...] | Human-readable bucket names used in calibration keys |

## Gotchas and next steps

**`addBudget` uses `limit`, not `limitUsd`.** The field on the `Budget` type is `limit: number`. Similarly the threshold array is `thresholds`, not `warningThresholds`. The hook payload carries `limit` and `current`, both in USD.

**The `onBudgetExceeded` hook fires once per budget per session.** Thresholds (e.g. 80%) also fire once. If you remove and re-add a budget (`removeBudget` then `addBudget`) the fired-threshold set is reset.

**`estimate()` uses a character heuristic for input tokens when no local tokenizer is loaded.** The heuristic is 4 chars per token. The `assumptions` array always says so. If you need precise input-token counts, wire a real tokenizer by registering it via the `HybridTokenCounter` path.

**Image and audio content parts are noted but partially unpriced at estimate time.** Images are priced with `perImage` from the catalog when available. Audio parts are noted in `assumptions` as unpriced because token count depends on duration, which is only known at runtime.

**`CostCollector.destroy()` unsubscribes from the hook bus.** If you create a `CostCollector` manually (outside `createEngine`) remember to call `collector.destroy()` when the session ends, or the hook subscription will leak.

**Related guides:**

- `/docs/guides/models-and-providers` -- model catalog, `getPricing`, custom model registration
- `/docs/guides/llm-client` -- `complete()` / `stream()` and `CompleteOptions`
- `/docs/guides/telemetry` -- hook bus and observability
- `/docs/examples/22-batch/` -- batch completions with per-item cost tracking
