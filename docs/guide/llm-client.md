# LLM Client -- complete / stream

The LLM layer is the core of the SDK. It provides a single, normalized API to
every provider. `complete()` is the one-shot helper for most use cases;
`createLLM()` gives you a reusable client for streaming, multi-turn conversations,
and fine-grained control.

## When to reach for this

- You want to send a prompt and get text back (use `complete()`).
- You need a streaming reply (use `createLLM().stream()`).
- You are managing a multi-turn conversation with explicit message arrays.
- You want server-state round-trips (OpenAI/xAI Responses API -- state held on
  the server side so only the new turn is sent each round).

## Main exports

| Export | What it does |
|---|---|
| `complete(opts)` | One-shot helper. Sends a prompt, runs the tool loop if tools are supplied, returns `{ text, response, parsed?, retrieveFile, streamFile }`. The fastest path for most tasks. |
| `createLLM(opts)` | Builds a reusable `LLMClient` bound to one provider/model. |
| `LLMClient` | Low-level client class with `.complete()`, `.stream()`, `.retrieveFile()`, `.streamFile()`, `.assistantMessage()`, `.destroy()`. |
| `select(query)` | Pick the best matching model from the catalog by capability query (`'type:chat; vision; cheap'`). Returns a `provider/slug` string. |
| `selectModels(query)` | Same query syntax as `select`, but returns the full ranked `ModelInfo[]` list instead of just the first `provider/slug` string. |
| `listModels()` | Return the curated catalog (pricing + capabilities). |
| `listModelsLive(opts)` | Live-discovery fetch of model ids from the provider API. |
| `route(opts)` | Send to a primary model with client-side (or OpenRouter native) fallback. |

Type-only exports: `CompleteOptions`, `CompleteResult`, `Message`, `ContentPart`,
`Role`, `CompletionResponse`, `Usage`, `FinishReason`, `StreamEvent`, `NormalizedRequest`,
`RetrievedFile`, `FileStream`.

> Hosted-tool output files (code-execution charts/CSVs) surface on `response.files`; fetch
> their bytes with `retrieveFile` / `streamFile` — see [Retrieving output files](./retrieving-files.md).

Provider adapter exports: `AnthropicAdapter`, `OpenAIResponsesAdapter`,
`GoogleAdapter`, `XAIAdapter`, `OpenRouterAdapter`, and their batch/file/media
variants (used when building custom wiring; most users never touch these).

## Minimal examples

### One-shot completion

```ts
import { complete } from '@combycode/llm-sdk';

const { text } = await complete({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  prompt: 'Say hello in one word.',
});
console.log(text);
```

### Streaming

```ts
import { createLLM } from '@combycode/llm-sdk';

const llm = createLLM({
  model: 'openai/gpt-5.4-nano',
  apiKey: process.env.OPENAI_API_KEY,
});

for await (const ev of llm.stream('Count to 5.')) {
  if (ev.type === 'text') process.stdout.write(ev.text);
}
```

### Structured output (typed error + opt-in repair)

`structuredComplete(input, schema, options)` returns the parsed object typed as `T`. If the model's
final output can't be parsed it throws a typed **`InvalidFinalOutputError`** (extends `AgentRunError`,
carries `reason: 'invalid_final_output'` and the model's `rawText`) — not a bare `SyntaxError` — so you
can differentiate and inspect. Pass `structured.repairAttempts` to have it re-prompt with the parse
error before giving up (default `0`).

```ts
import { createLLM, InvalidFinalOutputError } from '@combycode/llm-sdk';

const llm = createLLM({ model: 'openai/gpt-5.4-nano', apiKey: process.env.OPENAI_API_KEY });
const schema = { type: 'object', properties: { city: { type: 'string' }, tempC: { type: 'number' } } };

try {
  const weather = await llm.structuredComplete<{ city: string; tempC: number }>(
    'Weather in Paris as JSON.',
    schema,
    { structured: { schema, repairAttempts: 1 } }, // retry once on a parse failure
  );
  console.log(weather.city, weather.tempC);
} catch (e) {
  if (e instanceof InvalidFinalOutputError) console.error('bad output:', e.rawText);
}
```

### Sampling penalties

`presencePenalty` / `frequencyPenalty` (`[-2, 2]`) are honoured by OpenAI/xAI **chat-completions**,
OpenRouter, and Google (**generateContent** + Interactions). OpenAI/xAI **Responses** and Anthropic
have no penalty fields, so they ignore them.

```ts
await complete({ model: 'openai/gpt-5.4-nano', apiKey, prompt: '…', presencePenalty: 0.6, frequencyPenalty: 0.3 });
```

### Provider-specific options (`providerOptions`)

`providerOptions` is a passthrough for provider features that have no unified equivalent. Each adapter
reads the keys it understands and ignores the rest:

- **Anthropic** — `userProfileId` → the `anthropic-user-profile-id` header (identifies the end user a
  request acts on behalf of; needs the account-level `user-profiles` beta).
- **Google Interactions** (`api: 'interactions'`) — `cachedContent` → the `cached_content` resource
  (`projects/…/cachedContents/…`).

```ts
await complete({ model: 'anthropic/claude-haiku-4.5', apiKey, prompt: '…', providerOptions: { userProfileId: 'usr_42' } });
```

### Multi-turn with server-state

```ts
import { createLLM, type Message } from '@combycode/llm-sdk';

const llm = createLLM({ model: 'openai/gpt-5.4-nano', apiKey: process.env.OPENAI_API_KEY });

const messages: Message[] = [{ role: 'user', content: 'Remember the number 42.' }];
const r1 = await llm.complete(messages);
messages.push(llm.assistantMessage(r1)); // stamps server response id when available
messages.push({ role: 'user', content: 'What number did I ask you to remember?' });
const r2 = await llm.complete(messages);
console.log(r2.text);
```

### Capability-based model selection

```ts
import { createEngine, select, complete } from '@combycode/llm-sdk';

createEngine({
  catalog: 'defaults',
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});

// Pick the cheapest model that supports vision.
const model = select('type:chat; vision; cheap');
const { text } = await complete({ model: model!, prompt: 'Describe the scene.' });
console.log(text);
```

### Pre-flight cost estimate + budget guard

```ts
import { estimate, complete, BudgetExceededError } from '@combycode/llm-sdk';

// Estimate without sending anything.
const est = await estimate({
  model: 'anthropic/claude-haiku-4.5',
  prompt: 'Write a detailed essay on the history of computing.',
  maxTokens: 2000,
});
console.log(`Expected cost: $${est.cost.expected.toFixed(6)}`);

// Or use the inline guard on complete():
try {
  const { text } = await complete({
    model: 'anthropic/claude-haiku-4.5',
    apiKey: process.env.ANTHROPIC_API_KEY,
    prompt: 'Write a detailed essay on the history of computing.',
    maxTokens: 2000,
    maxCostUsd: 0.001, // throw before sending if estimated cost exceeds this
  });
  console.log(text);
} catch (err) {
  if (err instanceof BudgetExceededError) {
    console.error('Request would exceed budget, not sent.');
  }
}
```

## Related

- [Agent Loop + delegate / chain / consolidate](./agent-loop.md)
- [Tools (defineTool)](./tools.md)
- [Tokens + embeddings](./tokens-embeddings.md)
- [Cost tracking + estimate()](./cost.md)
- [Network Engine](./network.md)
