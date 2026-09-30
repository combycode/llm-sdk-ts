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
  When set, `response.error` carries `{ code?, message?, misalignment? }` — e.g. OpenAI's
  `data_residency_mismatch`. A code the provider sends as a number is read as its decimal string,
  so a numeric code is a code rather than an absent one.

```ts
const { response } = await complete({ model: 'openai/gpt-5.4-nano', apiKey, prompt: '…' });
if (response.finishReason === 'pending') {
  // nothing ran yet — poll again, do not treat response.text as an answer
} else if (response.finishReason === 'error') {
  console.error(response.error?.code, response.error?.message);
}
```

#### A safety block that explains itself

OpenAI's `misalignment_policy_violation` (2026-09) comes with `error.misalignment`, and it is the
one error body worth reading past `message`:

| Field | What it is |
| --- | --- |
| `detailedExplanation` | why this particular turn looked wrong |
| `errorType` | a classification — `potentially_unintended_data_transfer`, `…_data_access`, `…_destructive_activity`, `other`. **Open**: the provider says clients must accept more, so it is typed as a string |
| `steer.message` | a continuation the provider suggests sending instead |

`steer` is the part that changes what an agent can do. Without it the only thing the run learns is
that it was stopped:

```ts
if (response.error?.misalignment) {
  const { detailedExplanation, steer } = response.error.misalignment;
  console.warn(`blocked: ${detailedExplanation}`);
  if (steer) {
    // A path forward the provider itself offered — worth surfacing to the user
    // before deciding whether to retry.
    console.warn(`suggested: ${steer.message}`);
  }
}
```

Absent unless the provider sent one, and never an empty object: `misalignment` being present means
a safety system actually explained itself.

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
- `mode: 'between_tools'` — reason only BETWEEN tool calls. Anthropic-only and model-gated;
  see below.
- `effort: 'low' | 'medium' | 'high' | 'max' | 'xhigh'` — intensity, **mapped** per provider, never
  passed through: Anthropic `budget_tokens` below 4.6 and `output_config.effort` on 4.6+, OpenAI and
  xAI `reasoning.effort` on Responses and `reasoning_effort` on chat-completions, Google
  `thinkingBudget` on 2.5 / `thinkingLevel` on 3.x.

  `max` means *the most this model will do*, so it lands on the top rung of each provider's own
  ladder — `xhigh` on OpenAI and xAI, `high` on Google, whose ladder ends there. Name `xhigh`
  directly when you want that rung specifically rather than "whatever the maximum is"; a model that
  does not take it answers 400 naming the value, which beats being quietly served a different amount
  of thinking than you asked for.

  Measured 2026-09-30: xAI honours the effort on the grok-4.3 line and up on **both** surfaces
  (grok-4.6 Responses low 449 → xhigh 3066 reasoning tokens, chat-completions low 927 → xhigh 7043),
  while the whole grok-4.20 line answers `400 "does not support parameter reasoningEffort"` and the
  SDK therefore omits the field for it. `grok-4.20-multi-agent` accepts it but reads it as an agent
  count, so it is not treated as an effort control.
- `visibility: 'full' (default) | 'summary' | 'hidden'` — how much reasoning comes back: Anthropic
  `enabled.display`, OpenAI Responses `summary`, Google `includeThoughts`. Best-effort — a provider
  without a middle state degrades `summary` to `full`.
- `context: 'auto' | 'current_turn' | 'all_turns'` — cross-turn reasoning persistence (OpenAI Responses).
  Omitted, the model decides: the `gpt-5.6` family defaults to `all_turns`, earlier models to `current_turn`.

**Anthropic has two incompatible request shapes and the SDK picks per model** — you do not configure
this. Claude 4.6 and later take `thinking: {type:'adaptive'}` and reject `budget_tokens` with a 400;
everything below 4.6 has no adaptive mode and requires the budget. An unrecognised model id gets
`adaptive`, since that is the shape Anthropic is moving to.

```ts
await complete({ model: 'anthropic/claude-haiku-4.5', apiKey, prompt: '…',
  thinking: { mode: 'auto', effort: 'high', visibility: 'hidden' } });
```

**`between_tools` is accepted by almost nothing, and the library checks before sending.** Measured
2026-09-29 against every active Anthropic chat model: exactly one takes it — `claude-sonnet-5.5` —
and the other twelve answer `400 "thinking.type.between_tools" is not supported for this model`,
`claude-opus-5.5` included. A deliberately invalid thinking type is refused everywhere, so the field
is read rather than tolerated.

Ask for it on a model the catalog does not record as accepting it and the mode is **dropped**, the
request goes out with the model's ordinary reasoning, and you get an `onWarning` with code
`request_adjusted` naming the model that does take it. That is what Anthropic's own fallback
middleware does with this value when it hops to another model — a request that works beats a 400.

Note this gate is the mirror of `reasoning.canDisable`: that one stops a request only on an explicit
`false`, because almost every model *can* disable reasoning. This one sends only on an explicit
`true`, because almost none accepts it. The cost is that a newly-released model that takes it needs
a catalog entry before callers can use it — and until then they get a warning, not silence.

(OpenAI's Responses-only execution mode `standard`/`pro` is `providerOptions.reasoningMode` — see below.)

### Provider-specific options (`providerOptions`)

`providerOptions` is a passthrough for provider features that have no unified equivalent. Each adapter
reads the keys it understands and ignores the rest:

- **Anthropic** — `userProfileId` → the `anthropic-user-profile-id` header (identifies the end user a
  request acts on behalf of; needs the account-level `user-profiles` beta).
- **Anthropic** — `workspaceId` → the `anthropic-workspace-id` header (selects the Workspace, e.g.
  `wrkspc_011CZ…`). See [Workspaces](#workspaces) below.
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
  (typed as `PromptCacheOptions`: `{ mode?: 'implicit'|'explicit', ttl?: '30m', prewarm?: boolean }`).
  Note: OpenAI caches **implicitly by default**, so the unified `cache` config already caches on
  OpenAI with no config — this is for manual control only. `gpt-5.6+` is not advisory: an older
  model refuses the whole object with `400 prompt_cache_options is not supported on this model`.
  See [Warming the cache before you need it](#warming-the-cache-before-you-need-it).

```ts
await complete({ model: 'anthropic/claude-haiku-4.5', apiKey, prompt: '…', providerOptions: { userProfileId: 'usr_42' } });
```

### Images Anthropic would otherwise shrink without telling you

An image larger than the model's maximum is **downsized by default, silently**. The model reasons
over dimensions you did not choose, the answer comes back looking normal, and nothing in the
response says the detail you were asking about was resampled away.

Measured 2026-09-30 — a 4000x4000 image sent to `claude-haiku-4.5`:

> image dimensions 4000x4000 exceed the maximum image size of a model named on this request and
> **would be downsized to 1092x1092**; scale the image to at most 1092x1092 or set the image's
> `oversized_image` setting to `"downsize"`

1092x1092 is **7% of the pixels that were sent**. For a screenshot of small text, or a scan someone
is asking you to read, that is the difference between an answer and a guess.

`oversized_image: 'error'` turns the silent shrink into that refusal, per image:

```ts
await complete({
  model: 'anthropic/claude-haiku-4.5',
  apiKey,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', mimeType: 'image/png', data },
          // Refuse rather than resample. The 400 names the dimensions and the
          // largest that would fit, so you can scale it deliberately.
          providerOptions: { transformations: { oversized_image: 'error' } },
        },
        { type: 'text', text: 'What does the error message in this screenshot say?' },
      ],
    },
  ],
});
```

Per **image**, not per request: one oversized screenshot in a long conversation should not change
how every other image in it is handled. Omitted entirely when unset, so the server default stands.

> A separate, higher limit exists above this one: a dimension over **8000px** is refused outright
> whatever `oversized_image` says.

### Warming the cache before you need it

`prewarm: true` writes the prompt cache and generates **nothing** — it overrides `generate` to
false. Use it when a long shared prefix is about to be hit by several requests and you would rather
pay the cache write once, up front, than make the first real request slow.

```ts
const PREFIX = '…a few thousand tokens of shared context…';

// 1. warm it. Comes back completed and empty — that is success, not a failure.
const warm = await complete({
  model: 'openai/gpt-5.6-terra',
  apiKey,
  prompt: PREFIX,
  providerOptions: { promptCacheOptions: { prewarm: true, ttl: '30m' } },
});
console.log(warm.response.finishReason); // 'stop'
console.log(warm.response.text);         // ''

// 2. the real requests read it
const answer = await complete({ model: 'openai/gpt-5.6-terra', apiKey, prompt: `${PREFIX}

Q: …` });
console.log(answer.response.usage.cachedTokens); // most of the prefix
```

A prewarm response has an empty `output[]`, which this library reports as an ordinary empty result
— `finishReason: 'stop'`, no content, no `error`. Do not read the blank text as a broken request.

It is not free: the prewarm pays for the input tokens it writes (`usage.cacheWriteTokens`), so it
is worth it only when the prefix will actually be reused.

> Measured 2026-09-30 on `gpt-5.6-terra`: the prewarm call returned 0 output items and 0 cached
> tokens, and the next call on the same 4177-token prompt read **4174 of them from cache**. The
> prompt carried a per-run nonce, so that hit can only have come from the prewarm. Note also that
> caching needs a prompt long enough to qualify — an earlier 613-token attempt cached nothing.

### Workspaces

Anthropic accounts **spend, rate limits and retention** against a Workspace, and
`anthropic-workspace-id` is what selects one. A credential scoped to a single Workspace may omit
it. A credential that can act on **several** and omits it does not fail — it charges the default
Workspace. That is the failure worth designing against: silent, and first visible on a bill.

So the header is sent on every Anthropic request this library makes, not only completions. Each
surface takes it where that surface is configured:

| Surface | Where |
| --- | --- |
| completions | `providerOptions.workspaceId` per request, or `new AnthropicAdapter({ apiKey, workspaceId })` as a client-wide default — the request wins |
| files | `new AnthropicFileAdapter({ apiKey, workspaceId })` |
| batches | `new AnthropicBatchAdapter({ apiKey, workspaceId })` — on submit *and* on every poll |
| token counting | `new AnthropicCountApi(apiKey, fetch, baseURL, workspaceId)` |
| model listing | `listModelsLive({ provider: 'anthropic', apiKey, workspaceId })` |
| retrieving a file a turn produced | filled in from the client's adapter — `llm.retrieveFile(f)` uses the Workspace the turn was billed to |

```ts
await complete({
  model: 'anthropic/claude-haiku-4.5',
  apiKey,
  prompt: '…',
  providerOptions: { workspaceId: 'wrkspc_011CZkZaBF1tNoB5wlCeusgy' },
});
```

Omitted entirely when unset. "No Workspace named" and "the Workspace named is the empty string"
are different requests, and only the first one means what an unconfigured client means.

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

### Asking WHY the cache missed (`cacheDiagnostics`)

`usage.cachedTokens` says how much was reused. It does not say what broke the prefix, and on a
long system prompt that is the only question worth asking. Anthropic and OpenAI both answer it,
under different names; the unified option asks, and `response.cacheDiagnostics` carries the reply.

```ts
import { createLLM } from '@combycode/llm-sdk';

const llm = createLLM({ model: 'anthropic/claude-haiku-4.5' });
const longPolicyText = 'Rule: answer in one word. '.repeat(900);

const first = await llm.complete('Summarise the policy.', {
  system: longPolicyText,
  cache: { system: true },
  cacheDiagnostics: {},                       // opt in, nothing to compare yet
});

const second = await llm.complete('And the exceptions?', {
  system: longPolicyText,
  cache: { system: true },
  cacheDiagnostics: { compareWith: first.id },
});

second.cacheDiagnostics;
// -> { status: 'miss', reason: 'system_changed', missedTokens: 9197, raw: {...} }
// or undefined on Anthropic when the prefix WAS reused — see below.
```

**Opt in on every request in the chain, not only the one you are asking about.** Measured on
2026-09-29: Anthropic keeps the prompt fingerprint only for requests that themselves sent
`cacheDiagnostics`. Comparing against an ordinary response returns `comparison_not_found` even
though the id is perfectly valid — which reads exactly like a broken feature. That is why the
first call above passes `cacheDiagnostics: {}` with nothing to compare.

**A hit is not reported the same way, and this is the part to design around.**

| | Anthropic | OpenAI |
|---|---|---|
| Prefix reused | `cacheDiagnostics` is **absent** | `status: 'hit'` |
| Prefix broken | `status: 'miss'` + `reason` + `missedTokens` | same, with a finer `reason` set and `reusableTokens` |
| Unknown `compareWith` | `status: 'comparison_not_found'` (HTTP 200) | same (HTTP 200) |
| Nothing to diagnose | absent | `status: 'unavailable'` |

Anthropic has no hit variant: a request whose prefix was reused returns the same body an
undiagnosed request returns. Nothing here turns that silence into `status: 'hit'`, because that
would publish our inference as the provider's answer — **read `usage.cachedTokens` for whether the
cache was used, and this for why it was not.**

Two more measured facts worth knowing before you build on it:

- **OpenAI gates it to `gpt-5.6` and later.** Every earlier model answers `unavailable` to an
  otherwise identical request, so testing on a mini/nano model shows a feature that appears dead.
- **It is a Responses-only feature on OpenAI.** Chat Completions takes a `prompt_cache_options`
  too, but that one carries `mode` and `ttl` and nothing else — there is no field to name a
  comparison against, so the request is reported as adjusted rather than sent.
- `reason` keeps each provider's own word. `system_changed` (Anthropic) and `input_changed`
  (OpenAI) are not the same claim, so neither is translated into the other; both `status` and
  `reason` are open unions (R1) and an unrecognised value reaches you unchanged.

Requesting it where no field exists — Google, xAI, Chat Completions — is reported as an
`onWarning` with code `request_adjusted` rather than dropped in silence.

**Streaming reports it too.** Both providers send the diagnosis in the stream (Anthropic on
`message_start`, before a token is generated; OpenAI in the response envelope), so it arrives as a
`cache_diagnostics` stream event and is also collected onto the streamed final response —
`stream()` and `complete()` answer the same question.

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

### `assistantMessage()` carries more than text (Google Interactions)

`llm.assistantMessage(response)` is not a convenience wrapper around the text — it stamps the
turn's provenance, and on Google Interactions that provenance is load-bearing. **Build history
with it rather than by hand**, or the next turn goes out missing state the provider expects back.

A Gemini Interactions turn returns a `thought` step carrying nothing but a `signature`. Measured
2026-09-29 on `gemini-3.1-flash-lite`: echoing that step on the next request is accepted, and
echoing it with the signature corrupted is refused `400 Corrupted thought signature` — so the
server reads it rather than tolerating it. The library keeps it on `response.signatures`, copies
it to `message.origin.signatures`, and the adapter sends it back in the position it arrived in.

```ts
const first = await llm.complete('Think, then say OK.');
const history = [
  { role: 'user', content: 'Think, then say OK.' },
  llm.assistantMessage(first),          // carries origin.signatures
  { role: 'user', content: 'Now say DONE.' },
] satisfies Message[];
await llm.complete(history);            // the signed step rides along
```

`signatures` is **opaque and provider-bound**: nothing here reads it, and the adapter sends it only
when `origin.provider` matches its own. A streamed turn keeps it too — the signature arrives as its
own delta mid-stream and rides out on the terminal `done` event onto `response.signatures`.

When you continue server-side instead (`previousResponseId`, or the default `stateful` behaviour),
the transcript is not resent at all and the provider already holds the state, so nothing is echoed.

**A failed interaction now says why.** `Interaction.errors[]` — Google's diagnostic faults — is
lifted onto `response.error` when the interaction failed, where it used to arrive as
`finishReason: 'error'` and nothing else: an empty answer, no exception to catch, and no way to
tell a content refusal from a platform fault. On a *completed* interaction the field stays on
`response.raw`, because Google documents it as diagnostics rather than as a cause and reporting a
successful call as failed would be worse than saying nothing.

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
