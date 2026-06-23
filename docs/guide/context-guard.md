# Context Guard + Permissions + Persistence + Cache

This group contains the cross-cutting safety and durability plugins: protecting
context windows from overflow, gating tool actions through a permission policy,
persisting data across restarts, and caching responses.

## When to reach for this

- Your agent runs long conversations and you need automatic context-window
  management (truncation, summarization, fact extraction) before hitting the
  model's context limit.
- You want to enforce a policy over what tools can access (files, URLs, shell
  commands) -- equivalent to OpenAI Agents SDK guardrails.
- You want conversation history or response data to survive process restarts.
- You want to cache repetitive identical requests to save cost and latency.

## Main exports

### Context guard + measurer

| Export | What it does |
|---|---|
| `ContextGuard` | Stateless engine that intercepts `onContextMeasure` hook events and routes each conversation to a compaction strategy when the context window fills. |
| `ContextMeasurer` | Counts tokens in the current conversation and emits `onContextMeasure` events. Plug into an `AgentLoop`. |
| `LayeredStrategy` | Compaction strategy: compress older history into a facts layer while preserving recent turns. |
| `TruncateStrategy` | Compaction strategy: drop oldest messages until within budget. |
| `CONTEXT_DEFAULTS` | Default thresholds: `{ thresholds: { warn: 0.8, exact: 0.9 }, calibration: {...}, charsPerTokenFallback: 4.0 }`. |

### Permissions

| Export | What it does |
|---|---|
| `PermissionPolicy` | Rule-based policy evaluator. Rules are matched in order; first match wins; no match = default deny. |
| `anyOfKind` / `fsGlob` / `shellGlob` / `urlPattern` / `memoryCategory` | Pre-built `TargetMatcher` factories for common access types. |
| `compileGlobs` / `globToRegex` | Glob helpers for building custom matchers. |

Type-only: `Rule`, `PermissionTarget`, `PermissionDecision`.

### Persistence

| Export | What it does |
|---|---|
| `MemoryPersistence` | In-memory key/value store (default when no persistence config is passed to `createEngine`). |
| `FilePersistence` | File-backed store. Each key maps to a JSON file in the configured directory. |

Type-only: `Persistence`, `FilePersistenceConfig`.

### Cache

| Export | What it does |
|---|---|
| `Cache` | Response cache plugin. Keyed by a hash of the normalized request. Plugs into `createEngine({ cache: ... })`. |
| `MemoryCacheStore` | In-memory cache backend. |
| `FileCacheStore` | File-backed cache backend. |

Type-only: `CacheStore`, `CacheEntry`.

## Minimal examples

### PermissionPolicy -- gate tool access

```ts
import {
  PermissionPolicy,
  fsGlob,
  shellGlob,
  urlPattern,
} from '@combycode/llm-sdk';

const policy = new PermissionPolicy([
  // Allow reads from the project directory.
  {
    source: '*',
    action: 'read',
    target: fsGlob('./src/**'),
    effect: 'allow',
    reason: 'reads inside src/ are safe',
  },
  // Block all shell commands.
  {
    source: '*',
    action: 'shell',
    effect: 'deny',
    reason: 'shell execution not allowed',
  },
  // Allow HTTPS fetches to trusted domains.
  {
    source: '*',
    action: 'fetch',
    target: urlPattern('https://api.example.com/**'),
    effect: 'allow',
  },
]);

const decision = policy.check('agent', { kind: 'fs', path: './src/index.ts' }, 'read');
console.log(decision.allow);  // true

const shellDecision = policy.check('agent', { kind: 'shell', command: 'rm -rf /' }, 'shell');
console.log(shellDecision.allow); // false
```

### FilePersistence -- survive restarts

```ts
import { createEngine } from '@combycode/llm-sdk';

// Conversation history and response state survive process restarts.
const engine = createEngine({
  persistence: { type: 'file', dir: './data/sessions' },
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});
```

### MemoryCache -- deduplicate identical requests

```ts
import { createEngine, complete } from '@combycode/llm-sdk';

const engine = createEngine({
  catalog: 'defaults',
  cache: { type: 'memory' },
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});

// First call hits the network.
const r1 = await complete({ model: 'anthropic/claude-haiku-4.5', prompt: 'What is 2+2?' });
// Second identical call is served from cache.
const r2 = await complete({ model: 'anthropic/claude-haiku-4.5', prompt: 'What is 2+2?' });
console.log(r1.text === r2.text); // true
```

### ContextGuard -- automatic context-window management

Attach a `ContextMeasurer` to an `AgentLoop` and a `ContextGuard` to compress
the conversation when it approaches the model's context limit.

```ts
import {
  createEngine,
  createAgent,
  ContextMeasurer,
  ContextGuard,
  TruncateStrategy,
  HeuristicCounter,
} from '@combycode/llm-sdk';

const engine = createEngine({ catalog: 'defaults', apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! } });

const agent = createAgent({ model: 'anthropic/claude-haiku-4.5', engine });

const measurer = new ContextMeasurer({
  hooks: engine.hooks,
  catalog: engine.catalog,
  counter: new HeuristicCounter(),
});

const guard = new ContextGuard({
  hooks: engine.hooks,
  measurer,
  strategies: { truncate: new TruncateStrategy({ keepRecent: 10 }) },
  defaultStrategy: 'truncate',
});

// Now run normally -- guard fires automatically when context fills.
for (let i = 0; i < 50; i++) {
  const { text } = await agent.complete(`Message ${i}: what is ${i} + ${i}?`);
  console.log(text);
}

guard.destroy();
```

## Related

- [Agent Loop + delegate / chain / consolidate](./agent-loop.md)
- [Agent patterns mapping](./agent-patterns.md)
- [LLM Client + complete/stream](./llm-client.md)
