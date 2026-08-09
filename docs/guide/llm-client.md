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

### Finish reasons — and the two non-obvious ones

`response.finishReason` is unified across providers: `'stop' | 'tool_use' | 'length' |
'content_filter' | 'error' | 'pending'`.

- **`'pending'`** — *not terminal*. The provider accepted the request but has not produced a
  completion, so the response carries no content. It comes from Google Interactions `queued` and
  OpenAI Responses `queued`/`in_progress` (background mode). Treat it as "poll/retry", never as a
  result. Before 1.8.0 these fell through to `'stop'`, which reported a clean finish for an empty
  response.
- **`'error'`** — the provider reported a failure *inside a 200 response* (OpenAI Responses
  `status: 'failed'`, Google Interactions `status: 'failed'`), so there is no exception to catch.
  When set, `response.error` carries `{ code?, message? }` — e.g. OpenAI's `data_residency_mismatch`.

```ts
const { response } = await complete({ model: 'openai/gpt-5.4-nano', apiKey, prompt: '…' });
if (response.finishReason === 'pending') {
  // nothing ran yet — poll again, do not treat response.text as an answer
} else if (response.finishReason === 'error') {
  console.error(response.error?.code, response.error?.message);
}
```

> Anthropic's `refusal` stop reason maps to `'content_filter'` (a safety decline is a block, not a
> clean finish), and `model_context_window_exceeded` maps to `'length'`.

### Sampling parameters

`temperature` / `topP` are honoured everywhere. The rest are **not universal**, so the SDK emits each
one only where the provider actually accepts it — sending them blindly is a hard 400, not a no-op:

| Option | Honoured by | Dropped for |
|---|---|---|
| `topK` | **Anthropic**, on models up to Opus 4.6 — behaviourally verified. Also *sent* to Google + xAI, which accept it but showed no effect when measured | OpenAI (no top-k); **Anthropic models after Opus 4.6**, which reject it (400 `top_k` is deprecated) |
| `seed` | OpenAI **chat-completions**, Google (both surfaces), xAI (chat + responses), OpenRouter chat | Anthropic, OpenAI **Responses** (both reject it) |
| `presencePenalty` / `frequencyPenalty` (`[-2, 2]`) | OpenAI/xAI **chat-completions**, OpenRouter, Google (**generateContent** + Interactions) | OpenAI/xAI **Responses**, Anthropic |
| `stop` | Anthropic, Google, xAI, OpenAI chat | OpenAI **Responses** |

You pass them the same way regardless; where a provider can't take one it is left out of the request
rather than forwarded and rejected.

> **Accepted is not the same as honoured.** A `200` only proves the field was not rejected. We
> tested `topK` behaviourally (`top_k: 1` must force greedy decoding): only Anthropic actually
> applies it — Google and xAI accept it and ignore it on the models we measured. `seed` is
> best-effort everywhere that takes it; determinism is never guaranteed.

```ts
await complete({ model: 'google/gemini-2.5-flash', apiKey, prompt: '…', topK: 40, seed: 42 });
```

```ts
await complete({ model: 'openai/gpt-5.4-nano', apiKey, prompt: '…', presencePenalty: 0.6, frequencyPenalty: 0.3 });
```

### Reasoning (`thinking`)

`thinking` turns on a model's reasoning and maps to each provider's own control:

- `mode: 'auto' | 'on' | 'off'` — enable/disable reasoning.
- `effort: 'low' | 'medium' | 'high' | 'max'` — intensity, mapped per provider (Anthropic
  `budget_tokens`, OpenAI/xAI `effort`, Google `thinkingBudget` on 2.5 / `thinkingLevel` on 3.x).
- `visibility: 'full' (default) | 'summary' | 'hidden'` — how much reasoning comes back: Anthropic
  `enabled.display`, OpenAI Responses `summary`, Google `includeThoughts`. Best-effort — a provider
  without a middle state degrades `summary` to `full`.
- `context: 'auto' | 'current_turn' | 'all_turns'` — cross-turn reasoning persistence (OpenAI Responses).
  Omitted, the model decides: the `gpt-5.6` family defaults to `all_turns`, earlier models to `current_turn`.

```ts
await complete({ model: 'anthropic/claude-haiku-4.5', apiKey, prompt: '…',
  thinking: { mode: 'auto', effort: 'high', visibility: 'hidden' } });
```

(OpenAI's Responses-only execution mode `standard`/`pro` is `providerOptions.reasoningMode` — see below.)

### Provider-specific options (`providerOptions`)

`providerOptions` is a passthrough for provider features that have no unified equivalent. Each adapter
reads the keys it understands and ignores the rest:

- **Anthropic** — `userProfileId` → the `anthropic-user-profile-id` header (identifies the end user a
  request acts on behalf of; needs the account-level `user-profiles` beta).
- **Google generateContent** — `translationConfig` → `generationConfig.translationConfig`
  (`{ targetLanguageCode }`; Gemini Developer API).
- **Google generateContent** — `cachedContent` → top-level `cachedContent`, an explicit context-cache
  resource (`cachedContents/…`). **Moved off Interactions in 1.8.0:** google 2.13 removed
  `cached_content` from the Interactions request model and that endpoint now rejects it outright
  (`400 Unknown parameter 'cached_content'`), so sending it there was a hard failure. It remains
  valid on `generateContent`, which is where the passthrough now lives.
- **OpenAI Responses** — `reasoningMode: 'standard' | 'pro'` → `reasoning.mode` (chat-completions rejects
  it, so it's not a unified `thinking` knob).
- **OpenAI (Responses + chat)** — `moderationPolicy` → `moderation.policy`
  (`{ input?: { mode: 'score'|'block' }, output?: {…} }`) for **server-side** moderation blocking. The
  unified `moderation` option stays report-only; use this (or `moderationGuardrail` at the agent layer)
  to block.
- **OpenAI (Responses + chat, gpt-5.6+)** — `promptCacheOptions` → `prompt_cache_options`
  (`{ mode: 'implicit'|'explicit', ttl: '30m' }`). Note: OpenAI caches **implicitly by default**, so the
  unified `cache` config already caches on OpenAI with no config — this is for manual control only.

```ts
await complete({ model: 'anthropic/claude-haiku-4.5', apiKey, prompt: '…', providerOptions: { userProfileId: 'usr_42' } });
```

### What `cache: 'auto'` actually does per provider

`cache: 'auto'` is one option over three quite different mechanisms, and `usage.cachedTokens`
reports what the provider says it reused. What you should expect differs sharply:

| Provider | Mechanism | Do you get a hit? |
|---|---|---|
| Anthropic | **explicit** `cache_control` breakpoints we set for you | Deterministic above the model's minimum (~1024 tokens) |
| OpenAI | **implicit**, always on | Reliable on a repeated long prefix; `promptCacheOptions` for manual control |
| Google | **implicit**, best-effort | Only on a large prefix, and **not guaranteed even then** |

Google deserves the warning. Measured on 2026-08-09 with an identical repeated request:

- A **~5,000-token** prefix produced **no cache hit at all** on `gemini-3.6-flash` or
  `gemini-2.5-flash` — neither as `systemInstruction` nor as leading content. Placement is not the
  issue; size is.
- At **~15,000–40,000 tokens** `gemini-3.6-flash` reported hits every time (e.g. 40,010 prompt
  tokens → 32,737 cached).
- `gemini-2.5-flash` hit at 10k and 20k but **missed at 15k and 30k in the same run**.

So Google implicit caching is genuinely best-effort: a miss is not a bug, and **no
cost model should assume the hit**. Treat `usage.cachedTokens` as an observation after the fact.
When you need a guaranteed, billable cache on Google, create a `cachedContents` resource and pass
its name through `providerOptions.cachedContent` — that is explicit and deterministic.

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
