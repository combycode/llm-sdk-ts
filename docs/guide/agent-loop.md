# Agent Loop -- createAgent / delegate / chain / consolidate / parallel

The agent layer runs a multi-step tool loop over an LLM: call the model, execute
tools it requests, feed results back, repeat until the model stops requesting
tools. The loop is built into `complete()` when you pass `tools`, but `createAgent`
gives you a stateful, reusable agent with persistent history and richer lifecycle
hooks.

## When to reach for this

- You need a stateful agent that remembers conversation history across multiple
  user turns (use `createAgent`).
- You want to compose agents: one agent delegates subtasks to another (`delegate`),
  runs steps in sequence (`chain`), in parallel (`parallel`), or resolves
  disagreement between multiple agents (`consolidate`).
- You need to observe agent events (tool calls, run completion) reactively
  (`createObserver`).

## Main exports

| Export | What it does |
|---|---|
| `createAgent(opts)` | Builds an `AgentLoop` with an optional pre-built `LLMClient` or a model string. Wires hooks from the engine. |
| `AgentLoop` | The loop class. `.complete(prompt)` runs one conversation turn (tool loop included). `.stream(prompt)` streams events. |
| `delegate(name, description, agent)` | Wraps an `AgentLoop` as an `AgentTool` so a parent agent can call it by name. The tool passes a `task: string` and returns the sub-agent's reply. |
| `chain(steps, opts)` | Sequential pipeline: each step's output string becomes the next step's input. Steps are either `complete()` call configs or plain async functions. |
| `parallel(tasks, opts)` | Run multiple `complete()` calls simultaneously; returns all results. |
| `consolidate(opts)` | Multi-agent debate: N agents answer in parallel over rounds, a judge LLM decides agreement, the loop ends early on consensus and produces a summary. |
| `createObserver(agent, event, reactor)` | Subscribe to an agent lifecycle event; reactor is a plain async function or itself an agent config. |
| `ConversationHistory` | Stores and replays the agent's message history. Importable/exportable as a snapshot for persistence. |
| `ContextRegistry` | Layered system-prompt builder. The agent loop populates it; you can write custom layers (e.g. facts, user profile). |

Type-only exports: `AgentLoopConfig`, `AgentTool`, `AgentStreamEvent`,
`AgentRunReport`, `HistorySnapshot`, `ContextLayer`, and related.

## Minimal examples

### Stateful agent (multi-turn)

```ts
import { createEngine, createAgent, defineTool } from '@combycode/llm-sdk';

createEngine({
  catalog: 'defaults',
  apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! },
});

const agent = createAgent({
  model: 'anthropic/claude-haiku-4.5',
  system: 'You are a helpful assistant.',
  tools: [
    defineTool({
      name: 'get_time',
      description: 'Return the current UTC time.',
      params: {},
      execute: () => new Date().toISOString(),
    }),
  ],
});

const r1 = await agent.complete('What time is it?');
console.log(r1.text);

const r2 = await agent.complete('Add one hour to that time.');
console.log(r2.text); // agent remembers r1's context
```

### Delegate -- agent as a tool

```ts
import { createAgent, delegate, complete } from '@combycode/llm-sdk';

const researcher = createAgent({
  model: 'anthropic/claude-haiku-4.5',
  system: 'You are a research specialist. Answer factual questions concisely.',
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const { text } = await complete({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  prompt: 'Summarize the key facts about the Eiffel Tower.',
  tools: [delegate('research', 'Look up factual information on a topic.', researcher)],
});
console.log(text);
```

### Chain -- sequential pipeline

```ts
import { chain } from '@combycode/llm-sdk';

const pipeline = chain([
  {
    model: 'anthropic/claude-haiku-4.5',
    apiKey: process.env.ANTHROPIC_API_KEY,
    name: 'summarize',
    prompt: (input) => `Summarize this in one sentence: ${input}`,
    maxTokens: 80,
  },
  {
    model: 'anthropic/claude-haiku-4.5',
    apiKey: process.env.ANTHROPIC_API_KEY,
    name: 'translate',
    prompt: (input) => `Translate to French: ${input}`,
    maxTokens: 80,
  },
]);

const result = await pipeline('The sky is blue because of Rayleigh scattering of sunlight.');
console.log(result);
```

### Consolidate -- multi-agent debate

```ts
import { consolidate } from '@combycode/llm-sdk';

const result = await consolidate({
  agents: [
    { name: 'Analyst A', model: 'anthropic/claude-haiku-4.5', system: 'You are a financial analyst.' },
    { name: 'Analyst B', model: 'openai/gpt-5.4-nano', system: 'You are a risk analyst.' },
  ],
  task: 'Should a startup invest in GPU hardware or rent cloud compute?',
  judge: { model: 'anthropic/claude-opus-4.8' },
  rounds: 3,
  onRound: ({ round, agreed }) => console.log(`Round ${round}: agreed=${agreed}`),
});
console.log(result.summary);
```

## Bounding the tool loop with maxSteps

By default the loop allows up to **16 tool-followup rounds** per `complete()` /
`stream()` call. If the model keeps requesting tools beyond that limit the loop
stops before the next LLM call and returns with:

- `AgentRunReport.reason === 'max_steps'`
- `CompletionResponse.finishReason === 'length'`
- `CompletionResponse.text` set to `"stopped: reached maxSteps (<N>)"`

The cap exists to prevent runaway cost and latency when a model or tool enters
a pathological loop.

### Configuring the cap

Pass `maxSteps` in `AgentLoopConfig` (or the `createAgent` options):

```ts
const agent = createAgent({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  tools: [...],
  maxSteps: 32, // raise the limit
});
```

Values `<= 0` are ignored and the default (16) applies. There is no way to
fully disable the cap; set a very large number (e.g. `10_000`) if you genuinely
need unbounded execution.

### Detecting the cap in callers

```ts
const res = await agent.complete('...');
if (res.finishReason === 'length') {
  // check whether it is a maxSteps stop, not a token-length truncation
  const report = agent.lastReport;
  if (report?.reason === 'max_steps') {
    console.warn('tool loop capped after', report.stepCount, 'steps');
  }
}
```

The same `reason` is delivered in the `onRunComplete` hook payload.

## Errors vs bounded stops

A **failed LLM call** during a run (auth, rate limit, context overflow, provider error) **throws** out
of `agent.complete()` / `agent.stream()` — the original `LLMError` (with `kind`/`status`) — matching a
no-tools `complete()`. It never silently returns empty text. If you want partial results + a status
instead of a throw, use `agent.run()`, which returns an `AgentRunReport` with `reason: 'error'` and the
`error` message. **Bounded stops** are not errors: `max_steps` returns `finishReason: 'length'` (see
above) and a model refusal returns normally — both are inspectable via `finishReason` / `report.reason`.

## Recovering from a model failure (`reflectAndRetry`)

Some failures are the model's, not the network's: a malformed tool call, a truncated call, a
hallucinated tool name. Resending the identical request would never fix them, so the network retry
layer correctly leaves them alone — and the run used to end there.

`reflectAndRetry` gives the model a bounded number of second chances, telling it what went wrong:

```ts
const agent = createAgent({
  client,
  tools: [...],
  reflectAndRetry: { maxRetries: 2 },   // OFF unless configured — a retry costs a real request
});
```

On a triggering finish reason the loop injects structured guidance naming the attempt number and
**explicitly instructing the model not to repeat the same call** (without that, models tend to
re-emit identical arguments and burn the whole budget on one mistake), then retries the step. The
failed assistant turn is *not* appended, so the model does not learn from its own broken output.

- Default trigger: `malformed_tool_call`. Override with `onFinishReasons` — a content filter is
  usually a decision rather than a mistake, so it is not retried by default.
- Failures are counted **consecutively**: a success clears the streak, so an agent that recovers and
  stumbles again much later gets a fresh budget rather than an inherited one.
- When the budget is spent the loop throws, naming the escape hatch. Set `throwIfExceeded: false` to
  get the unusable response back instead.

This exists because `finishReason` now tells the truth about these turns. Google's
`MALFORMED_FUNCTION_CALL` was previously unmapped and read as a clean `stop` with no content — a
failure that looked like a successful empty answer.

## Which text is the answer?

Codex-family models narrate before answering. Those parts are tagged
`phase: 'commentary'` versus `'final_answer'`, and `response.text` concatenates **everything** — so
an agent's output used to include its own thinking-out-loud.

`AgentLoop` now derives its answer with `finalAnswerText()`, which drops commentary. `response.text`
and `contentText()` are unchanged, so callers who want the narration still get it:

```ts
import { finalAnswerText } from '@combycode/llm-sdk';

const answer = finalAnswerText(res.content);   // commentary excluded
console.log(res.text);                          // everything, as before
```

`AssistantPhase` is an open union, and `finalAnswerText` excludes only what is explicitly
`'commentary'` rather than keeping only `'final_answer'` — the day a provider adds a third phase, an
allow-list would silently drop the answer.

## Tool-name collisions

Tools are indexed by function name (or builtin type), so registering two under the same key means
one **silently replaces** the other and the model never sees it. That surfaces much later as "the
model called the wrong tool", with nothing in the logs pointing at the cause.

Collisions are now reported. Default `'warn'` keeps last-write-wins (changing it would break apps
that rely on a deliberate override) but emits an `onWarning` with code `tool_name_collision` naming
which tool lost. `toolNameCollisionPolicy: 'error'` throws at construction instead, before the model
is ever called.

## Server-state continuation

On a stateful API (OpenAI Responses, Google Interactions) the loop automatically **continues by id**
(`previous_response_id` / `previous_interaction_id`) between tool rounds instead of resending the whole
transcript — gated by the catalog's retention TTL (openai/xai 30d, google 72h) and model binding. No
configuration needed; it falls back to full history when the stored turn is too old or the provider
isn't stateful.

## Related

- [Tools (defineTool)](./tools.md)
- [LLM Client + complete/stream](./llm-client.md)
- [Observability / Telemetry](./telemetry.md)
- [Context guard + context measurer](./context-guard.md)
- [Agent patterns mapping](./agent-patterns.md)
