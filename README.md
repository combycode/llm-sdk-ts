# @combycode/llm-sdk

A unified, pluggable AI SDK for accessing the LLMs of every major provider —
**Anthropic, OpenAI, Google, xAI, and OpenRouter** — through one API.

- **One API, every provider.** Switch model or provider without rewriting calls.
- **Pluggable.** Opt-in subsystems: a model catalog, cost tracking + budgets,
  rate-limit-aware queueing, tools/agents, and an OpenAI-compatible server.
- **Unified model catalog** — normalised slug names (`anthropic/claude-haiku-4.5`),
  `model:tier` selectors, capability-based `select()`, tiered pricing, and cost
  tracking.
- **Cross-environment.** The same code runs on Node, Bun, and the browser. Zero
  runtime dependencies, ESM.

## Install

```sh
npm install @combycode/llm-sdk      # or: bun add @combycode/llm-sdk
```

Requires Node ≥ 18 or Bun ≥ 1.1.

## Quickstart

### Simplest path — a callable provider id

```ts
import { complete } from '@combycode/llm-sdk';

const r = await complete({
  model: 'anthropic/claude-haiku-4.5', // provider/model, sent verbatim
  apiKey: process.env.ANTHROPIC_API_KEY,
  prompt: 'Say hello in one word.',
});
console.log(r.text);
```

### Unified names + capability selection

`createEngine()` registers a default engine that the helpers use automatically —
you only pass `engine` explicitly when you run more than one.

```ts
import { complete, createEngine, select } from '@combycode/llm-sdk';

createEngine({ catalog: 'defaults', apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! } });

// Normalised slug → translated to the provider's callable id via the catalog.
await complete({ model: 'anthropic/claude-haiku-4.5', prompt: 'Hi' });

// Pick the cheapest model matching a capability query.
const best = select('type:chat; vision; cheap'); // -> "provider/slug"
await complete({ model: best!, prompt: 'Hi' });
```

### Streaming

```ts
import { createLLM } from '@combycode/llm-sdk';

const llm = createLLM({ model: 'openai/gpt-5.4-nano', apiKey: process.env.OPENAI_API_KEY });
for await (const ev of llm.stream('Count to 5.')) {
  if (ev.type === 'text') process.stdout.write(ev.text);
}
```

## Documentation

Full guide pages covering all export groups:

- **[docs/guide/](./docs/guide/README.md)** -- index of all guide pages
  - [Network Engine](./docs/guide/network.md)
  - [LLM Client + complete / stream](./docs/guide/llm-client.md)
  - [Agent Loop + delegate / chain / consolidate](./docs/guide/agent-loop.md)
  - [Tools (defineTool)](./docs/guide/tools.md)
  - [Tokens + Embeddings](./docs/guide/tokens-embeddings.md)
  - [Cost Tracking + estimate()](./docs/guide/cost.md)
  - [Observability / Telemetry](./docs/guide/telemetry.md)
  - [Media / Files / Batch](./docs/guide/media-files-batch.md)
  - [MCP (Model Context Protocol)](./docs/guide/mcp.md)
  - [Context Guard + Permissions + Persistence + Cache](./docs/guide/context-guard.md)
  - [OpenAI-Compatible Server](./docs/guide/server.md)
  - [Agent Patterns](./docs/guide/agent-patterns.md)
  - [Moderation](./docs/guide/moderation.md)
  - [Retrieval (RAG)](./docs/guide/retrieval.md)
  - [Approval and Checkpoints](./docs/guide/approval-and-checkpoints.md)
  - [Realtime (Live)](./docs/guide/realtime.md)

MCP subsystem design: [docs/design/mcp.md](./docs/design/mcp.md)

## Development

```sh
bun install
bun test          # unit tests
bun run typecheck # tsc --noEmit
bun run lint      # biome
bun run build     # dist/ (node + browser builds + types)
```

## License

[MIT](./LICENSE)
