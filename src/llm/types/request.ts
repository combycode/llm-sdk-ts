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

/** Provider-specific request options that have no unified equivalent.
 *
 *  This was `Record<string, unknown>` — the one untyped hole in the request, and
 *  therefore the one place a typo produced silence rather than an error:
 *  `promtCacheOptions` type-checked and was simply never sent.
 *
 *  Every key below is one an adapter actually reads; the list is derived from
 *  the read sites, not invented. The index signature stays so a caller can still
 *  pass something the SDK does not know about yet — a provider ships a parameter
 *  before we model it, and refusing it would make the escape hatch useless. What
 *  changed is that the keys we DO know are checked and discoverable.
 *
 *  Keys are grouped by the provider that consumes them; sending one to a
 *  different provider is ignored, not an error. */
export interface ProviderOptions {
  // ── Anthropic ──────────────────────────────────────────────────────────
  /** Forwarded as the `anthropic-user-profile-id` header: identifies the end
   *  user a request acts on behalf of. Needs the account-level
   *  `user-profiles` beta. */
  userProfileId?: string;

  // ── OpenAI (responses + chat-completions) ──────────────────────────────
  /** Native moderation policy, sent alongside the `moderation` request field. */
  moderationPolicy?: Record<string, unknown>;
  /** `prompt_cache_options` — OpenAI-only prompt-cache controls. */
  promptCacheOptions?: Record<string, unknown>;
  /** `reasoning.mode` on the Responses API. */
  reasoningMode?: 'standard' | 'pro';

  // ── Google (generate) ──────────────────────────────────────────────────
  /** Overrides `generationConfig.responseModalities`, e.g. for image or audio
   *  generation. Wins over the modality implied by `outputModalities`. */
  responseModalities?: string[];
  /** `generationConfig.speechConfig` — voice selection for audio output. */
  speechConfig?: Record<string, unknown>;
  /** `generationConfig.imageConfig` — aspect ratio / size for image output. */
  imageConfig?: Record<string, unknown>;
  /** `generationConfig.translationConfig`. */
  translationConfig?: Record<string, unknown>;
  /** Name of a cached-content handle to reuse. Forwarded only when it is a
   *  non-empty string. */
  cachedContent?: string;

  // ── OpenRouter ─────────────────────────────────────────────────────────
  /** Routing options merged into the request body (provider order, transforms,
   *  and the rest of OpenRouter's routing surface). */
  openrouter?: Record<string, unknown>;

  /** Anything the SDK does not model yet. Adapters ignore what they do not read. */
  [key: string]: unknown;
}

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
  /** Restrict sampling to the k most likely tokens. Emitted only where the wire accepts it
   *  (live-verified 2026-07-28): Google generateContent AND Interactions, xAI chat, OpenRouter
   *  chat. OpenAI has no top-k on either surface, so it is dropped there rather than sent and
   *  rejected.
   *
   *  Anthropic is per VERSION, not per provider: `messages@4.1` through `@4.6` accept `top_k`;
   *  models from `@4.7` reject it with a 400, so the spec removes it there. The pin decides,
   *  which means an adapter driven without a catalog falls back to the newest spec and drops
   *  `top_k` even for a model that would have taken it. */
  topK?: number;
  /** Best-effort deterministic sampling. Emitted only where the wire accepts it
   *  (live-verified 2026-07-28): OpenAI **chat-completions** — the Responses API rejects it
   *  (400 "Unknown parameter: 'seed'") — Google generateContent + Interactions, xAI chat AND
   *  responses, OpenRouter chat. Anthropic has no seed (400 "Extra inputs are not permitted"),
   *  so it is dropped there. */
  seed?: number;
  /** Penalise tokens by prior presence (OpenAI/xAI chat-completions, OpenRouter, Google). */
  presencePenalty?: number;
  /** Penalise tokens by prior frequency (OpenAI/xAI chat-completions, OpenRouter, Google). */
  frequencyPenalty?: number;
  stop?: string[];

  // Tools
  tools?: Tool[];
  toolChoice?: ToolChoice;

  // Structured output
  structured?: {
    schema: Record<string, unknown>;
    name?: string;
    strict?: boolean;
    /** Opt-in repair-retry count for `structuredComplete` (default 0). */
    repairAttempts?: number;
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

  // Provider-specific passthrough — see ProviderOptions.
  providerOptions?: ProviderOptions;
  /** Which wire spec builds this request, from the catalog's `ModelInfo.wireSpec`
   *  and resolved by `LLMClient`. Absent when the engine runs without a catalog or
   *  the model is not catalogued, in which case the adapter derives the spec from
   *  the model id — the same fallback `wire` has. */
  wireSpec?: string;

  // Audio output controls + requested modalities (default ['text']).
  audio?: AudioOptions;
  outputModalities?: Array<'text' | 'audio'>;

  // Responses-API chain continuation
  previousResponseId?: string;

  // Request lifecycle
  timeout?: number;
  signal?: AbortSignal;
}

/** OpenAI Responses-only: which of the model's prior-turn reasoning items are
 *  rendered back to it on later turns of a stateful conversation (chained via
 *  `previousResponseId` / server-state). `all_turns` keeps continuity at higher
 *  token cost; `current_turn` drops earlier reasoning; `auto` lets OpenAI decide.
 *  Omitted, the model picks: the gpt-5.6 family defaults to `all_turns`, earlier
 *  models to `current_turn`. Ignored by every other provider. */
export type ReasoningContext = 'auto' | 'current_turn' | 'all_turns';

/** How much of the model's reasoning is returned. `full` (default) returns it as
 *  fully as the provider allows; `summary` a condensed form where the provider
 *  supports one (else full); `hidden` keeps reasoning internal. Best-effort per
 *  provider — Anthropic `enabled.display`, OpenAI Responses `summary`, Google
 *  `includeThoughts`; providers without a control ignore it. */
export type ThinkingVisibility = 'full' | 'summary' | 'hidden';

export type ThinkingConfig =
  | {
      mode: 'auto';
      effort?: 'low' | 'medium' | 'high' | 'max';
      visibility?: ThinkingVisibility;
      context?: ReasoningContext;
    }
  | {
      mode: 'on';
      effort?: 'low' | 'medium' | 'high' | 'max';
      visibility?: ThinkingVisibility;
      context?: ReasoningContext;
    }
  | { mode: 'off' };

export type CacheConfig =
  | 'auto'
  | 'off'
  | {
      system?: boolean;
      tools?: boolean;
      ttl?: string;
    };
