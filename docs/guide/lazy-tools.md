# Lazy tools -- register without declaring

Tool definitions are sent in full on **every** request. One MCP server with 30
richly-schema'd tools is easily 15-40k tokens; three servers and the tool block dominates
the context before the conversation starts. That is two costs, not one: tokens on every
turn, and eventually a context-window failure, which is not a bill but a hard stop.

Mark a tool `lazy` and it is **registered but not declared**. The model finds it with a
built-in `tool_search`, which returns full schemas, and runs it through a built-in
`call_tool`.

```ts
import { connectMcp, createAgent } from '@combycode/llm-sdk';

// The common case: an entire MCP server, deferred.
const wiki = await connectMcp({ url: 'https://mcp.deepwiki.com/mcp' }, { lazy: true });

const agent = createAgent({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  tools: wiki.tools,
});

const res = await agent.complete('Which transports does the TypeScript SDK support?');
```

Nothing else changes. Every tool is still registered, namespaced and collision-checked
exactly as before; `tool_search` and `call_tool` are declared **only** when at least one
lazy tool exists, so an app that never opts in never sees them.

Per tool instead of per server:

```ts
import { defineTool } from '@combycode/llm-sdk';

const rare = defineTool({
  name: 'rare_thing',
  description: 'Something needed once in a hundred runs.',
  params: { id: 'string' },
  lazy: true,
  execute: ({ id }) => `did the rare thing to ${id}`,
});
```

`lazy` is a property of `AgentTool` itself, so a hand-written tool, a generated one and an
MCP tool all use the same switch.

## What it costs and what it saves

Measured over 308 tools, six tasks, three repetitions, on both providers -- correctness
checked by requiring the tool's own output to appear in the final answer, so a
plausible-sounding invention fails:

| | correctness | cost / task | requests / task |
|---|---|---|---|
| every tool declared | 18/18 | $0.01698 (claude-haiku-4.5) | 2 |
| **lazy** | **18/18** | **$0.00477** | 3 |
| every tool declared | 18/18 | $0.01518 (gpt-5.4-nano) | 2 |
| **lazy** | **18/18** | **$0.00043** | 3 |

**-72%** and **-97%** respectively, for one extra round trip and no loss of accuracy.

The saving does not come from caching. It comes from **never sending the tool block**: the
matched schemas arrive in a tool *result*, which lands after the cached prefix rather than
moving it, so the declared tool array is byte-identical on every request of the
conversation. A design that instead promoted discovered tools into the array costs **+63%**
against never deferring at all, because every promotion re-writes the whole cached prefix.

## When NOT to use it

**Below roughly a hundred richly-schema'd tools, lazy costs more than declaring
everything.** At 90 tools the same measurement put it at -24% against -65% for a design
that promotes only what it matched: the remaining prefix falls under the provider's minimum
cacheable size, so nothing caches, while a search round trip is still paid.

There is deliberately **no automatic threshold**. Whether deferring pays depends on the
*size* of your schemas, not their count, and an automatic cutoff on count would be guessing
with your money. Mark tools lazy on purpose.

## Watching it work

```ts
import { createAgent } from '@combycode/llm-sdk';

const agent = createAgent({ model: 'openai/gpt-5.4-nano', tools: [] });

agent.hooks.on('onToolSearch', ({ queries, matched, unmatched }) => {
  if (unmatched.length > 0) console.warn('no tool matched:', unmatched, 'from', queries);
});
```

`unmatched` is the field worth alerting on, and the reason is worth understanding.

Ranking is local token overlap over name, description and parameter names -- no embeddings,
no network call on the discovery path. It has no idea that "coughed up" means "payment
status": measured against raw user phrasing it returns **nothing at all** for indirect or
colloquial requests, scoring 0-1 out of 8.

That is survivable because **the model writes the query, not the user**. It reads "have they
coughed up yet" and searches for "invoice payment status". With every task rephrased into
exactly the register the ranker cannot handle, discovery still reached full recall on 36 of
36 runs.

But when a query does miss, that has to be said out loud. `tool_search` names the queries
that matched nothing and tells the model to try different words. Without that signal, a
request needing two capabilities quietly becomes a confident answer from one -- measured at
34/36 recall without it, 36/36 with it, costing 1.00 -> 1.19 searches per task.

## Attribution

`ToolCallReport.toolName` names the tool that actually **ran**, never `call_tool`, and adds
`discoveredVia: 'search'`:

```ts
import { createAgent } from '@combycode/llm-sdk';

const agent = createAgent({ model: 'openai/gpt-5.4-nano', tools: [] });
await agent.complete('do something');

for (const step of agent.lastReport?.steps ?? []) {
  for (const call of step.toolCalls) {
    console.log(call.toolName, call.discoveredVia ?? 'declared');
  }
}
```

Without that unwrapping every lazy call would read `call_tool` in your traces and
attribution would be worthless. Provider-side traces still show `call_tool`, which is
unavoidable -- the provider only ever saw the router.

## Tuning

```ts
import { createAgent } from '@combycode/llm-sdk';

createAgent({
  model: 'openai/gpt-5.4-nano',
  tools: [],
  lazyTools: {
    limit: 5,        // schemas returned per query (max 20)
    maxSearches: 5,  // searches per run
  },
});
```

`limit` is a real bound, not a formality: returning everything a query loosely matches
re-creates the cost the feature exists to avoid. `maxSearches` bounds a model that loops on
search -- exceeding it returns a tool result saying so and leaves the run alive, because a
model that keeps searching should be told, not killed. Searches do not count against
`maxSteps`.

## How it works

1. A lazy tool is registered into the same map as everything else, and filtered out of the
   `tools` array sent to the provider.
2. On the first lazy registration, `tool_search` and `call_tool` are registered like any
   other tool -- same collision policy, same dispatch, same timeout, same reports.
3. A short context layer tells the model its tools are not all listed and how to reach
   them. This is load-bearing: without it the same setup scored 8/12 and 9/12, because a
   model has no reason to suspect a tool it cannot see, and answers from whatever it did
   find. It is a few lines, **not** a catalog -- a catalog would be paid for on every turn,
   which is most of what makes eager exposure expensive.
4. `tool_search` ranks locally and returns full schemas as JSON, plus any unmatched queries.
5. `call_tool` resolves the name against the lazy tools and executes the real one. It
   resolves **only** lazy tools; naming a normally-declared tool returns a message saying to
   call it directly, because two ways to invoke the same tool would make traces ambiguous.

## Related

- [Tools -- defineTool](./tools.md)
- [MCP (Model Context Protocol)](./mcp.md)
- [Agent Loop](./agent-loop.md)
- [Telemetry](./telemetry.md)
