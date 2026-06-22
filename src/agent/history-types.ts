/** ConversationHistory types: entries, config, and serialized snapshots. */

import type { Message } from '../llm/types/messages';
import type { Usage } from '../llm/types/response';
import type { RegistrySnapshot } from './context-registry/types';
import type { TokenCounter } from './types';

export interface HistoryEntry {
  index: number;
  message: Message;
  timestamp: number;
  model?: string;
  usage?: Usage;
  latencyMs?: number;
  tokenEstimate?: number;
}

export interface ConversationHistoryConfig {
  id?: string;
  /** Optional token counter. If absent, falls back to length/4 heuristic. */
  counter?: TokenCounter;
  /** Provider/model hint for counter strategy. */
  provider?: string;
  model?: string;
  /** Which ContextGuard strategy should apply to this conversation.
   *  - string: strategy name, matched against the guard's strategies map.
   *  - false: opt out of context-guarding entirely for this conversation.
   *  - undefined: use the guard's defaultStrategy.
   *  Stored in metadata.contextStrategy; readable/writable at runtime. */
  strategy?: string | false;
}

export interface HistorySnapshot {
  id: string;
  entries: HistoryEntry[];
  /** Legacy field — preserved for backward compat with existing snapshots.
   *  When both `system` and `registry` are present, `registry` wins on restore. */
  system?: string;
  /** Layered context state (system prompt, facts, memory, ...). */
  registry?: RegistrySnapshot;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
