/** Internal normalized request — what LLMClient hands to ProviderAdapter.
 *
 *  In v2, the public surface is `client.complete(input, options?)` — model
 *  and system are fixed at construction. The LLMClient internally builds
 *  this `NormalizedRequest` from (input, options, this.model, this.system). */

import type { ModerationRequest } from '../moderation/types';
import type { AudioOptions } from './audio';
import type { Message } from './messages';
import type { CacheDiagnosticsRequest } from './options';
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
/** OpenAI `prompt_cache_options` (gpt-5.6+). Typed for editor help; forwarded
 *  verbatim, so a field OpenAI adds tomorrow still works today. */
export interface PromptCacheOptions {
  /** Prepare the cache WITHOUT generating anything. Overrides `generate` to
   *  false, so the response comes back complete with an empty output — which
   *  this library reports as an ordinary empty result (`finishReason: 'stop'`,
   *  no content), not a failure.
   *
   *  Measured 2026-09-30 on `gpt-5.6-terra`: a prewarm call returned 0 output
   *  items and 0 cached tokens, and the next call on the same 4177-token
   *  prompt read 4174 of them from cache. The prompt carried a per-run nonce,
   *  so that hit can only have come from the prewarm. */
  prewarm?: boolean;
  /** `implicit` (default) lets OpenAI add one breakpoint of its own; with
   *  `explicit` it adds none, so a request with no explicit breakpoint does
   *  not use prompt caching at all. */
  mode?: 'implicit' | 'explicit';
  /** Minimum lifetime for every breakpoint this request writes. `30m` is the
   *  only value OpenAI accepts *currently* -- their word -- so the union stays
   *  open rather than rejecting the next one they add. It may retain entries
   *  longer than asked. */
  ttl?: '30m' | (string & {});
  /** A previous response id to compare against, which asks for cache
   *  diagnostics — see `response.cacheDiagnostics`. */
  comparison_response_id?: string;
  /** Forward-compat: any other field OpenAI accepts is passed through. */
  [key: string]: unknown;
}

export interface ProviderOptions {
  // ── Anthropic ──────────────────────────────────────────────────────────
  /** Forwarded as the `anthropic-user-profile-id` header: identifies the end
   *  user a request acts on behalf of. Needs the account-level
   *  `user-profiles` beta. */
  userProfileId?: string;
  /** Forwarded as the `anthropic-workspace-id` header, e.g.
   *  `wrkspc_011CZkZaBF1tNoB5wlCeusgy`.
   *
   *  Only needed for a credential that can act on more than one Workspace; one
   *  that belongs to a single Workspace may omit it, and if sent it must match.
   *  Workspace is where spend, rate limits and retention are accounted, so a
   *  multi-workspace key that omits it does not fail -- it charges the wrong
   *  place, quietly.
   *
   *  This is the per-request way, and the one `createLLM` callers use. The
   *  other Anthropic surfaces -- files, batches, token counting, model listing
   *  -- take a `workspaceId` on their own config instead, because they are not
   *  completions and have no `providerOptions`. An `AnthropicAdapter`
   *  constructed directly also takes one, and this option overrides it. */
  workspaceId?: string;

  // ── OpenAI (responses + chat-completions) ──────────────────────────────
  /** Native moderation policy, sent alongside the `moderation` request field. */
  moderationPolicy?: Record<string, unknown>;
  /** `prompt_cache_options` — OpenAI-only prompt-cache controls, gpt-5.6+.
   *
   *  Measured 2026-09-30: the whole object is refused on an older model with
   *  `400 prompt_cache_options is not supported on this model`, so this is not
   *  a knob to set globally and forget. */
  promptCacheOptions?: PromptCacheOptions;
  /** `reasoning.mode` on the Responses API. */
  reasoningMode?: 'standard' | 'pro';

  // ── Google (generate) ──────────────────────────────────────────────────
  /** `generationConfig.audioTranscriptionConfig`. Set `transcribe({ mode })`
   *  rather than this directly; it is here because the transcribe helper is
   *  built on an ordinary completion. */
  audioTranscriptionConfig?: { mode?: 'VERBATIM' | 'SMART'; [key: string]: unknown };

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

  /** Ask why the prompt cache missed, against a named earlier response.
   *  Anthropic and OpenAI only; see CacheDiagnosticsRequest. */
  cacheDiagnostics?: CacheDiagnosticsRequest;

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

/** How hard to think, in one vocabulary across providers.
 *
 *  `max` means "the most this model will do" and is MAPPED per provider, not sent:
 *  Google's ladder tops out at `high`, OpenAI's and xAI's at `xhigh`. It used to
 *  be passed through raw on the OpenAI and xAI Responses surfaces, where it is not
 *  a value at all -- measured 2026-09-30, both answer 400 to `effort: "max"`, and
 *  OpenAI says so in as many words ("Unsupported value: 'max' is not supported
 *  with the 'gpt-5.4-nano' model"). So the value our own type and docs offered was
 *  a guaranteed failure on two providers.
 *
 *  `xhigh` is nameable directly for the caller who wants that specific rung rather
 *  than "whatever the maximum is". A model that does not take it answers 400
 *  naming the value, which is the same honest outcome an access-controlled service
 *  tier gets -- better than being quietly served a different amount of thinking
 *  than was asked for. */
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max' | 'xhigh';

export type ThinkingConfig =
  | {
      mode: 'auto';
      effort?: ThinkingEffort;
      visibility?: ThinkingVisibility;
      context?: ReasoningContext;
    }
  | {
      mode: 'on';
      effort?: ThinkingEffort;
      visibility?: ThinkingVisibility;
      context?: ReasoningContext;
    }
  | {
      /** Reason only BETWEEN tool calls, not before the first answer.
       *
       *  Anthropic-only and MODEL-GATED: measured 2026-09-29 across every active
       *  Anthropic chat model, exactly one accepts it -- `claude-sonnet-5.5` --
       *  and the other twelve answer `400 "thinking.type.between_tools" is not
       *  supported for this model`, including `claude-opus-5.5`. A deliberately
       *  invalid type is refused everywhere, so the field is read rather than
       *  tolerated.
       *
       *  Asking for it on a model the catalog does not record as accepting it is
       *  DOWNGRADED to that model's ordinary reasoning and reported as
       *  `request_adjusted` -- the same thing Anthropic's own fallback
       *  middleware does when it hops to a model that may not take it. Providers
       *  other than Anthropic ignore it, as they ignore every mode they have no
       *  field for. */
      mode: 'between_tools';
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
