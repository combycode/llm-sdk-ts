/** Well-known system layer names + priorities used by SDK subsystems.
 *
 *  AgentLoop, ContextGuard, memory tools and other writers all contribute
 *  layers to a conversation's `history.registry`. Their relative priority
 *  determines the rendered order of the system prompt the LLM sees.
 *
 *  Lower priority renders earlier (closer to the top of the system prompt).
 *  Stable prefix layers go first so prompt-cache hits are maximized; dynamic
 *  contributors (memory, facts) come after. */

import type { ContextRegistry } from './registry';

// ─── Layer names (canonical strings) ─────────────────────────────────────

/** Role / persona / behavior. Stable per-conversation. Lowest priority so
 *  cache prefixes start here. */
export const LAYER_AGENTLOOP_SYSTEM = 'agentloop.system';

/** Run-scenario context the AgentLoop was constructed with (e.g. background
 *  for the current task). Stable per-run; rendered after system. */
export const LAYER_AGENTLOOP_CONTEXT = 'agentloop.context';

/** Legacy ConversationHistory.system setter — kept for backward compat with
 *  pre-registry callers. */
export const LAYER_LEGACY_SYSTEM = '_legacy_system';

/** Memory layer for free-form notes / scratch (long-lived, low churn). */
export const LAYER_MEMORY = 'memory';

/** Conversational facts surfaced from the user/assistant pair. Updated turn-
 *  to-turn so it lands later in render order to keep earlier prefix stable. */
export const LAYER_CHAT_FACTS = 'chat.facts';

/** Worker-side: examples log distilled from prior tool calls. */
export const LAYER_EXECUTOR_TOOL_EXAMPLES = 'executor.tool-examples';

/** ContextGuard's compaction summary layer (replaces compacted message ranges). */
export const LAYER_CONTEXT_GUARD_SUMMARY = 'context-guard.summary';

/** How to reach tools that are registered but not declared. Present only while at least
 *  one lazy tool exists. See `writeLazyToolsProtocol`. */
export const LAYER_LAZY_TOOLS = 'agentloop.lazy-tools';

// ─── Priorities (lower = earlier in render) ──────────────────────────────

export const PRIORITY_AGENTLOOP_SYSTEM = 10;
/** Just after the agent's own system text: the model needs to know its tools are not
 *  listed before anything else it is told about them. */
export const PRIORITY_LAZY_TOOLS = 20;
export const PRIORITY_LEGACY_SYSTEM = 50;
export const PRIORITY_AGENTLOOP_CONTEXT = 100;
export const PRIORITY_MEMORY = 200;
export const PRIORITY_CHAT_FACTS = 250;
export const PRIORITY_EXECUTOR_TOOL_EXAMPLES = 280;
export const PRIORITY_CONTEXT_GUARD_SUMMARY = 300;

// ─── System layer writer (helper interface) ──────────────────────────────

/** Set the AgentLoop's persona/system layer on a registry (or remove if blank). */
export function writeAgentLoopSystem(
  registry: ContextRegistry,
  text: string | undefined,
  owner: string,
): void {
  if (!text) {
    registry.remove(LAYER_AGENTLOOP_SYSTEM);
    return;
  }
  registry.set(LAYER_AGENTLOOP_SYSTEM, text, {
    priority: PRIORITY_AGENTLOOP_SYSTEM,
    tags: ['system'],
    owner,
  });
}

/** Tell the model that its tools are not all listed, and how to reach the rest.
 *
 *  Without this the feature under-performs badly and quietly: measured over 24 live runs
 *  against 308 lazy tools, the model scored 8/12 and 9/12 — sometimes never searching at
 *  all, more often searching once for a request that needed two capabilities and
 *  answering from the one tool it found. With the protocol stated, the same tasks and the
 *  same ranker scored 18/18. The tool descriptions alone are not enough, because a model
 *  has no reason to suspect a tool exists that it cannot see.
 *
 *  Deliberately a few lines and NOT a catalog. A catalog is paid for on every turn for
 *  the whole conversation, which is most of what makes eager exposure expensive in the
 *  first place; this is a fixed cost of roughly one sentence. */
export function writeLazyToolsProtocol(registry: ContextRegistry, active: boolean, owner: string): void {
  if (!active) {
    registry.remove(LAYER_LAZY_TOOLS);
    return;
  }
  registry.set(
    LAYER_LAZY_TOOLS,
    'Not all of your tools are listed. Use `tool_search` to find the ones you need — it returns their ' +
      'exact names and full argument schemas — then run them with `call_tool`. Search for every ' +
      'capability the request needs in ONE call, passing several queries. If the result reports a ' +
      'query as unmatched, search again with different words before answering; never answer as if a ' +
      'capability you could not find does not matter.',
    { priority: PRIORITY_LAZY_TOOLS, tags: ['system'], owner },
  );
}

/** Set the AgentLoop's run-scenario context layer (or remove if blank). */
export function writeAgentLoopContext(
  registry: ContextRegistry,
  text: string | undefined,
  owner: string,
): void {
  if (!text) {
    registry.remove(LAYER_AGENTLOOP_CONTEXT);
    return;
  }
  registry.set(LAYER_AGENTLOOP_CONTEXT, text, {
    priority: PRIORITY_AGENTLOOP_CONTEXT,
    tags: ['system'],
    owner,
  });
}
