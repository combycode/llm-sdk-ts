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
  /** Restrict sampling to the k most likely tokens. Sent to Anthropic, Google
   *  (generateContent + Interactions), xAI chat and OpenRouter chat; dropped for OpenAI,
   *  which defines no top-k.
   *
   *  ACCEPTED IS NOT HONOURED. A behavioural test on 2026-07-29 (top_k=1 must force greedy
   *  decoding) found only **Anthropic** actually applies it: six samples collapsed to a
   *  single output. Google (gemini-2.5-flash, 3.6-flash) and xAI (grok-4.20) returned 200
   *  but showed no greedy effect — accepted and inert on those models. It is still sent
   *  (harmless, and may apply elsewhere) but do not rely on it outside Anthropic. */
  topK?: number;
  /** Best-effort deterministic sampling: the same seed + params should return the same
   *  result. Honoured by OpenAI **chat-completions** (the Responses API rejects it), Google
   *  (generateContent + Interactions), xAI (chat + responses) and OpenRouter chat.
   *  Anthropic has no seed, so it is dropped there. Determinism is never guaranteed. */
  seed?: number;
  /** Penalise tokens by prior presence ([-2, 2]). Honoured by OpenAI/xAI chat-completions,
   *  OpenRouter, and Google (generateContent + Interactions); ignored by OpenAI/xAI Responses
   *  and Anthropic, which don't accept it. */
  presencePenalty?: number;
  /** Penalise tokens by prior frequency ([-2, 2]). Same provider support as `presencePenalty`. */
  frequencyPenalty?: number;
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
    /** Opt-in repair: if the model's final output fails to parse, re-prompt this
     *  many times with the parse error before throwing `InvalidFinalOutputError`.
     *  Default 0 (throw immediately). Honoured by `LLMClient.structuredComplete`. */
    repairAttempts?: number;
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
