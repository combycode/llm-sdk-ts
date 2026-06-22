# Layered context (ContextRegistry)

The system prompt the model sees is not a single string you build and re-build from scratch.
It is a **priority-ordered stack of named layers** stored in `history.registry` -- a
`ContextRegistry` instance. Each layer is an independent, version-tracked slice of
content. You write to one layer at a time; rendering composes them automatically.

## When and why you need this

Without layers, updating context during a long run means either:

- **String surgery** -- find-and-replace inside a concatenated system string. Brittle,
  breaks when two contributors (memory manager, RAG block, ContextGuard) each own a
  section.
- **Full rebuild** -- reconstruct the whole system string on each turn. Destroys
  prompt-cache prefix hits because every turn the stable part looks different even when
  it hasn't changed.

With layers the solution is simple: write to your own layer, leave the others untouched.
Stable layers (agent persona, static context) remain byte-identical across turns -- the
provider can cache them. Dynamic layers (facts, memory, RAG) are updated in place and
render after the stable prefix, so they never invalidate it.

A **parent registry** lets an orchestrator write agent-wide context once; each
conversation's registry inherits it without copying.

## Step by step

### Step 1 -- Get the registry off a history object

```ts
import { ConversationHistory } from '@combycode/llm-sdk';

const history = new ConversationHistory();
const reg = history.registry; // ContextRegistry, already linked to this history
```

The `history.registry` is a `ContextRegistry` created by `ConversationHistory`
automatically. You do not construct it separately. Every `AgentLoop` exposes its
history via `agent.history`.

### Step 2 -- Set layers

```ts
reg.set('agent.role', 'You are a concise technical assistant.', {
  priority: 10,       // renders first -- stable prefix for cache
  tags: ['system'],
});

reg.set('agent.context', 'Project: ORXA IDE. Stack: TypeScript, Bun.', {
  priority: 100,      // renders after role
  tags: ['system'],
});
```

`set(name, content, opts)` is idempotent: calling it again replaces the layer and bumps
its `version`. The `priority` sticks across calls -- you only need to set it once.

### Step 3 -- Update a single dynamic layer without touching the rest

```ts
// Called after each user turn to inject fresh facts.
reg.set('chat.facts', extractedFacts, {
  priority: 250,      // after stable prefix -- won't invalidate cache
  tags: ['system'],
});
```

The two earlier layers at priority 10 and 100 are unchanged. The provider's prompt
cache sees the same bytes up to priority 250, so the stable prefix is still cached.

### Step 4 -- Remove a layer

```ts
reg.remove('chat.facts');   // layer disappears from next render
```

Returns `true` if the layer existed, `false` if not. No error on missing names.

### Step 5 -- Render and use the composed text

```ts
const composed = reg.flat();          // all layers, separator '\n\n'
const systemOnly = reg.flat({ tag: 'system' });      // only 'system'-tagged layers
const withoutRAG = reg.flat({ exclude: ['rag.docs'] }); // skip one layer
```

`flat()` is the string you pass as the `system` field to `complete()` or to the
`AgentLoop`. The AgentLoop does this automatically on every turn.

### Step 6 -- Parent registries for agent-wide context

```ts
import { ContextRegistry } from '@combycode/llm-sdk';

// One parent for the whole agent session.
const agentReg = new ContextRegistry();
agentReg.set('agent.persona', 'You are a senior engineer reviewing code.', {
  priority: 10,
  tags: ['system'],
});

// Each conversation gets its own child registry.
const convHistory = new ConversationHistory();
convHistory.registry.setParent(agentReg);

// Child layers render after the inherited parent layers.
convHistory.registry.set('conv.task', 'Review the PR diff below.', {
  priority: 150,
  tags: ['system'],
});

console.log(convHistory.registry.flat());
// You are a senior engineer reviewing code.\n\nReview the PR diff below.
```

When you call `render()` on the child, it walks the parent chain first, then overlays
child layers. A child layer with the same name as a parent layer **replaces** it by
default. Set `mergeParent: true` to concatenate parent content before child content
instead (see options below).

### Step 7 -- Snapshot and restore

```ts
const snap = reg.snapshot();          // RegistrySnapshot -- JSON-serializable
// ... persist to disk / DB ...

const restored = ContextRegistry.fromSnapshot(snap);
restored.setParent(agentReg);         // re-attach parent (not serialized)
```

Snapshots include all layers and their versions. Subscribe handlers are NOT
serialized -- re-wire them after restore if needed.

## Your options

### `priority` (number, default 100)

Controls render order: **lower = earlier in the output**.

| Range | Conventional use |
|---|---|
| 1-50   | Fixed agent persona / role. Stable, never changes. Cache prefix starts here. |
| 51-100 | Static run context (project name, task description). Set once per run. |
| 101-200 | Long-lived user state (profile, memory). Updated infrequently. |
| 201-300 | Dynamic per-turn content (facts, RAG block, summaries). Updated every turn. |
| 300+   | Override / injection layers that must appear last. |

Built-in SDK layers use: `agentloop.system` at 10, `_legacy_system` at 50,
`agentloop.context` at 100, `memory` at 200, `chat.facts` at 250,
`executor.tool-examples` at 280, `context-guard.summary` at 300.

Choose priorities that leave gaps so you can insert new layers later without
re-numbering everything.

### `tags` (string[], default [])

Free-form grouping. Used in render filters (`tag: 'system'`, `tags: ['rag', 'memory']`).

```ts
reg.set('rag.docs', retrievedChunks, { priority: 220, tags: ['system', 'rag'] });

// Render only rag-tagged layers:
const ragOnly = reg.flat({ tags: ['rag'] });

// Exclude rag layers (e.g. when the user disables RAG):
const withoutRag = reg.flat({ exclude: ['rag.docs'] });
```

When to use: tag layers by their role (`system`, `rag`, `memory`, `debug`) so you
can render subsets without knowing all layer names.

### `mergeParent` (boolean, default false)

When `true` and a same-named layer exists in the parent registry, the child's
content is **appended after the parent content** instead of replacing it.

```ts
// Parent sets baseline memory.
agentReg.set('memory', 'User prefers concise answers.', { priority: 200 });

// Child conversation adds extra facts -- merge, don't replace.
convHistory.registry.set('memory', 'User is reviewing PR #42.', {
  priority: 200,
  mergeParent: true,   // renders as: "User prefers concise answers.\n\nUser is reviewing PR #42."
});
```

When to use: additive layers (memory notes, facts lists) where the parent supplies
defaults and children extend them. Do NOT use for layers that should fully override
(persona, task description).

### `owner` (string)

Labels who wrote the layer. Used in `onSizeChange` and event tracing; also
available as a render filter (`ownerFilter: 'rag-plugin'`).

```ts
reg.set('rag.docs', chunks, { priority: 220, owner: 'rag-plugin' });
```

Useful for debugging multi-contributor registries: `event.current.owner` in a
`subscribe('*', ...)` handler tells you which subsystem made the change.

### Render filters (`RenderOptions`)

All filters can combine:

| Option | Effect |
|---|---|
| `include: ['a', 'b']` | Only render layers named `a` or `b`. |
| `exclude: ['c']` | Skip layer `c`. All others render. |
| `tag: 'system'` | Only layers that carry the tag `system`. |
| `tags: ['rag', 'memory']` | Layers with at least one of the listed tags. |
| `ownerFilter: 'rag'` | Only layers written by owner `'rag'`. |
| `includeParent: false` | Skip the parent chain -- local layers only. |
| `separator: '\n---\n'` | Override the default `'\n\n'` separator for this render call. |

```ts
// Debug view: dump all layers with a visible separator.
const debug = reg.flat({ separator: '\n---\n' });
```

### Subscribing to changes

```ts
const unsub = reg.subscribe('chat.facts', (event) => {
  console.log('facts updated:', event.current?.content);
});
// or watch all layers:
const unsubAll = reg.onChange((event) => {
  console.log(event.type, event.name, event.sizeAfter - event.sizeBefore);
});
// clean up:
unsub();
unsubAll();
```

Pattern semantics: exact name (`'chat.facts'`), prefix glob (`'memory.*'`),
wildcard (`'*'`). Parent events bubble to child subscribers.

### Token and char sizing

```ts
const chars = reg.sizeChars();                       // total composed chars
const tokens = reg.sizeTokens({ provider, model });  // estimated tokens
```

Pass a `TokenCounter` in `ContextRegistryConfig.counter` for accurate counts;
without one the registry falls back to the 4-chars/token heuristic.

## Roadmap (coming, not yet implemented)

The manual `set/remove` API described in this guide is the current foundation.
The planned next layer above it is **layer producers**: functions registered on a
registry that are called before each LLM request and dynamically select which
layers to include.

For example, a RAG producer would:
1. Receive the pending user message.
2. Embed it and retrieve the top-k relevant documents.
3. Write (or remove) the `rag.docs` layer.

The existing `set/remove` API is exactly what those producers call internally. You
can build a manual version of this today by calling `reg.set('rag.docs', ...)` in
your request-preparation code before each `llm.complete()`. The producer abstraction
will make that automatic and composable.

## Related

- [LLM Client](./llm-client.md)
- [Agent Loop](./agent-loop.md)
- [Context Guard](./context-guard.md)
- [Tokens and embeddings](./tokens-embeddings.md)
