/** Internal normalized request — what LLMClient hands to ProviderAdapter.
 *
 *  In v2, the public surface is `client.complete(input, options?)` — model
 *  and system are fixed at construction. The LLMClient internally builds
 *  this `NormalizedRequest` from (input, options, this.model, this.system). */

import type { ModerationRequest } from '../moderation/types';
import type { AudioOptions } from './audio';
import type { Message } from './messages';
import type { ServiceTier } from './tiers';
import type { Tool, ToolChoice } from './tools';

export interface NormalizedRequest {
  /** From LLMClientConfig.model — fixed at construction. */
  model: string;
  /** Resolved messages array (input normalized + agent history if applicable). */
  messages: Message[];
  /** From LLMClientConfig.system or per-call override (rare). */
  system?: string;

  // Generation control
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];

  // Tools
  tools?: Tool[];
  toolChoice?: ToolChoice;

  // Structured output
  structured?: {
    schema: Record<string, unknown>;
    name?: string;
    strict?: boolean;
  };

  // Thinking / reasoning
  thinking?: ThinkingConfig;

  // Cache control
  cache?: CacheConfig;

  // Service tier (synchronous tiers; batch is the separate Batch API). The
  // adapter maps this to the provider's own param.
  serviceTier?: ServiceTier;

  // Inline moderation (report-only). OpenAI maps it to a native `moderation`
  // request field; other providers are emulated client-side. See ModerationRequest.
  moderation?: ModerationRequest;

  // Provider-specific passthrough
  providerOptions?: Record<string, unknown>;

  // Audio output controls + requested modalities (default ['text']).
  audio?: AudioOptions;
  outputModalities?: Array<'text' | 'audio'>;

  // Responses-API chain continuation
  previousResponseId?: string;

  // Request lifecycle
  timeout?: number;
  signal?: AbortSignal;
}

export type ThinkingConfig =
  | { mode: 'auto'; effort?: 'low' | 'medium' | 'high' | 'max' }
  | { mode: 'on'; effort?: 'low' | 'medium' | 'high' | 'max' }
  | { mode: 'off' };

export type CacheConfig =
  | 'auto'
  | 'off'
  | {
      system?: boolean;
      tools?: boolean;
      ttl?: string;
    };
