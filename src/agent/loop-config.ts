/** AgentLoop configuration. */

import type { HookBus } from '../bus/hook-bus';
import type { LLMClient } from '../llm/client';
import type { CacheConfig, ThinkingConfig } from '../llm/types/request';
import type { ConversationHistory } from './history';
import type { HistorySnapshot } from './history-types';
import type { AgentTool } from './types';
import type { Guardrail } from './guardrail-types';
import type { PermissionPolicy } from '../plugins/permissions/policy';
import type { ApprovalRequest, ApprovalDecision } from './approval-types';
import type { Persistence } from '../plugins/persistence/types';

export interface AgentLoopConfig {
  /** LLM client. AgentLoop reads `client.model` and uses `client.complete`/`client.stream`. */
  client: LLMClient;

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
