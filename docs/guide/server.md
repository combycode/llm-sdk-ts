---
title: OpenAI-Compatible Server
description: Run a drop-in /v1/chat/completions front end backed by any registered LLM client.
---

# OpenAI-Compatible Server

## What you'll achieve

By the end of this guide you will know how to:

- Spin up `OaiServer` and serve it with `Bun.serve` (or any framework that
  accepts a `Request -> Response` handler).
- Register models and route incoming OAI requests to the right `LLMClient`.
- Add authentication with `BearerKeyAuth` or a custom `AuthPlugin`.
- Persist multi-turn conversation history across requests with
  `ConversationLoaderPlugin`.
- Use `AgentLoaderPlugin` to inject fully-featured `AgentLoop` instances
  per request.

## When and why you need this

The server is the easiest migration path. Existing code already calls OpenAI
(or any other OAI-wire-compatible endpoint) via an OpenAI SDK. By pointing
`baseURL` at your server you immediately switch the underlying model and
provider without touching your application code.

Once traffic flows through the server you can graduate: add tools, history,
cost tracking, guardrails, and eventually call the native `AgentLoop` API
directly when you want features the OAI wire format cannot express.

Use the server when:

- You need a drop-in proxy or gateway so multiple clients can share one
  authenticated, rate-limited connection to your backend model.
- You want per-conversation state stored durably without the calling client
  tracking session IDs.
- You are evaluating which provider/model to use without changing your
  application.

## Step by step

### 1. Minimal server with one agent

`createServer()` is the high-level entry point. It builds an `OaiServer`,
wires a `ConversationLoaderPlugin` backed by `engine.persistence`, and
registers each agent spec as a named model.

```ts
import { createEngine, createServer } from '@combycode/llm-sdk';

const engine = createEngine({
  catalog: 'defaults',
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});

const server = createServer({
  engine,
  agents: {
    'my-assistant': {
      model: 'anthropic/claude-haiku-4-5',
      system: 'You are a helpful assistant.',
    },
  },
});

// Bun.serve integration -- any request is dispatched through server.handle().
export default {
  port: 3000,
  fetch: (req: Request) => server.handle(req),
};
```

Any OAI SDK now works:

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'not-checked-yet',
});

const response = await client.chat.completions.create({
  model: 'my-assistant',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);
```

### 2. Using `OaiServer` directly (low-level)

`createServer()` calls `new OaiServer()` internally. Use the class directly
when you need full control, such as registering models dynamically at runtime.

```ts
import { OaiServer, createLLM } from '@combycode/llm-sdk';

const server = new OaiServer({
  port: 4000,
  hostname: '0.0.0.0',
});

// Register a model after construction.
server.register({
  model: 'gpt-4o-mini',
  client: createLLM({ model: 'openai/gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY! }),
});

// Wire into Bun.serve.
server.start(); // binds port 4000

// Or handle requests manually (useful for tests and embedded use):
const resp = await server.handle(new Request('http://localhost/health'));
// resp.json() -> { status: 'ok' }
```

> `OaiServer.start()` requires the Bun runtime and binds a port.
> `OaiServer.handle(request)` works in any environment and is the right
> choice for test suites, middleware chains, and non-Bun runtimes.

### 3. Add bearer key authentication

```ts
import { createServer, BearerKeyAuth } from '@combycode/llm-sdk';

const server = createServer({
  auth: new BearerKeyAuth({
    // key -> userId mapping
    keys: {
      'sk-prod-abc123': 'user-alice',
      'sk-dev-xyz789': 'user-bob',
    },
  }),
  agents: {
    'chat': { model: 'anthropic/claude-haiku-4-5', apiKey: process.env.ANTHROPIC_API_KEY! },
  },
});
```

When a key is not in the map, the server responds `401` and emits
`onAuthFail`. The `userId` returned by `verify()` flows into the
`ConversationLoaderPlugin` so each user gets an isolated history namespace.

Anonymous keys (no explicit userId mapping) derive their userId from the key
prefix: `'sk-abc...'` -> `'key:sk-abc'`.

### 4. Persist conversation history

`createServer()` automatically builds a `ConversationLoaderPlugin` backed by
`engine.persistence` when you pass `agents`. Each conversation is keyed by
`${userId ?? 'anon'}:${conversationId}`.

For custom storage, pass `conversationLoader` directly:

```ts
import { createServer } from '@combycode/llm-sdk';
import type { ConversationLoaderPlugin } from '@combycode/llm-sdk';

const myLoader: ConversationLoaderPlugin = {
  async load({ userId, conversationId }) {
    const snap = await db.getConversation(userId, conversationId);
    if (!snap) return null;
    const { ConversationHistory } = await import('@combycode/llm-sdk');
    return ConversationHistory.import(snap);
  },
  async save({ userId, conversationId }, history) {
    await db.saveConversation(userId, conversationId, history.export());
  },
};

const server = createServer({
  conversationLoader: myLoader,
  entries: [
    { model: 'chat', client: myClient },
  ],
});
```

### 5. Dynamic agents with `AgentLoaderPlugin`

When a single `ServerEntry` per model is too static -- e.g. you need
per-user system prompts, different tool sets per tenant, or policy objects
that come from a database -- implement `AgentLoaderPlugin`:

```ts
import { createServer, createAgent } from '@combycode/llm-sdk';
import type { AgentLoaderPlugin } from '@combycode/llm-sdk';

const agentLoader: AgentLoaderPlugin = {
  async load({ userId, model, conversationId }) {
    if (model !== 'custom-agent') return null; // fall back to static entry
    const config = await db.getAgentConfig(userId);
    return createAgent({
      model: 'anthropic/claude-haiku-4-5',
      apiKey: config.apiKey,
      system: config.systemPrompt,
      tools: buildToolsForUser(userId),
    });
  },
};

const server = createServer({
  agentLoader,
  entries: [
    { model: 'custom-agent', client: fallbackClient },
  ],
});
```

When `agentLoader.load()` returns a non-null `AgentLoop`, `dispatch` reuses
it directly (the loader owns system, tools, and history). When it returns
`null`, dispatch falls back to the static `ServerEntry`.

## Your options

### `OaiServerConfig`

| Field | Type | Default | Notes |
|---|---|---|---|
| `entries` | `ServerEntry[]` | `[]` | Static model registrations. Also reachable via `server.register()`. |
| `port` | `number` | `4000` | Bun.serve port. Unused when calling `handle()` directly. |
| `hostname` | `string` | `'127.0.0.1'` | Bun.serve hostname. |
| `hooks` | `HookBus` | fresh bus | Shared with agents when set. |
| `auth` | `AuthPlugin` | none | When absent all requests are unauthenticated (`userId = null`). |
| `agentLoader` | `AgentLoaderPlugin` | none | Dynamic `AgentLoop` resolution per request. |
| `conversationLoader` | `ConversationLoaderPlugin` | none | External history store. |
| `responseStore` | `ResponseStore` | auto | Pass a pre-built store to share one across servers. |
| `responseStorePersistence` | `Persistence` | `engine.persistence` | Backing store for `ResponseStore`. |
| `streamChunkChars` | `number` | `40` | Fake-streaming character chunk size for `stream: true` requests. |

### `ServerEntry`

The static model registration. Passed to `OaiServer` constructor or added
via `server.register()`.

| Field | Type | Default | Notes |
|---|---|---|---|
| `model` | `string` | required | The model id as it appears in OAI requests. |
| `client` | `LLMClient` | required | Pre-configured LLM client. |
| `internalTools` | `AgentTool[]` | `[]` | Server-side tools exposed to the model but not the caller. |
| `allowExternalTools` | `boolean` | `true` | When false, client-supplied tools in the OAI request are dropped. |
| `capabilities` | object | -- | Optional metadata surfaced at `GET /v1/models`. |

### `BearerKeyAuth` -- auth strategies

| Strategy | Constructor | When to use |
|---|---|---|
| Named key map | `new BearerKeyAuth({ keys: { 'sk-...': 'user-id' } })` | Multi-user prod; each key has a stable userId |
| Anonymous key list | `new BearerKeyAuth({ keys: ['sk-...', 'sk-...'] })` | Dev / single-tenant; userId derived from key prefix |
| Custom | Implement `AuthPlugin.verify(headers)` | OAuth, JWT, API gateway forwarded headers |

`verify()` can be sync or async. Throw any error to return `401`. The
`AuthVerifyResult` shape is `{ userId: string; metadata?: Record<string, unknown> }`.

### Endpoints exposed by `OaiServer`

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe. Returns `{ status: 'ok' }`. |
| `GET` | `/v1/models` | Lists registered models in OAI models-list format. |
| `POST` | `/v1/chat/completions` | Chat completion. Accepts OAI chat request body. |
| `OPTIONS` | `*` | CORS preflight. Always returns 204. |

### `ResponseStore`

Stores completed conversations keyed by `(userId, localResponseId)`. Used
to enable stateful multi-turn sessions when the caller tracks the response
id (analogous to OpenAI's `previous_response_id` flow).

| Config field | Default | Notes |
|---|---|---|
| `persistence` | none (memory-only) | Pass `FilePersistence` for disk-backed durability |
| `keyPrefix` | `'response:'` | Prefix for all keys in the backing store |
| `memoryCapacity` | `10_000` | Max entries kept in the in-process LRU cache |

The store is accessible as `server.responseStore` for custom lifecycle
management.

## Gotchas and next steps

**`start()` is Bun-only.** If you run in Node, construct the server and wire
`server.handle` into `node:http` or any Node framework yourself:

```ts
import http from 'node:http';

const httpServer = http.createServer(async (req, res) => {
  const url = `http://localhost${req.url}`;
  const body = await new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
  const request = new Request(url, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
  });
  const response = await server.handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
httpServer.listen(3000);
```

**No streaming over the wire.** `stream: true` in OAI requests is accepted
but simulated: the response is collected in full and fake-chunked with
`streamChunkChars` characters per SSE event. Real streaming (token-by-token
from the provider) is not yet propagated through the OAI wire format.

**Model not registered returns 404.** If `router.resolve()` cannot find the
model name, the server returns `{ error: { message: 'model "..." not found' } }`
with status 404. Ensure the model string in the OAI client's request matches
the `model` field in `ServerEntry` exactly.

**Duplicate model registration throws.** `server.register()` calls
`ModelRouter.register()` which throws if the model id already exists. Use
`server.unregister(model)` first to swap a live model.

**Next steps:**
- [Models and Providers](/docs/guides/models-and-providers/) -- configure `LLMClient`,
  `createLLM`, provider adapters, and the model catalog.
- [Agent Loop](/docs/guides/agent-loop/) -- native multi-step agent API with tools,
  history, and guardrails that the server wraps behind the OAI wire format.
