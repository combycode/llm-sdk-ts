/** ExecuteOptions — per-call overrides for client.complete()/.stream(). */

import type { ConversationHistory } from '../../agent/history';
import type { RequestContext } from '../../types/request-context';
import type { ModerationRequest } from '../moderation/types';
import type { AudioOptions } from './audio';
import type { CacheConfig, ThinkingConfig } from './request';
import type { ServiceTier } from './tiers';
import type { Tool, ToolChoice } from './tools';

export interface ExecuteOptions {
  /** Per-call system prompt. Stacked with LLMClient.system + any role:'system'
   *  messages from the input (in this priority order). When AgentLoop calls
   *  the client it passes its composed registry-system here so that layered
   *  prompts (role / context / facts / chat.facts / context-guard.summary)
   *  flow through to the request without depending on the immutable
   *  LLMClient.system. */
  system?: string;

  /** Conversation reference, propagated into onMessageResolve so listeners
   *  (ContextGuard, FilesRegistry) can route per-conversation. */
  history?: ConversationHistory;

  // Generation control
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];

  // Tools (schema-only — caller dispatches; AgentLoop's executable tools come
  // from its constructor and are merged in at the agent layer).
  tools?: Tool[];
  toolChoice?: ToolChoice;

  // Structured output
  structured?: {
    schema: Record<string, unknown>;
    name?: string;
    strict?: boolean;
  };

  // Audio output (voice/format) + which modalities to return. Default ['text'].
  audio?: AudioOptions;
  outputModalities?: Array<'text' | 'audio'>;

  // Thinking / reasoning
  thinking?: ThinkingConfig;

  // Cache control
  cache?: CacheConfig;

  /** Service tier for this call — 'auto' | 'standard' | 'priority' | 'flex' (or
   *  any provider-accepted string). Maps per-provider; unsupported → no-op.
   *  `batch` is the separate Batch API, not a value here. */
  serviceTier?: ServiceTier;

  /** Inline content moderation (report-only — attaches results, never blocks).
   *  OpenAI runs it natively; other providers are emulated via OpenAI's
   *  moderations endpoint. See ModerationRequest. */
  moderation?: ModerationRequest;

  // Provider-specific
  providerOptions?: Record<string, unknown>;

  // Provider chain support
  previousResponseId?: string;
  /** Server-state optimization: when the prior assistant turn carries a usable
   *  server id (same provider, within TTL, model ok), send the id + only the new
   *  turn instead of the full transcript. Default ON; set false to always resend
   *  history (fully portable). Ignored if `previousResponseId` is set manually. */
  stateful?: boolean;

  // Request lifecycle
  signal?: AbortSignal;
  timeout?: number;

  // Routing / context overrides (override LLMClient defaults for this call)
  cacheKey?: string;
  cacheName?: string;
  configName?: string;
  ctx?: Partial<RequestContext>;
}
