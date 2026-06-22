---
title: Internal Tools
---

# Internal Tools

Source: `src/plugins/internal-tools/`.

## Purpose and responsibilities

A self-contained tool catalog and execution runtime, separate from the `AgentTool` type
used by `AgentLoop`. Internal tools are first-class, versioned, namespaced callable units
stored in pluggable backends.

Responsibilities:

- Discover and search tools across multiple backends (local in-memory registry, remote
  catalog, etc.).
- Select the best model for a tool call based on benchmark-derived compatibility data
  (`CompatFile`) with fallback to tool-declared `modelPreference`.
- Execute tools through `InternalToolRunner`, which pools `LLMClient` instances per
  model, injects them into the tool's execution context, validates input/output schemas,
  and emits observability hooks.
- Provide `defineLLMTool` and `defineTemplateTool` factory functions for building
  LLM-backed tools declaratively without writing `execute` logic manually.

Does NOT replace `AgentTool`. Internal tools are for SDK-internal or application-defined
operations that need their own LLM model selection and cost tracking, not for exposing
external tool schemas to the model during a chat loop.

---

## Key types (`src/plugins/internal-tools/types.ts`)

```ts
interface InternalTool {
  id: string;           // "namespace:name@semver" format (see id.ts)
  namespace: string; name: string; version: string;
  description: string;
  inputSchema: JsonSchema; outputSchema?: JsonSchema;
  execute: (input: unknown, ctx: InternalToolContext) => Promise<unknown>;
  modelPreference?: ModelPreference;
  recommendedThreshold?: number;  // min avg benchmark score for compat; default 100
  signature?: string; signedBy?: string; tags?: string[];
}

interface ModelPreference {
  preferredModel?: string;   // "provider/model" string
  fallbackModels?: string[];
  maxTokens?: number; temperature?: number;
}

interface InternalToolContext {
  hooks?: HookBus;
  client?: unknown;          // LLMClient pinned to chosen model (runner provides)
  modelId?: string;          // "provider/model" (runner provides)
  toolId?: string;
  counter?: TokenCounter;    // HybridTokenCounter (runner provides)
  recordLLMResponse?: (response: CompletionResponse) => void;
  [key: string]: unknown;    // open bag for tool-specific extras
}

interface ToolBackend {
  readonly name: string;
  list(): Promise<InternalTool[]>;
  get(id: string): Promise<InternalTool | null>;
}

type CompatFile = Record<string, { recommended: string[] }>;
```

`InternalToolContext.recordLLMResponse` is called by tool implementations (e.g.
`defineLLMTool`) after each internal LLM call. The runner captures `response.usage` so
cost tracking and benchmark metrics cover the tool's own LLM spend, not just the outer
agent call.

---

## Tool ID format (`src/plugins/internal-tools/id.ts`)

Format: `"namespace:name@semver"` — e.g. `"orxa:summarize@1.0.0"`.

Regex: `/^([a-z0-9_-]+):([a-z0-9_-]+)@([0-9]+\.[0-9]+\.[0-9]+)$/`

Functions:
- `parseToolId(id)` → `ParsedToolId` — throws on invalid format.
- `tryParseToolId(id)` → `ParsedToolId | null` — swallows errors.
- `formatToolId(namespace, name, version)` → validates each component separately
  before concatenating.
- `matchesVersion(requested, actual)` — exact equality only (no semver range resolution).
- `idWithoutVersion(id)` → `"namespace:name"` — strips the `@version` suffix.

---

## `ToolRegistry` (`src/plugins/internal-tools/registry.ts`)

Manages a list of `ToolBackend` instances with an invalidatable flat cache.

```ts
class ToolRegistry {
  addBackend(backend: ToolBackend): this  // throws on duplicate name; invalidates cache
  removeBackend(name: string): boolean    // invalidates cache
  invalidate(): void
  async get(id: string): Promise<InternalTool | null>
  async list(): Promise<InternalTool[]>
  async find(filter: ToolFilter, catalog?: ModelCatalog): Promise<InternalTool[]>
  async search(query: string, opts?: SearchOptions): Promise<InternalTool[]>
  modelsFor(toolId: string, opts?: { minScore?: number; catalog?: ModelCatalog }): string[]
}
```

**Cache**: `private cache: Map<string, InternalTool> | null`. `ensureCache()` builds the
flat map by iterating backends in registration order. First-added backend wins on id
conflicts — if two backends export a tool with the same id, only the first is visible.
Cache is atomically replaced after rebuild (not updated in place).

**Search scoring** (`scoreMatch`, private method): exact name = 100, name prefix = 80,
name substring = 60, exact tag = 50, tag substring = 40, description substring = 20.
No embedding-based semantic search. Results are sorted by score descending and capped by
`opts.limit` (default 20).

**`find` filter fields** (`ToolFilter`):
- `namespace`: exact match on `tool.namespace`.
- `prefix`: `tool.id.startsWith(prefix)`.
- `tag`: `tool.tags?.includes(tag)`.
- `model`: checks `catalog.get(provider, model)?.toolCompat?.[tool.id].score >= minScore`
  (default minScore 0.8).

**`modelsFor(toolId, opts)`**: iterates `catalog.list()`, reads
`(info as { toolCompat? }).toolCompat?.[toolId].score`, returns `"${provider}/${model}"`
strings scoring at or above `minScore`.

---

## `LocalToolBackend` (`src/plugins/internal-tools/backends/local.ts`)

In-memory `Map<string, InternalTool>`. The primary backend for statically registered
tools. Built-in tools are registered via `LocalToolBackend` in
`src/plugins/internal-tools/builtin/builtin.ts`.

---

## `InternalToolRunner` (`src/plugins/internal-tools/runner/runner.ts`)

```ts
interface InternalToolRunnerConfig {
  hooks: HookBus; registry: ToolRegistry;
  catalog?: ModelCatalog;
  engine?: EngineHandle;       // required for LLM-backed tools
  apiKeys: Partial<Record<ProviderName, string>>;
  defaultModel?: string;
  compat?: CompatFile;         // benchmark-derived recommended chains
  clientOptions?: Partial<LLMClientConfig>;
  counter?: TokenCounter;      // auto-created from catalog when absent
}
```

### Model resolution (`resolveModels`, private)

Precedence order, deduped with `Set`:
1. `compat?.[tool.id]?.recommended` — benchmark-derived, cheapest-first ordering.
2. `tool.modelPreference?.preferredModel`.
3. `tool.modelPreference?.fallbackModels`.
4. `config.defaultModel` — only when all other sources are empty.

`modelId` strings must be `"provider/model"` format. `parseModelId` splits on the first
`/` and throws when not found or at position 0.

### Key availability check (`assertKeyAvailability`, private)

Runs BEFORE execution (after tool lookup). Collects the provider set from all model ids in
the resolved list, intersects with `config.apiKeys`, and throws when no usable provider
exists. This prevents silently trying every model only to fail on the last one.

### Client pooling (`getClient`, private)

Pool key is `provider` by default. When `catalog.get(provider, model)?.requiresDedicatedClient`
is true, the pool key is `"provider/model"` to prevent sharing clients across models that
need isolated configuration. Clients are built via `createLLM({ engine, provider, model,
apiKey, hooks, ...clientOptions })`. The `engine` dependency means every pooled client's
HTTP flows through the `NetworkEngine` queue.

`destroy()` calls `client.destroy()` on all pooled clients and clears the map.

### Execution lifecycle

**Non-LLM tools** (when `resolveModels` returns empty): `executeNonLLM`. Single attempt,
no model resolution, `ctx.client` is undefined. Emits `onInternalToolCallStart` (with
`chosenModel: ''`) then `onInternalToolCallComplete` or `onInternalToolCallError`.

**LLM-backed tools**: `executeLLM`. Iterates the model list:
1. Skip models whose provider has no API key.
2. Get or create the pooled client.
3. Emit `onInternalToolCallStart { toolId, input, chosenModel, attempt }`.
4. Build `InternalToolContext` with `client`, `modelId`, `counter`, `recordLLMResponse`
   callback.
5. Call `tool.execute(input, ctx)`.
6. Validate output against `tool.outputSchema` (`validateOutput`, private) — emits
   `onWarning` with code `'output_schema_mismatch'` on type mismatch (does not throw).
7. Emit `onInternalToolCallComplete { toolId, input, output, chosenModel, latencyMs,
   attempts, usage? }`.
8. On failure: collect the error, emit `onInternalToolCallError`, emit `onWarning` with
   code `'internal_tool_fallback'` if more models remain, and continue to the next model.

If all models fail, throws `"Tool ${toolId} failed on all N model(s): ${summary}"` where
summary lists `model: error` pairs.

Input validation (`validateInput`, private) checks `tool.inputSchema.type === 'object'`,
verifies the input is an object (not array or primitive), and asserts all `required` fields
are present. Throws before `execute` is called.

---

## `defineLLMTool` (`src/plugins/internal-tools/runner/define.ts`)

Converts a declarative `LLMToolDefinition` into an `InternalTool` with a generated
`execute` function.

```ts
interface LLMToolDefinition {
  id: string; namespace: string; name: string; version: string;
  description: string;
  inputSchema: JsonSchema; outputSchema?: JsonSchema;
  systemPrompt?: string; userTemplate?: string;
  outputFormat?: 'text' | 'json';
  prepareInput?: (input: Record<string, unknown>) => Record<string, unknown>;
  resolveMaxTokens?: (input, ctx: ResolveMaxTokensContext) => number;
  outputExample?: unknown;
  variants?: PromptVariant[];
  modelPreference: ModelPreference;
  recommendedThreshold?: number; tags?: string[];
}
```

`execute` logic:

1. Extract `client` and `modelId` from `ctx` — throws when absent (runner must provide).
2. Split `modelId` into `provider` and `modelName` on the first `/`.
3. Apply schema defaults (`applySchemaDefaults`, private function) — fills in `default`
   values from `inputSchema.properties` for missing fields.
4. Call `def.prepareInput?.(vars)` to transform the input.
5. Select variant via `selectVariant(variants, { provider, model, mode })`.
6. Render `systemPrompt` and `userTemplate` via `renderTemplate` from
   `src/plugins/internal-tools/runner/template.ts`.
7. If `outputFormat === 'json'`: call `composeJsonSystemPrompt(withStructure)` to prepend
   `JSON_API_SYSTEM_PROMPT` (`src/plugins/internal-tools/runner/json-enforcement.ts`).
8. If `resolveMaxTokens` is set: call it with `(vars, { provider, model, counter })`.
9. Call `client.complete([{ role: 'user', content: user }], { system, maxTokens,
   temperature })`.
10. Call `ctx.recordLLMResponse?.(response)`.
11. If `outputFormat === 'json'`: parse via `parseJsonWithFences`
    (`src/plugins/internal-tools/runner/template.ts`) — strips markdown code fences before
    `JSON.parse`. Throws with the raw output on parse failure.
12. Return `response.text` for `outputFormat === 'text'`.

The tool has `Symbol.for('orxa:llm_tool_def')` set on it (constant `LLM_DEF_KEY`). Use
`getLLMToolDefinition(tool)` to retrieve the original `LLMToolDefinition` from a tool
instance.

---

## JSON enforcement (`src/plugins/internal-tools/runner/json-enforcement.ts`)

`JSON_API_SYSTEM_PROMPT` is a hardcoded multi-line instruction string that mandates raw
JSON output with no markdown fences, no prose, and no comments. It is prepended to the
tool's own system prompt via `composeJsonSystemPrompt(toolSystemPrompt)` using a
`'---'` separator.

`attachStructureGuidance` (private to `define.ts`) appends the `outputSchema` and
`outputExample` as fenced JSON blocks inside the tool's system prompt before the JSON API
instruction is prepended.

---

## Variant selection (`src/plugins/internal-tools/runner/variants.ts`)

`PromptVariant` extends `LLMToolDefinition` fields with an `id` and an optional
`providerMatch?: string | string[]` pattern. `selectVariant(variants, { provider, model,
mode })` picks the first variant matching `providerMatch` (substring check on
`"provider/model"`), falling back to the variant with `isDefault: true`, then the first
variant. Variants allow provider-specific prompt tuning (e.g. different token limits or
JSON instructions for different model families).

---

## Built-in tools (`src/plugins/internal-tools/builtin/`)

All registered via `LocalToolBackend` in `builtin.ts`. All use `defineLLMTool`:

| Tool id | File | Output format |
|---|---|---|
| `orxa:summarize@1.0.0` | `builtin/summarize.ts` | text |
| `orxa:classify@1.0.0` | `builtin/classify.ts` | json |
| `orxa:score@1.0.0` | `builtin/score.ts` | json |
| `orxa:structure@1.0.0` | `builtin/structure.ts` | json |
| `orxa:clarify@1.0.0` | `builtin/clarify.ts` | json |

All five call the context `client` internally. `RunnerContextTools` in
`src/plugins/context-guard/types.ts` wires `orxa:summarize@1.0.0` and
`orxa:fact-extract@1.0.0` (not a builtin — ships in extensions) to `ContextGuard`
strategy compaction.

---

## Extension points

**Custom backend**: implement `ToolBackend` (`readonly name`, `list()`, `get(id)`) and call
`registry.addBackend(backend)`. The backend is queried lazily and the cache is rebuilt.

**Custom tool**: create an `InternalTool` directly with a hand-written `execute` function,
or use `defineLLMTool` for LLM-backed tools. Register via `LocalToolBackend` or a custom
backend.

**Custom model selection**: implement `CompatFile` and pass as `config.compat` to
`InternalToolRunner`. The `recommended` array for each tool id overrides `modelPreference`
and should be ordered cheapest-first.

---

## Gotchas and edge cases

- `ToolRegistry` cache is invalidated on every `addBackend` / `removeBackend`. During
  cache rebuild, concurrent `get` / `list` calls all await the same `ensureCache()`
  invocation (the cache is set atomically at the end). There is no explicit lock — multiple
  concurrent callers trigger a single rebuild in practice due to the `if (this.cache)
  return` guard.
- Duplicate backend names throw immediately in `addBackend`. Duplicate tool ids across
  backends are silently resolved by first-registered wins.
- `InternalToolRunner.run(toolId, input)` looks up the tool from `registry.get(toolId)`.
  `registry.get` is exact-match by id (including version). There is no semver range
  matching — `registry.get('orxa:summarize')` returns null; the full versioned id is
  required.
- `assertKeyAvailability` runs before execution but after model resolution. If `compat` or
  `modelPreference` lists only providers with no API keys, the runner throws before calling
  `execute`, even for tools that do not actually make LLM calls. For non-LLM tools, pass
  an empty model list in `modelPreference` or rely on `resolveModels` returning `[]`.
- `executeNonLLM` emits `onInternalToolCallStart` with `chosenModel: ''`. Tools that
  introspect `ctx.modelId` will see `undefined` in this path.
- `defineLLMTool` wraps `client.complete` with a single user message. The system prompt
  and the user template are rendered separately. The context window is not managed — very
  long inputs can overflow; `resolveMaxTokens` gives tools a hook to compute `maxTokens`
  dynamically based on input length.
- `parseJsonWithFences` in `template.ts` strips leading/trailing ` ```json ` (or ` ``` `)
  blocks before calling `JSON.parse`. If the model produces multiple fenced blocks, only
  the first is extracted. Output that is valid JSON without fences is parsed directly.
- `outputSchema` validation in `validateOutput` only checks the top-level type (object,
  array, string, number, boolean). It emits a warning and does NOT throw — invalid outputs
  are returned to the caller. Use the warning to detect tool regressions.
