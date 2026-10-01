/** AgentLoop configuration. */

import type { HookBus } from '../bus/hook-bus';
import type { LLMClient } from '../llm/client';
import type { CacheConfig, ThinkingConfig } from '../llm/types/request';
import type { ConversationHistory } from './history';
import type { HistorySnapshot } from './history-types';
import type { ReflectAndRetryConfig } from './reflect-retry';
import type { AgentTool } from './types';
import type { LazyToolsConfig } from './lazy-tools';
import type { Guardrail, ToolInputGuardrail, ToolOutputBlockedMessage, ToolOutputGuardrail } from './guardrail-types';
import type { PermissionPolicy } from '../plugins/permissions/policy';
import type { ApprovalRequest, ApprovalDecision } from './approval-types';
import type { Persistence } from '../plugins/persistence/types';

export interface AgentLoopConfig {
  /** LLM client. AgentLoop reads `client.model` and uses `client.complete`/`client.stream`. */
  client: LLMClient;

  /** Backup clients for a step whose request fails in a way another model could
   *  survive -- a 429, a 503, a timeout. Tried in order, each once per step.
   *
   *  `route()` already does this for a one-shot call; a run is where it matters
   *  more. A rate limit on step 7 of a nine-step run threw away six steps of work
   *  and every tool call they paid for, and the only recourse was to start again.
   *
   *  Each STEP starts from the primary: a rate limit is transient, and a run that
   *  fell over once should not spend the rest of its life on the backup. And a
   *  streamed step stops being able to fall over at its first event -- a consumer
   *  holding half an answer cannot be handed the start of a different one.
   *
   *  `client.model` still reports the PRIMARY, as it must: it is read before any
   *  request is made. Each step's report and span name whoever actually served. */
  fallbackClients?: LLMClient[];

  /** Check a tool call's arguments against the tool's own schema BEFORE running
   *  it, and return the errors to the model instead of executing. Default `false`.
   *
   *  Opt-in, and the reason is the honest one: the bundled validator covers the
   *  common JSON Schema keywords, not all of Draft 2020-12 (no `allOf`/`anyOf`, no
   *  formats). On by default it would refuse calls that are valid under a schema
   *  it cannot fully read. Where a provider's own strict mode is available that is
   *  the better guarantee; this is for the models and surfaces where it is not,
   *  and for schemas strict mode cannot express.
   *
   *  A failure is a tool RESULT carrying the errors, not an exception: the model
   *  asked for something its schema forbids, which is a thing it can fix on the
   *  next step, and ending the run would discard every step before it. The bound
   *  is `maxSteps` -- the loop's existing one, rather than a second budget to tune
   *  that would give the same answer. An `onWarning` with code
   *  `tool_arguments_invalid` fires each time, so the loop is visible if the model
   *  never gets it right. */
  validateToolArguments?: boolean;

  /** Which failure classes move to the next client. Defaults to the set `route()`
   *  uses, which excludes the ones a different model cannot fix: auth, a
   *  malformed request, a content filter, a prompt that is simply too long. */
  fallbackOn?: import('../network/errors').ErrorKind[];

  /** Human name for this agent, e.g. `'briefing'`. Without it telemetry only has the
   *  agent's generated id, and a trace reads as `invoke_agent` with no clue which of your
   *  agents ran — the ids differ per process, so they cannot be compared across runs
   *  either. With it the span becomes `invoke_agent briefing` and carries
   *  `gen_ai.agent.name`, which is what the conventions ask for. */
  label?: string;

  /** Which part of YOUR system this agent belongs to, e.g. `'customer'`, `'moderation'`.
   *
   *  Free text rather than a fixed set, because the taxonomy is the application's: a
   *  library cannot know whether you divide by product surface, team, or bounded context,
   *  and forcing our categories on you would only make you encode yours inside a `label`.
   *  Exported as `agent.source` — our attribute, not a convention one; the GenAI spec has
   *  no term for it. */
  source?: string;

  /** Extra attributes stamped on this agent's span, for whatever the fixed fields do not
   *  cover — tenant, tier, experiment arm. Keys are used verbatim, so namespace them
   *  (`app.tenant`) to stay clear of convention attributes; ours win on a collision, so a
   *  stray key here cannot corrupt `gen_ai.*`. */
  attributes?: Record<string, string | number | boolean>;

  /** Persona / role text for the agent. Stored as the `agentloop.system` registry
   *  layer (priority 10). Composed with other system-tagged layers when sending.
   *  When passed as a function, it is re-evaluated at the start of every
   *  `complete()` / `stream()` call — useful for live-reload prompts backed
   *  by a config file or persistence collection. */
  system?: string | (() => string | Promise<string>);

  /** Run-scenario context (background for the current task). Stored as the
   *  `agentloop.context` registry layer (priority 100). */
  context?: string;

  /** Executable tools. Indexed by function name (FunctionTool) or type (BuiltinTool). */
  tools?: AgentTool[];

  /** What to do when two tools claim the same registry key.
   *
   *  Registration is a map keyed by function name / builtin type, so a collision means one tool
   *  SILENTLY replaces another and the model never sees it. The failure then surfaces much later
   *  as "the model called the wrong tool", with nothing in the logs pointing at the cause.
   *
   *  - `'warn'` (default) — keep last-write-wins, but emit an `onWarning`
   *    (`code: 'tool_name_collision'`) naming the key and which tool lost.
   *  - `'error'` — throw at construction / `addTool()`, before the model is ever called.
   *
   *  Defaults to `'warn'` so an app that unknowingly has a collision keeps working
   *  (CONSTITUTION.md R4) — the collision just stops being invisible. */
  toolNameCollisionPolicy?: 'warn' | 'error';

  /** Tuning for tools registered with `lazy: true`. Has no effect when none are — the
   *  built-in `tool_search` / `call_tool` are declared only if a lazy tool exists, so an
   *  app that never uses the feature never sees them.
   *
   *  There is deliberately no `threshold` here: whether deferring pays depends on the
   *  SIZE of the tool schemas, not their count, so an automatic cutoff would be guessing.
   *  Mark tools lazy explicitly. */
  lazyTools?: LazyToolsConfig;

  /** Self-healing recovery from a recoverable MODEL failure (a malformed tool call, a hallucinated
   *  tool name, a truncated call). The model is given structured guidance naming the attempt and
   *  told not to repeat the same call, then the step is retried within a bounded budget.
   *
   *  Off unless configured: a retry costs a real request, so it is the caller's decision. This is
   *  NOT a network retry — the engine already handles transport failures. This one is for a request
   *  that succeeded and came back unusable, which resending unchanged would never fix. */
  reflectAndRetry?: ReflectAndRetryConfig;

  /** Reuse an existing history (or rehydrate from a snapshot). New history
   *  is created when omitted. */
  history?: ConversationHistory | HistorySnapshot;

  /** Hook bus. Optional — a fresh bus is created when omitted. */
  hooks?: HookBus;

  // Request defaults applied to every step
  maxTokens?: number;
  temperature?: number;
  thinking?: ThinkingConfig;
  cache?: CacheConfig;

  // Tool execution
  parallelToolCalls?: boolean;
  toolTimeout?: number;

  /** Maximum number of tool-followup rounds per run.
   *  When the loop has completed this many steps and the model is still
   *  requesting tools, it stops before the next LLM call and sets the run
   *  reason to 'max_steps'.
   *
   *  Defaults to DEFAULT_MAX_STEPS (16) when omitted or undefined.
   *  Values <= 0 are treated as "use the default" (not "unlimited").
   *  To raise the limit pass a larger number; there is no way to disable
   *  the cap entirely -- set a very large value (e.g. 10_000) if needed. */
  maxSteps?: number;

  /** Input and output guardrails. Input guardrails run before each LLM call;
   *  output guardrails run after each step's response is produced.
   *  A tripwire decision halts the run with finishReason 'guardrail'. */
  guardrails?: Guardrail[];

  /** Per-tool-call input guardrails. Each runs against a tool call's arguments
   *  BEFORE the permission/approval check and execution. A trip denies just that
   *  call (error result to the model) without halting the run or invoking `approve`. */
  toolInputGuardrails?: ToolInputGuardrail[];

  /** Per-tool-call OUTPUT guardrails. Each runs against what the tool returned,
   *  before that reaches the model or the history.
   *
   *  A trip does not halt the run and does not fail the call: the output is
   *  withheld and a placeholder takes its place everywhere it would have been
   *  kept -- the result, the conversation, and any checkpoint written from it.
   *  The tool has already run, so what is left to control is what the output
   *  touches. */
  toolOutputGuardrails?: ToolOutputGuardrail[];

  /** What the model is told when a tool's output was withheld. A string, or a
   *  formatter. Defaults to a data-free sentence, and a formatter that throws
   *  or returns nothing falls back to it rather than to the output. */
  toolOutputBlockedMessage?: ToolOutputBlockedMessage;

  /** Permission policy wired into the tool-execution path.
   *  Called after lookup, before execution.
   *  'allow' -> proceed; 'deny' -> tool is blocked (error result to model);
   *  'ask'   -> call the `approve` callback for a human decision. */
  policy?: PermissionPolicy;

  /** Human-in-the-loop approver called when a policy rule says 'ask'.
   *  The loop suspends until the returned Promise resolves.
   *  The approver MUST always resolve (never reject) — return { decision: 'deny' }
   *  to block when the approval channel itself fails. */
  approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>;

  /** Durable checkpoint storage for the loop snapshot.
   *  When set, the loop persists its state (including pending approvals) at every
   *  approval suspension point, enabling kill-process / restore / resume flows.
   *  Must be cross-env: use MemoryPersistence for browser/tests, FilePersistence for Node.
   *  When omitted, state is kept in-memory only. */
  checkpoint?: Persistence;
}
