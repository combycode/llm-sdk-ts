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

// ─── Priorities (lower = earlier in render) ──────────────────────────────

export const PRIORITY_AGENTLOOP_SYSTEM = 10;
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
