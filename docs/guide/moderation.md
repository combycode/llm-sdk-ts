---
title: Content Moderation
description: Screen text and images with OpenAI moderations before agent runs or as a built-in guardrail.
---

# Content Moderation

## What you'll achieve

By the end of this guide you will be able to:

- Call `moderate()` directly to screen arbitrary text or mixed text+image content.
- Batch-screen several inputs in one network call and handle per-item results.
- Wire `moderationGuardrail()` into an `AgentLoop` so every user message (and optionally every
  assistant reply) is automatically checked before or after the LLM call.

## When and why you need this

Content moderation fits into three distinct moments:

1. **Before an agent run** -- gate user input to prevent harmful content from ever reaching the
   model. Cheapest point to block because no LLM call is made.
2. **After an agent run** -- validate the assistant reply before showing it to end users, e.g.
   when the model has been given access to external data sources.
3. **Continuous pipeline checks** -- moderate every item in a batch pipeline or each user message
   in a multi-turn chat session.

The moderations endpoint is **free**. There is no cost reason to skip it. The SDK always emits
an honest zero-cost entry on `onCostEntry` so the cost ledger records every call even though
nothing is billed.

**Provider constraint:** the moderations endpoint exists only on OpenAI. Any other provider string
throws immediately with a descriptive error. An OpenAI API key is required -- pass it as
`opts.apiKey` or configure `engine.apiKeys['openai']` once via `createEngine()`.

## Step by step

### 1. Check a single user message

```ts
import { moderate } from '@combycode/llm-sdk';

const result = await moderate({
  apiKey: process.env.OPENAI_API_KEY,
  input: 'I want to hurt someone.',
});

if (result.flagged) {
  // Check which categories fired and at what confidence.
  const fired = Object.entries(result.categories)
    .filter(([, v]) => v)
    .map(([k]) => k);
  console.log('Flagged categories:', fired);
  // e.g. ['violence', 'harassment']
}
```

`input` is a `string`, so the return type is a single `ModerationResult` (not an array).

### 2. Screen a batch of messages in one call

Pass `string[]` to get one result per input element. A single HTTP request covers all strings.

```ts
import { moderate } from '@combycode/llm-sdk';

const messages = [
  'Hello, how are you?',
  'I want to buy a gun.',
  'Tell me a joke.',
];

const results = await moderate({
  apiKey: process.env.OPENAI_API_KEY,
  input: messages,       // string[] -> ModerationResult[]
});

results.forEach((r, i) => {
  if (r.flagged) {
    console.log(`Message ${i} flagged:`, r.categories);
  }
});
```

### 3. Moderate mixed text and image content

`omni-moderation-latest` (the default model) supports image URLs alongside text. Build a
`ModerationContentPart[]` array to moderate both in one call.

```ts
import { moderate } from '@combycode/llm-sdk';
import type { ModerationContentPart } from '@combycode/llm-sdk';

const parts: ModerationContentPart[] = [
  { type: 'text', text: 'Look at this image.' },
  { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } },
];

const result = await moderate({
  apiKey: process.env.OPENAI_API_KEY,
  input: parts,          // ModerationContentPart[] -> single ModerationResult
});

// categoryAppliedInputTypes tells you which input type triggered each category.
if (result.flagged && result.categoryAppliedInputTypes) {
  console.log('Applied input types:', result.categoryAppliedInputTypes);
  // e.g. { violence: ['image'] }
}
```

To moderate several such mixed items, pass `ModerationContentPart[][]` (one inner array per
item). The return is `ModerationResult[]`.

### 4. Gate an agent run on moderation result

```ts
import { moderate, createAgent } from '@combycode/llm-sdk';

async function safeRun(userMessage: string): Promise<string> {
  const check = await moderate({
    apiKey: process.env.OPENAI_API_KEY,
    input: userMessage,
  });

  if (check.flagged) {
    return 'Your message was blocked by content policy.';
  }

  const agent = createAgent({
    model: 'anthropic/claude-haiku-4-5',
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const response = await agent.complete(userMessage);
  return response.text;
}
```

### 5. Wire it as a built-in guardrail (the recommended path)

`moderationGuardrail()` returns one or two `Guardrail` instances that slot directly into
`AgentLoopConfig.guardrails`. The loop runs them automatically at the right moment.

```ts
import { createAgent, moderationGuardrail } from '@combycode/llm-sdk';

// Screen user messages before each LLM call, and assistant replies after.
const guards = moderationGuardrail({
  apiKey: process.env.OPENAI_API_KEY,
  input: true,    // default: true
  output: true,   // default: false
});

const agent = createAgent({
  model: 'anthropic/claude-haiku-4-5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  guardrails: guards,
});

const response = await agent.complete('Write me something helpful.');
// When a guardrail trips:
//   response.text          = the trip reason string
//   response.finishReason  = 'stop'
// An onGuardrailTriggered hook is also emitted.
```

When an input guardrail trips, the LLM call is never made. When an output guardrail trips,
the run halts and the model output is discarded.

## Your options

### `moderate()` -- `ModerateOptions`

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `input` | `string \| string[] \| ModerationContentPart[] \| ModerationContentPart[][]` | yes | -- | Determines return type (see below) |
| `model` | `string` | no | `'omni-moderation-latest'` | Only `omni-moderation-*` supports images |
| `apiKey` | `string` | no | `engine.apiKeys['openai']` | Must be an OpenAI key |
| `provider` | `'openai'` | no | `'openai'` | Only OpenAI is supported; other values throw |
| `engine` | `EngineHandle` | no | default engine | Override to use a custom engine |

**Return type by input shape:**

| Input shape | Return type |
|---|---|
| `string` | `ModerationResult` |
| `string[]` | `ModerationResult[]` (one per element) |
| `ModerationContentPart[]` | `ModerationResult` (single mixed item) |
| `ModerationContentPart[][]` | `ModerationResult[]` (one per inner array) |

### `ModerationResult` shape

```ts
interface ModerationResult {
  flagged: boolean;                                      // true when any category fired
  categories: ModerationCategories;                     // per-category boolean flags
  categoryScores: ModerationScores;                     // confidence scores 0-1
  categoryAppliedInputTypes?: Record<string, string[]>; // omni models only: which input type triggered
}
```

`ModerationCategories` has one `boolean` field per harm category:

`harassment`, `harassment/threatening`, `hate`, `hate/threatening`, `illicit`,
`illicit/violent`, `self-harm`, `self-harm/intent`, `self-harm/instructions`,
`sexual`, `sexual/minors`, `violence`, `violence/graphic`.

`ModerationScores` is a parallel `Record<keyof ModerationCategories, number>` with 0-1 floats.

### `moderationGuardrail()` -- `ModerationGuardrailOptions`

| Field | Type | Default | Notes |
|---|---|---|---|
| `apiKey` | `string` | `engine.apiKeys['openai']` | Same requirement as `moderate()` |
| `input` | `boolean` | `true` | Build an input-kind guardrail (runs before LLM call) |
| `output` | `boolean` | `false` | Build an output-kind guardrail (runs after step response) |
| `model` | `string` | `'omni-moderation-latest'` | Passed through to `moderate()` |
| `name` | `string` | `'moderation-input'` / `'moderation-output'` | Label shown in hooks and error messages |

The factory returns a `Guardrail[]`. Spread it or concatenate with other guardrails:

```ts
const guards = [
  ...moderationGuardrail({ apiKey: '...' }),
  myCustomGuardrail,
];
```

**When to use `input: true` vs `output: true`:**

- `input: true` (default) is the cheapest safety gate. Blocks harmful user content before
  any LLM token is spent.
- `output: true` adds a second check on the model reply. Useful when the model is prompted
  with external data you do not fully trust.
- Both enabled gives the strongest guarantee. Both disabled is valid (returns an empty array).

### When not to use `moderationGuardrail()`

The built-in guardrail moderates the last user message text (for input) or the full
`response.text` (for output). If you need finer control -- e.g. moderate individual content
parts, apply different models per category, or moderate tool arguments -- implement the
`Guardrail` interface directly:

```ts
import type { Guardrail, GuardrailDecision } from '@combycode/llm-sdk';
import { moderate } from '@combycode/llm-sdk';

const myGuardrail: Guardrail = {
  name: 'my-moderation',
  kind: 'input',
  async check(ctx): Promise<GuardrailDecision> {
    if (ctx.kind !== 'input') return { pass: true };
    // ctx.messages, ctx.system, ctx.step, ctx.trace.sessionId, ctx.trace.requestId are all available.
    const last = ctx.messages.at(-1);
    if (!last || last.role !== 'user') return { pass: true };
    const text = typeof last.content === 'string' ? last.content : '';
    const result = await moderate({ apiKey: '...', input: text });
    if (!Array.isArray(result) && result.flagged) {
      return { pass: false, tripwire: true, reason: 'Content policy violation', severity: 'high' };
    }
    return { pass: true };
  },
};
```

## Gotchas and next steps

**Missing API key throws at call time.** There is no deferred error. If `apiKey` is not
passed and `engine.apiKeys['openai']` is not set, `moderate()` throws synchronously before
making any HTTP request. Set the key once in `createEngine()` to avoid passing it everywhere.

**Non-OpenAI providers throw immediately.** The error message names the provider and explains
the constraint. Do not wrap this in a try/catch and silently continue -- the intention is to
surface misconfigured callers loudly.

**`categoryAppliedInputTypes` is omni-only.** Older models (`text-moderation-*`) do not return
this field. It is typed as optional and will be `undefined` on non-omni models.

**Array return vs single return.** The return type changes with `input` shape. TypeScript will
narrow this for you when you use a literal `string` vs `string[]`, but if your input type is
a union you will need to check `Array.isArray(result)`.

**Guardrail trip text.** When a guardrail trips, `response.text` is the trip reason string
(`'Input flagged by moderation'` or `'Output flagged by moderation'`). This is intentional --
the caller can forward that string to the user or map it to a friendlier message.

**Next steps:**
- [Agent Patterns](/docs/guides/agent-patterns/) -- full `Guardrail` interface, composing multiple
  guardrails, and the `onGuardrailTriggered` hook.
- [Observability / Telemetry](/docs/guides/telemetry/) -- subscribing to `onCostEntry` and
  `onGuardrailTriggered` for audit logs.
