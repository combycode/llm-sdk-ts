---
title: Context Guard & Persistence
---

# Context Guard & Persistence

Source: `src/plugins/context-guard/`, `src/plugins/context-measurer/`,
`src/plugins/persistence/`, `src/plugins/cache/`.

## Purpose and responsibilities

Prevent context-window overflow at runtime and provide a unified storage layer for all
stateful SDK data. Four subsystems:

- **Persistence** — generic key-value store interface; two built-in implementations.
- **Cache** — TTL-keyed response cache built on top of Persistence.
- **ContextMeasurer** — subscribes to `onCompletion` and `onMessageResolve` events,
  counts tokens in flight, triggers exact measurement near the window limit, and emits
  `onContextMeasure` when a threshold is crossed. Runs the calibration learning loop.
- **ContextGuard** — reacts to `onContextMeasure` events; routes to a per-conversation
  `ContextStrategy`; applies compaction, warning, or decline actions.

Does NOT own a network connection. ContextGuard's LLM-backed compaction calls go through
the injected `ContextTools` (which calls `InternalToolRunner` or a custom implementation),
not through a private fetch.

---

## Persistence

### `Persistence` interface (`src/plugins/persistence/types.ts`)

```ts
interface Persistence {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  has(key: string): Promise<boolean>;
}
```

**Consumers**: `Cache` (via `FileCacheStore`), `PersistenceCalibrationStore`,
`Batcher` (pending jobs), `ResponseStore` (server conversation history),
`ConfigurationPlugin`, `Scheduler`.

### `MemoryPersistence` (`src/plugins/persistence/memory.ts`)

Backed by a `Map<string, unknown>`. Values are deep-copied via `structuredClone` (with a
`JSON.parse(JSON.stringify(...))` fallback) on both `get` and `set`, matching the
serialize/deserialize semantics of `FilePersistence`. This prevents callers from mutating
stored objects through retained references.

Extra non-interface affordances for tests: `.size` (number of entries), `.clear()`.

### `FilePersistence` (`src/plugins/persistence/file.ts`)

One JSON file per key in a configured `dir`. `encodeKey` maps arbitrary key strings to
filesystem-safe names by %-escaping any character outside `[A-Za-z0-9_.-]`
(URL-style encoding). `decodeKey` reverses it on `list()`. Both functions are module-level
in `src/plugins/persistence/file.ts`.

The `ready: Promise<void>` field calls `mkdir(dir, { recursive: true })` at construction.
Every public method `await this.ready` before performing I/O. Writes are NOT atomic:
a crash between write and fsync can leave a partial file. Not safe for multi-process
concurrent writes without external locking.

Uses `nodeFsPromises()` from `src/runtime/runtime.ts` — browser-guarded.

---

## Cache

### Architecture (`src/plugins/cache/cache.ts` + `src/plugins/cache/types.ts`)

```ts
interface CacheEntry<T = unknown> {
  body: T; storedAt: number; ttlMs: number; cacheName: string;
}

interface CacheStore {
  get<T>(storageKey: string): Promise<CacheEntry<T> | null>;
  set<T>(storageKey: string, entry: CacheEntry<T>): Promise<void>;
  delete(storageKey: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
}
```

`Cache` is content-agnostic. It does not compute cache keys — that is the caller's
responsibility (`LLMClient` computes a hash over the normalized request body when a
`cacheKeyFn` is provided). `Cache` only manages TTL, storage key composition, and lazy
expiry.

**Storage key format**: `cache:{cacheName}:{cacheKey}`. `parseStorageKey` splits on
the second colon to recover `cacheName` and `cacheKey` for `invalidate()` scope filtering.

**TTL**: per-entry, stored in `CacheEntry.expiresAt` as `storedAt + ttlMs`. Detected
lazily on `get()` — the entry is deleted at that point. No background sweep. Default
`ttlMs` at construction is 5 minutes (`DEFAULT_TTL_MS = 5 * 60 * 1000`). Pass
`Number.POSITIVE_INFINITY` for entries that never expire.

`invalidate(scope)` lists all keys under the `cache:` prefix and deletes entries matching
`scope.cacheName` and/or `scope.keyPrefix`. `clear()` drops everything from the store
(including non-cache-prefixed entries if the store is shared).

Built-in stores: `MemoryCacheStore` (`src/plugins/cache/memory-store.ts`) and
`FileCacheStore` (`src/plugins/cache/file-store.ts`). Both implement `CacheStore` directly
(not via `Persistence`). `FileCacheStore` uses `nodeFsPromises()`.

---

## ContextMeasurer

### Architecture (`src/plugins/context-measurer/measurer.ts`)

```ts
interface ContextMeasurerConfig {
  hooks: HookBus; catalog: ModelCatalog;
  counter?: TokenCounter;
  persistence?: Persistence;
  calibrationStore?: CalibrationStore;
  countApiKeys?: { anthropic?: string; google?: string };
  thresholds?: Partial<ContextThresholds>;
  calibration?: Partial<CalibrationConfig>;
}
```

`ContextMeasurer` wires two hooks at construction:

1. `onCompletion` → `learnFromCompletion`: records `(bytesSent, actualTokens)` in the
   calibration store for the provider/model pair.
2. `onMessageResolve` → `measureAndEmit`: measures token count, optionally upgrades to
   exact measurement near the threshold, emits `onContextMeasure`. If `onContextMeasure`
   listeners set `ctx.abort = true` (e.g., from `ContextGuard`), propagates `ctx.abort`
   and `ctx.abortReason` back to `onMessageResolve` so the LLMClient can reject the call.

`destroy()` removes both subscriptions. `warmCache()` pre-loads calibration data from
persistence so the first estimate is not cold.

### `measureAndEmit` flow (`src/plugins/context-measurer/measurer.ts`)

1. Sum `counter.estimate(system, ctx)` + `counter.estimateMessage(msg, ctx)` for each
   message → `total`.
2. Look up `catalog.get(provider, model)?.contextWindow` → `window`.
3. Compute `percentage = total / window` (null when window is unknown).
4. If `percentage >= thresholds.exact` (default 0.90): attempt exact measurement via
   `counter.measure` / `counter.measureMessage` with `accuracy: 'exact'`. On failure,
   keep the fast estimate.
5. Emit `onContextMeasure` with `{ provider, model, current, window, percentage, accuracy,
   messages, system, history, abort, abortReason }`.
6. After emit: if not aborted, recompute token count with the fast counter (messages may
   have been mutated by `ContextGuard`).

### `HybridTokenCounter` (`src/plugins/context-measurer/counter/hybrid.ts`)

Routes per `ModelInfo.tokenizer.strategy` from the catalog:

- `'tiktoken'` → `TiktokenCounter` (`src/plugins/context-measurer/counter/tiktoken.ts`):
  exact for OpenAI tokenization; requires optional `tiktoken` dep.
- `'count_api'` → `CountApiCounter` (`src/plugins/context-measurer/counter/count-api.ts`):
  exact via Anthropic (`/v1/messages/count_tokens`) or Google count-tokens endpoint.
  Requires `countApiKeys` in config.
- `'heuristic'` (default) → `HeuristicCounter`
  (`src/plugins/context-measurer/counter/heuristic.ts`): calibration-aware `~chars/4`
  estimate. Reads the correction factor from `CalibrationStore` to converge toward actual
  counts over time.

The `learn(input: LearnInput)` method is only implemented on `HeuristicCounter` (no-op on
the others). `HybridTokenCounter.learn()` delegates straight to `this.heuristic.learn()`.

### Calibration (`src/plugins/context-measurer/calibration/store.ts`)

`PersistenceCalibrationStore` maintains EWMA-based `charsPerToken` entries per
`(provider, model, contentClass?)` tuple, backed by `Persistence`.

Key format: `calibration:{provider}/{model}` or `calibration:{provider}/{model}:{contentClass}`.

`update(input)` merges a new observation:
```text
newCharsPerToken = alpha * input.charsPerToken + (1 - alpha) * existing.charsPerToken
confidence = min(1, samples / minSamplesForConfidence)
```
Defaults from `CONTEXT_DEFAULTS` in `src/plugins/context-measurer/types.ts`:
`emaAlpha = 0.2`, `minSamplesForConfidence = 10`.

`ContextThresholds.warn = 0.80`, `exact = 0.90`.

---

## ContextGuard

### Architecture (`src/plugins/context-guard/guard.ts`)

```ts
interface ContextGuardConfig {
  hooks: HookBus; measurer: ContextMeasurer;
  contextTools?: ContextTools;       // defaults to NoopContextTools
  strategies: Record<string, ContextStrategy>;
  defaultStrategy: string;
  onUnknownStrategy?: UnknownStrategyPolicy;  // 'skip' | 'fallback-default' | 'throw'
  maxCompactRetries?: number;        // default 2
  criticalFloor?: number;            // default 0.95
}
```

`ContextGuard` is **stateless** between calls. Per-conversation state is stored in
`history.metadata[STATE_KEY][GUARD_STATE_SUBKEY]` (`STATE_KEY = '__orxa'`,
`GUARD_STATE_SUBKEY = 'contextGuard'`) as a `GuardConversationState` object:

```ts
interface GuardConversationState {
  v: 1;
  lastLevelIdx: number;    // highest trigger index that has fired
  lastCurrent: number;     // token count at last fire
  strategyState?: Record<string, Record<string, unknown>>;  // per-strategy state bags
}
```

Multiple conversations sharing one `ContextGuard` instance is safe and the intended use.

`destroy()` unsubscribes from `onContextMeasure`. Must be called when the guard is
discarded to prevent memory leaks.

### Trigger resolution and firing (`src/plugins/context-guard/guard.ts`)

`getSortedTriggers(strategy)` sorts `strategy.triggers` by `at` ascending and caches
in `this.triggerCache`. `highestCrossedLevel(triggers, percentage)` returns the index
of the highest `trigger.at <= percentage` (module-level function, `guard.ts`).

Firing logic in `handleMeasure`:

1. Compute `crossedIdx = highestCrossedLevel(triggers, ctx.percentage)`.
2. Read `prevLevelIdx` and `lastCurrent` from `GuardConversationState`.
3. Fire only if `isNewCrossing` (crossed a new, higher level) or `isClimbing`
   (still at the same highest level but token count is growing and `delta > 0`).
4. Update state before delegating to the strategy so the state is consistent even
   if the strategy throws.

### Strategy resolution (`resolveStrategy`, `src/plugins/context-guard/guard.ts`)

Reads `history.metadata.contextStrategy`:
- `false` → skip (opt-out for a conversation).
- Non-empty string matching a registered key → use that strategy.
- Missing / empty / unknown string → use `defaultStrategy`.

Unknown strategy names: behaviour controlled by `onUnknownStrategy`. Warning is emitted
via `onWarning` once per name (deduplicated in `warnedUnknownStrategies`).

### `ContextStrategy` interface (`src/plugins/context-guard/types.ts`)

```ts
interface ContextStrategy {
  readonly triggers: TriggerLevel[];
  react(ctx: ReactContext): StrategyDecision | Promise<StrategyDecision>;
}

type StrategyDecision =
  | { action: 'none' }
  | { action: 'compacted'; note?: string }
  | { action: 'warn'; message: string }
  | { action: 'decline'; reason: string };
```

`ReactContext` carries `{ level, percentage, current, window, delta, provider, model,
attempt, tools: StrategyTools, state }`. The `state` bag is per-strategy, per-conversation,
and persists across calls in `GuardConversationState.strategyState`.

Retry loop in `handleMeasure`: after a `'compacted'` decision, `ContextGuard` re-measures
tokens (via `tools.measure(ctx.messages)`) and recomputes the percentage. If still above
`criticalFloor` and at or above the trigger's threshold, it increments `attempt` and calls
`strategy.react()` again, up to `maxCompactRetries` (default 2). On exhaustion, it sets
`ctx.abort = true` with a `'context_exhausted'` warning.

`decline` decisions set `ctx.abort = true` synchronously and do not retry.

### `StrategyTools` / `StrategyToolsImpl` (`src/plugins/context-guard/tools.ts`)

The `StrategyTools` interface is what strategies call. `StrategyToolsImpl` is the
implementation the guard creates per `handleMeasure` invocation:

```ts
interface StrategyTools {
  segment(opts?: { recentCount?: number; timeWindow?: number }): { recent, middle, old };
  measure(items: readonly HistoryEntry[] | Message[]): number;
  extractFacts(entries: readonly HistoryEntry[], categories?: string[]): Promise<ExtractedFact[]>;
  summarize(entries: readonly HistoryEntry[], maxLength: number, focus?: string): Promise<string>;
  replaceRange(from: number, to: number, replacement: Message): void;
  dropOldest(n: number): void;
  injectFacts(facts: ExtractedFact[], site: FactInjectionSite): void;
  readonly historyLength: number;
}
```

`replaceRange` calls `history.spliceRange(from, to, replacement)` then rebuilds
`activeMessages` in place (`activeMessages.length = 0; push(...history.messages())`).
This ensures the current `onMessageResolve` context reflects the compaction immediately
so the re-measurement in the retry loop sees the shorter message list.

`dropOldest(n)` calls `history.clear()` when `n >= total`, else `history.truncate(total -
n)`, then rebuilds `activeMessages` the same way.

`injectFacts` with site `'system-append'` writes facts to the `ContextRegistry` layer
`LAYER_CHAT_FACTS` (defined in `src/agent/context-registry/layers.ts`) with
`mergeParent: true`. With site `'first-user-prefix'` it prepends a rendered facts block
to the first user message in `activeMessages` and the matching `HistoryEntry`.

`segment` splits history by `recentCount` (last N entries are recent; remainder split in
half between old and middle) or by `timeWindow` (time-based zones). Without opts, it
divides into even thirds.

### `ContextTools` / `RunnerContextTools` (`src/plugins/context-guard/types.ts`)

`ContextTools` is the LLM-backed helper interface:

```ts
interface ContextTools {
  summarize(content: string, maxLength: number, focus?: string): Promise<string>;
  extractFacts(content: string, categories?: string[]): Promise<ExtractedFact[]>;
}
```

`NoopContextTools` returns empty string and empty array. Used as default — sufficient for
`TruncateStrategy`, which does not call either method.

`RunnerContextTools` delegates `summarize` to `orxa:summarize@1.0.0` and `extractFacts`
to `orxa:fact-extract@1.0.0` via `InternalToolRunner`. The fact-extract tool is optional
(returns `[]` if absent from the registry).

### Built-in strategies

**`TruncateStrategy`** (`src/plugins/context-guard/strategies/truncate.ts`):

Drops the oldest `n = total - keepRecent` entries via `tools.dropOldest(n)`. Single
trigger at `{ level: 'urgent', at: 0.85 }` by default. `declineCeiling = 0.95`:
if still above after dropping, returns `'decline'`. No LLM calls. Works with
`NoopContextTools`.

**`LayeredStrategy`** (`src/plugins/context-guard/strategies/layered.ts`):

Four trigger levels with defaults `{ 'healthy': 0.5, 'pressure': 0.7, 'urgent': 0.85,
'critical': 0.95 }`. Zones: old / middle / recent (split by `recentCount`, default 6).

Action per level:
- `'healthy'` → `compactOldLayer`: summarize + fact-extract old zone, replace with one
  entry, inject facts to `'system-append'`.
- `'pressure'` → `compactOldAndMiddle`: same for old, then summarize middle zone.
- `'urgent'` → `compactAll`: old+middle compacted, then shrink recent to `recentCount/2`.
- `'critical'` → `compactAggressive`: keep last 2 entries, compact everything else.

Jump-escalation (`applyJumpEscalation`): if `delta / window >= jumpEscalateDelta`
(default 0.3), escalates to the next trigger level. This handles the case where context
jumped dramatically in a single request (e.g., a very large tool result).

`declineCeiling = 0.9` (default): if still above this after at least one attempt, returns
`'decline'` immediately without further retries.

### Facts wire format (`src/plugins/context-guard/tools.ts`)

Facts are rendered as markdown bullet lines:
```text
<!-- orxa:facts -->
## Key facts (preserved across compaction)
- key_name [category]: value
<!-- /orxa:facts -->
```

`FACTS_OPEN = '<!-- orxa:facts -->'` and `FACTS_CLOSE = '<!-- /orxa:facts -->'` are
the boundary markers used by `parseFactsBlock` to extract facts from a system prompt.
`readFactsLayer` reads from the `ContextRegistry` layer directly if set, parsing the
`metadata.facts` field first before falling back to text parsing.

### `ExtractedFact` (`src/plugins/context-guard/facts.ts`)

```ts
interface ExtractedFact {
  key: string;     // short label, lowercase, snake_or_dotted
  value: string;   // verbatim from source
  category: FactCategory;  // 'name'|'date'|'time'|'path'|'url'|'email'|...|'other'
  span?: string;   // surrounding context for disambiguation
}
```

---

## Data flow

```text
LLMClient emits onMessageResolve
  -> ContextMeasurer.measureAndEmit:
       fast estimate -> upgrade to exact near threshold
       -> hooks.emit('onContextMeasure', ctx)
          -> ContextGuard.handleMeasure:
               resolveStrategy(history)
               getSortedTriggers(strategy) [cached]
               read GuardConversationState from history.metadata
               highestCrossedLevel(triggers, percentage) [module fn]
               if crossing: strategy.react(reactCtx)
                 'warn'     -> hooks.emit('onWarning')
                 'decline'  -> ctx.abort = true
                 'compacted'-> tools.measure(), recompute, retry up to maxRetries
                 'none'     -> return
               write updated state to history.metadata
  <- ctx.abort propagated back to onMessageResolve
  <- LLMClient aborts the call if ctx.abort

LLMClient emits onCompletion
  -> ContextMeasurer.learnFromCompletion:
       counter.learn({ provider, model, bytesSent, actualTokens })
       -> HeuristicCounter.learn()
          -> PersistenceCalibrationStore.update() [EWMA update, async]
```

---

## Extension points

**Persistence**: implement `Persistence` and pass it to `ContextMeasurerConfig.persistence`,
`BatcherConfig.persistence`, `ResponseStore`, etc.

**Cache store**: implement `CacheStore` for a custom backend (Redis, SQLite, etc.) and pass
to `Cache` at construction.

**Token counter**: implement `TokenCounter` and pass to `ContextMeasurerConfig.counter` to
bypass `HybridTokenCounter` entirely.

**Calibration**: implement `CalibrationStore` and pass to
`ContextMeasurerConfig.calibrationStore` to replace `PersistenceCalibrationStore`.

**Context strategy**: implement `ContextStrategy` and register it in
`ContextGuardConfig.strategies`. Set `history.metadata.contextStrategy = 'yourKey'` per
conversation.

**Context tools**: implement `ContextTools` and pass to `ContextGuardConfig.contextTools`.
Use `RunnerContextTools` with a custom `summarizeId` / `factExtractId` to point to your
own internal tools.

---

## Gotchas and edge cases

- `ContextGuard.destroy()` must be called to unsubscribe from `onContextMeasure`. Omitting
  it leaks a subscription and keeps the guard running for every future measurement.
- `ContextGuard` is stateless but its state is stored in `history.metadata`. If you replace
  the `ConversationHistory` object for a conversation (rather than mutating it), the guard
  state is lost and triggers will re-fire.
- `TriggerLevel.at` values must be ascending. `getSortedTriggers` sorts them but the sort
  is cached after the first call per strategy instance. Mutating `strategy.triggers` after
  construction produces undefined behaviour.
- `LayeredStrategy.compactOldAndMiddle` adjusts middle indices by `replacedOld` (0 or 1)
  to account for the range already replaced. If both old and middle are non-empty, the
  replacement is a two-step in-place mutation of history. The order matters.
- `StrategyToolsImpl.extractFacts` reads prior facts from the `ContextRegistry` or the
  system prompt's facts block. The LLM is instructed to carry them forward. If
  `contextTools.extractFacts` returns an empty array, prior facts are discarded on the
  next `injectFacts` call because `renderFactsLayer([])` produces an empty-body layer.
- `FilePersistence` key encoding uses `%xx` style but the regex `[^a-zA-Z0-9_\-.]` omits
  `/` — keys containing `/` (e.g., `calibration:openai/gpt-4o`) are encoded as
  `calibration%3aopenai%2fgpt-4o`. The `list()` method filters by the decoded key prefix
  after decoding all filenames, so prefix queries work correctly.
- `Cache.get()` deletes expired entries lazily. Long-lived processes with infrequently
  accessed cache namespaces accumulate stale entries until they are read. Call
  `cache.invalidate({})` on a schedule to prune them explicitly.
- `ContextMeasurer.measureAndEmit` re-runs the fast estimate after `onContextMeasure`
  returns (when not aborted) to reflect any mutations made by `ContextGuard`. This means
  the `total` returned is always a post-compaction fast estimate, even when exact counting
  was used inside the hook.
