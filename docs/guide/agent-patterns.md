---
title: Agent Patterns
description: Handoffs, guardrails, permissions, and human-in-the-loop approval -- the full SDK coverage of OpenAI Agents SDK primitives.
---

# Agent Patterns

## What you will achieve

This guide shows how to build multi-agent systems with safe, observable control flow: agents that delegate to specialists, inputs and outputs that are screened before they affect state, tool access gated by declarative rules, and humans who can approve or reject actions before they execute.

## When and why you need this

- You have a task too broad for one agent and want a coordinator that routes to specialists.
- You need to ensure user input never contains harmful content before it reaches the model.
- You are giving agents file system or network tools and want to restrict what paths or URLs they can touch.
- Your deployment requires a human to approve any action that writes data or calls an external service.

## Step by step

### Step 1 -- delegate subtasks with `delegate()`

`delegate()` wraps an `AgentLoop` as an `AgentTool`. The parent agent calls it by tool name, passes a task string, and receives the sub-agent's reply text. This is the lightest-weight multi-agent composition pattern.

```ts
import { createAgent, delegate, complete } from '@combycode/llm-sdk';

// Build the specialist sub-agent.
const researcher = createAgent({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  system: 'You are a research specialist. Answer factual questions concisely.',
});

// Wrap as a tool. The parent agent sees a tool named 'research'.
const researchTool = delegate(
  'research',
  'Delegate a research question to the research specialist.',
  researcher,
);

// The orchestrator calls 'research' automatically when needed.
const { text } = await complete({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  prompt: 'Find the key facts about the Eiffel Tower and write a short paragraph.',
  tools: [researchTool],
  maxTokens: 512,
});
console.log(text);
```

`delegate()` signature:

```ts
function delegate(
  name: string,
  description: string,
  agent: AgentLoop,
): AgentTool
```

The tool receives `{ task: string }` from the parent, runs `agent.complete(task)`, and returns `response.text` as the tool result. Sub-agent usage is not forwarded to the parent.

### Step 2 -- structured handoff with `handoff()`

When the orchestrator needs to inspect sub-agent usage or routing metadata, use `handoff()` instead. It returns a JSON-serialized `HandoffResult` rather than bare text.

```ts
import { createAgent, handoff, AgentLoop, createLLM } from '@combycode/llm-sdk';

const analyst = new AgentLoop({
  client: createLLM({
    model: 'anthropic/claude-haiku-4.5',
    apiKey: process.env.ANTHROPIC_API_KEY!,
  }),
  system: 'You are a data analyst. Summarize the key metrics from the provided data.',
});

const analysisTool = handoff(
  'analyze_data',
  'Delegate data analysis to the analyst agent.',
  analyst,
  {
    // inputFilter reshapes the task before forwarding to the sub-agent.
    inputFilter: (task) => `Analyze this data and be concise:\n${task}`,
  },
);

const orchestrator = createAgent({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  tools: [analysisTool],
});

const response = await orchestrator.complete(
  'Analyze this data: sales=100, returns=5, revenue=9500.',
);
// The orchestrator receives JSON: { text, usage, agentName }
console.log(response.text);
```

`handoff()` signature:

```ts
function handoff(
  name: string,
  description: string,
  agent: AgentLoop,
  opts?: HandoffOptions,
): AgentTool

interface HandoffOptions {
  inputFilter?: (task: string) => string;
}

interface HandoffResult {
  text: string;          // sub-agent reply text
  usage: Usage | null;   // token usage from the sub-agent run
  agentName: string;     // the name argument passed to handoff()
}
```

The orchestrator's cost ledger records only orchestrator usage. The sub-agent's usage is embedded in the `HandoffResult` JSON and is not automatically rolled up.

### Step 3 -- gate tool access with `PermissionPolicy`

A `PermissionPolicy` is a declarative rule list that evaluates `(source, target, action)` triples. Rules are checked in declaration order; the first match wins. No matching rule defaults to deny.

```ts
import {
  createEngine,
  createAgent,
  PermissionPolicy,
  fsGlob,
  urlPattern,
  defineTool,
} from '@combycode/llm-sdk';

const policy = new PermissionPolicy([
  // Allow reading any file inside ./src.
  { action: 'read', target: fsGlob('./src/**'), effect: 'allow' },
  // Allow fetching from a specific API domain only.
  { action: 'fetch', target: urlPattern('https://api.trusted.com/**'), effect: 'allow' },
  // Deny everything else.
  { effect: 'deny', reason: 'not in allowlist' },
]);

const readFile = defineTool({
  name: 'read_file',
  description: 'Read a source file.',
  params: { path: 'string' },
  execute: ({ path }, ctx) => {
    const decision = policy.check(
      ctx.trace?.sessionId ?? 'agent',         // source
      { kind: 'fs', path },           // target (PermissionTarget)
      'read',                          // action
    );
    if (!decision.allow) {
      return `Permission denied: ${decision.reason}`;
    }
    // ... actually read the file
    return `contents of ${path}`;
  },
});
```

`PermissionPolicy.check()` returns a `PermissionDecision`:

```ts
interface PermissionDecision {
  allow: boolean;       // true only for effect 'allow'
  ask?: boolean;        // true when effect is 'ask' (human approval needed)
  reason?: string;      // from the matched rule
  matchedRule?: number; // index of the winning rule
}
```

### Step 4 -- human-in-the-loop approval

The `'ask'` effect on a rule signals that human approval is needed before proceeding. The tool's `execute` function is responsible for actually obtaining that approval -- the policy just communicates the requirement.

```ts
import { defineTool, PermissionPolicy } from '@combycode/llm-sdk';
import * as readline from 'node:readline/promises';

const policy = new PermissionPolicy([
  { action: 'deploy', effect: 'ask', reason: 'human approval required before any deploy' },
]);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const deployTool = defineTool({
  name: 'deploy',
  description: 'Deploy the application to an environment.',
  params: { environment: 'string' },
  execute: async ({ environment }, ctx) => {
    const decision = policy.check(ctx.trace?.sessionId ?? 'agent', { kind: 'deploy', environment }, 'deploy');

    if (decision.ask) {
      const answer = await rl.question(`Approve deploy to "${environment}"? [y/N] `);
      if (answer.trim().toLowerCase() !== 'y') {
        return 'Deployment cancelled by user.';
      }
    }

    if (!decision.allow && !decision.ask) {
      return `Blocked: ${decision.reason}`;
    }

    return `Deployed to ${environment}.`;
  },
});
```

For async pipelines replace `readline` with a queue: push to a webhook, store a pending-approval row in a database, await a resolve from an external UI. See `/docs/guides/approval-and-checkpoints/` for the full checkpoint pattern.

### Step 5 -- hook-based tripwires

Hooks let you halt a run from outside the tool layer. Throw from a hook handler to stop the agent loop before it even makes an LLM call.

```ts
import { createEngine, createAgent } from '@combycode/llm-sdk';

const engine = createEngine({ apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY! } });

// Block any prompt containing a forbidden keyword.
engine.hooks.on('onRunStart', (ctx) => {
  const input = String(ctx.input ?? '');
  if (input.toLowerCase().includes('delete all')) {
    throw new Error('Tripwire: "delete all" is not allowed in agent prompts.');
  }
});

const agent = createAgent({ model: 'anthropic/claude-haiku-4.5', engine });

try {
  await agent.complete('Please delete all the files.');
} catch (err) {
  console.error((err as Error).message); // Tripwire: ...
}
```

Hooks fire synchronously via `emitSync` for lifecycle events like `onRunStart`. This means throwing from a handler immediately aborts the call path -- no LLM call is dispatched.

### Step 6 -- custom guardrails

A `Guardrail` is an async check that runs inside the `AgentLoop`, either before (`kind: 'input'`) or after (`kind: 'output'`) each LLM call. A tripwire decision halts the loop.

```ts
import { createAgent } from '@combycode/llm-sdk';
import type { Guardrail, GuardrailDecision, GuardrailCheckContext } from '@combycode/llm-sdk';

const lengthGuard: Guardrail = {
  name: 'input-length',
  kind: 'input',
  async check(ctx: GuardrailCheckContext): Promise<GuardrailDecision> {
    if (ctx.kind !== 'input') return { pass: true };
    const lastUser = [...ctx.messages].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
    if (text.length > 10_000) {
      return {
        pass: false,
        tripwire: true,
        reason: 'Input exceeds 10,000 characters.',
        severity: 'medium',
      };
    }
    return { pass: true };
  },
};

const agent = createAgent({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  guardrails: [lengthGuard],
});
```

Multiple guardrails run in declaration order. The first tripwire stops the run; subsequent guardrails are not checked. The loop emits `onGuardrailTriggered` on the hook bus when a tripwire fires:

```ts
engine.hooks.on('onGuardrailTriggered', (ctx) => {
  // ctx: { runId, agentId, step, guardrailName, kind, reason, severity?, trace? }
  console.log(`Guardrail "${ctx.guardrailName}" tripped (${ctx.kind}):`, ctx.reason);
});
```

### Step 7 -- built-in moderation guardrail

`moderationGuardrail()` is a factory that creates one or two `Guardrail` instances backed by the OpenAI moderation endpoint. Use it as the fastest path to content screening.

```ts
import { createAgent, moderationGuardrail } from '@combycode/llm-sdk';

const guards = moderationGuardrail({
  apiKey: process.env.OPENAI_API_KEY,  // required; free endpoint
  input: true,                          // screen the last user message (default: true)
  output: true,                         // screen the assistant reply (default: false)
  model: 'omni-moderation-latest',     // optional; this is the default
});

const agent = createAgent({
  model: 'anthropic/claude-haiku-4.5',
  apiKey: process.env.ANTHROPIC_API_KEY,
  guardrails: guards,      // guards is Guardrail[]
});
```

`moderationGuardrail` options:

```ts
interface ModerationGuardrailOptions {
  apiKey?: string;     // OpenAI key; falls back to engine.apiKeys['openai']
  input?: boolean;     // default: true
  output?: boolean;    // default: false
  model?: string;      // moderation model; default: omni-moderation-latest
  name?: string;       // custom guardrail name prefix
}
```

An OpenAI key is required even when the generation model is Anthropic or another provider. The moderation endpoint is free.

## Your options

### `delegate()` vs `handoff()`

| Feature | `delegate()` | `handoff()` |
|---|---|---|
| Tool return to parent | bare reply text | JSON `HandoffResult`: `{ text, usage, agentName }` |
| Sub-agent token usage visible to parent | no | yes (in tool result) |
| Input transformation | no | yes, via `inputFilter` option |
| Usage case | simple routing, lowest overhead | orchestrators that need metadata, cost attribution |

Both wrap `AgentLoop` as a normal `AgentTool` so they flow through the standard hook / permission / guardrail path.

### `PermissionPolicy` rule fields

```ts
interface Rule {
  source?: string | string[];  // agent ID(s); '*' matches all; absent = match any
  target?: TargetMatcher;      // function (target: PermissionTarget) => boolean
  action?: string | string[];  // e.g. 'read', 'fetch'; '*' matches all; absent = match any
  effect: 'allow' | 'deny' | 'ask';
  reason?: string;             // surfaced in PermissionDecision.reason
}
```

Rules with no `source`, `target`, or `action` field match everything -- useful as a catch-all deny at the end.

### Built-in `TargetMatcher` factories

| Factory | Matches targets where... |
|---|---|
| `fsGlob(...patterns)` | `target.kind === 'fs'` and `target.path` matches a glob |
| `urlPattern(...patterns)` | `target.kind === 'url'` and `target.url` matches a glob |
| `shellGlob(...patterns)` | `target.kind === 'shell'` and `target.command` matches a glob |
| `memoryCategory(...cats)` | `target.kind === 'memory'` and `target.category` is in the list |
| `anyOfKind(...kinds)` | `target.kind` is in the list |

You can compose them or write your own `TargetMatcher`: any `(target: PermissionTarget) => boolean` function.

### `Guardrail` interface

```ts
interface Guardrail {
  name: string;    // unique label shown in hooks and error messages
  kind: 'input' | 'output';
  check(ctx: GuardrailCheckContext): Promise<GuardrailDecision>;
}
```

Context types:

```ts
// Before the LLM call:
interface InputGuardrailContext {
  kind: 'input';
  // trace.sessionId = agentId (ConversationHistory id)
  // trace.requestId = runId for this .complete()/.stream() invocation
  trace: TraceContext;
  step: number;
  messages: Message[];
  system?: string;
}

// After a step's response:
interface OutputGuardrailContext {
  kind: 'output';
  // trace.sessionId = agentId (ConversationHistory id)
  // trace.requestId = runId for this .complete()/.stream() invocation
  trace: TraceContext;
  step: number;
  response: CompletionResponse;
}
```

Decision types:

```ts
// Pass: continue normally.
interface GuardrailPass { pass: true; }

// Trip: halt the run immediately.
interface GuardrailTrip {
  pass: false;
  tripwire: true;
  reason: string;
  severity?: 'low' | 'medium' | 'high';
}
```

### OpenAI Agents SDK concept mapping

| OpenAI Agents SDK | This SDK |
|---|---|
| `handoff` / agent transfer (text) | `delegate(name, desc, agent)` |
| `handoff` with usage metadata | `handoff(name, desc, agent, opts)` |
| `InputGuardrailTripwireTriggered` | `Guardrail` with `kind: 'input'`, return `{ pass: false, tripwire: true }` |
| `OutputGuardrailTripwireTriggered` | `Guardrail` with `kind: 'output'`, return `{ pass: false, tripwire: true }` |
| Moderation guardrail | `moderationGuardrail({ apiKey })` |
| `FunctionTool(needs_approval=True)` | `PermissionPolicy` with `effect: 'ask'` + approval logic in `execute` |
| Automatic context window management | `ContextGuard` + `ContextMeasurer` -- see `/docs/guides/context-guard` |

## Gotchas and next steps

**`guardrails` accepts a flat array, not nested arrays.** `moderationGuardrail()` returns `Guardrail[]`. Spread it when combining with other guardrails:

```ts
guardrails: [...moderationGuardrail({ apiKey }), lengthGuard]
```

**`PermissionPolicy` default-denies when no rule matches.** An empty policy `new PermissionPolicy([])` denies everything. Always add a catch-all `{ effect: 'deny' }` or `{ effect: 'allow' }` at the end of your rule list to make the default explicit and readable.

**`PermissionPolicy` does not automatically hook into `AgentLoop`.** It is a pure evaluator. You call `policy.check(...)` inside your tool's `execute` function. The loop does not automatically run policy checks before tool calls. This gives you full control over what the check looks like and what the tool returns on denial.

**Hook handlers that throw synchronously do halt the loop.** But async errors thrown from `on()` handlers are not caught by the engine. If you need async blocking (e.g. a remote moderation check before the run starts), use an input `Guardrail` instead of a hook.

**`handoff()` does not roll up sub-agent cost to the parent ledger.** The `HandoffResult.usage` field gives you the data to do this manually if you need it. Call `engine.cost.import(entries)` to merge entries from a sub-agent session.

**Related guides:**

- `/docs/guides/agent-loop` -- `AgentLoop`, `createAgent`, multi-step loops
- `/docs/guides/tools` -- `defineTool`, `AgentTool`, tool schemas
- `/docs/guides/moderation` -- full `moderate()` helper API
- `/docs/guides/approval-and-checkpoints` -- async human approval with queue-backed checkpoints
- `/docs/guides/context-guard` -- context window management, `ContextGuard`, permissions wiring
- `/docs/guides/telemetry` -- hook bus events and observability
