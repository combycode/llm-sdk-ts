/** Universal message and content types — shared by LLM, Agent, Server. */

import type { ProviderName } from './provider';
// Type-only, and so erased: `request.ts` imports this file back, and a value
// import either way round would be a real cycle.
import type { ThinkingEffort } from './request';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** Producer-bound provenance for an assistant turn.
 *
 *  History is portable across providers, but some state is only valid for the
 *  provider that produced it: a server-side conversation id (interaction_id /
 *  response_id) and opaque signatures (Gemini thought-signatures, reasoning
 *  blobs). Anything here MUST be ignored by a different provider — adapters
 *  consume it only when `origin.provider === self`. */
export interface MessageOrigin {
  /** Provider that produced this assistant turn. The gate for cross-provider use. */
  provider: ProviderName;
  /** Model that produced it (for model-bound server-state checks). */
  model?: string;
  /** Server-side conversation id for stateful continuation (interaction_id / response_id). */
  serverStateId?: string;
  /** Opaque provider signatures to echo back (thought-signature, encrypted reasoning). */
  signatures?: unknown;
}

export type ContentPart =
  | TextPart
  | ImagePart
  | DocumentPart
  | AudioPart
  | VideoPart
  | ToolCallPart
  | ToolResultPart
  | ProgramCallPart
  | ProgramResultPart
  | ConfigurationUpdatePart
  | ImageOutputPart
  | AudioOutputPart
  | VideoOutputPart;

/** Whether a piece of assistant text is the ANSWER or narration on the way to it.
 *
 *  `commentary` is the model thinking out loud for the user's benefit — distinct from reasoning,
 *  which is its own part. `final_answer` is the response proper. Codex-family models emit both, and
 *  without the distinction an agent loop treats narration as the result.
 *
 *  Open union (CONSTITUTION.md R1): a provider adding a third phase must not break consumers, so
 *  write a `default` branch. */
export type AssistantPhase = 'commentary' | 'final_answer' | (string & {});

export interface TextPart {
  type: 'text';
  text: string;
  cache?: boolean;
  /** Set only by providers that report it (OpenAI Responses, `gpt-5.3-codex` and later). Absent
   *  everywhere else, which reads exactly as it did before: treat the text as the answer. */
  phase?: AssistantPhase;
}

/** Provider-specific knobs for ONE image, as opposed to the whole request.
 *
 *  Flat and grouped by comment, the same shape as the request-level
 *  `ProviderOptions`: a key a provider does not read is ignored, not an error.
 *  Per-part rather than shared because the question it answers is about this
 *  image -- one oversized screenshot in a conversation should not change how
 *  every other image is handled. */
export interface ImagePartProviderOptions {
  // ── Anthropic ──────────────────────────────────────────────────────────
  /** What the server does to this image before the model sees it.
   *
   *  `oversized_image` is the one that matters: the default `'downsize'`
   *  scales an over-large image to fit and does not say so, so the model
   *  observes dimensions you did not choose and nothing in the response tells
   *  you. `'error'` refuses instead, with a 400 naming the image's dimensions
   *  and the largest that would fit -- which is what you want when the detail
   *  being scaled away is the point of sending the image. */
  transformations?: { oversized_image?: 'downsize' | 'error' };
  /** Forward-compat: any other per-image field a provider accepts. */
  [key: string]: unknown;
}

export interface ImagePart {
  type: 'image';
  source: DataSource;
  detail?: 'auto' | 'low' | 'high';
  /** Provider-specific handling for THIS image. */
  providerOptions?: ImagePartProviderOptions;
}

export interface DocumentPart {
  type: 'document';
  source: DataSource;
  citations?: boolean;
}

export interface AudioPart {
  type: 'audio';
  source: DataSource;
}

/** Provider-specific knobs for ONE video. Same shape and reasoning as
 *  `ImagePartProviderOptions`: flat, grouped by comment, ignored by a provider
 *  that does not read the key. */
export interface VideoPartProviderOptions {
  // ── Google ─────────────────────────────────────────────────────────────
  /** How the model works through this video.
   *
   *  - `'agentic'` — the model navigates the video itself, seeking to what it
   *    needs. Google recommends it for most cases.
   *  - `'static'` — a fixed frame rate, every extracted frame placed in the
   *    context window. Predictable, and predictably expensive on a long video.
   *
   *  The object form is `'static'` with the sampling spelled out, which is the
   *  form worth reaching for: `fps` trades detail against tokens, and the
   *  offsets let a question about 30 seconds of a two-hour recording cost what
   *  30 seconds should.
   *
   *  Offsets are seconds with an `s` suffix, as Google writes them —
   *  `'10.5s'`, `'30s'`. */
  processing?: VideoProcessing;
  /** Interactions only: a label for this video, echoed back so a turn that
   *  carries several can be told apart. */
  name?: string;
  /** Forward-compat: any other per-video field a provider accepts. */
  [key: string]: unknown;
}

/** `'agentic'`, `'static'`, or `'static'` with its sampling described. */
export type VideoProcessing =
  | 'static'
  | 'agentic'
  | {
      type: 'static';
      /** Frames sampled per second. */
      fps?: number;
      /** Where to start, e.g. `'10.5s'`. Non-negative. */
      startOffset?: string;
      /** Where to stop, e.g. `'30s'`. Must be greater than `startOffset`. */
      endOffset?: string;
    };

export interface VideoPart {
  type: 'video';
  source: DataSource;
  /** Provider-specific handling for THIS video. */
  providerOptions?: VideoPartProviderOptions;
}

/** Who invoked a tool: the model itself, or code the model wrote.
 *
 *  Open union (CONSTITUTION.md R1) — the provider enumerates the values it knows
 *  (`direct` and `program` today) and may add more, so write a `default` branch. */
export type ToolCallerType = 'direct' | 'program' | (string & {});

/** The execution context that invoked a tool.
 *
 *  A single shape with an optional payload rather than
 *  `{type:'direct'} | {type:'program', callerId}` (R2): a new caller kind with its own
 *  fields then extends this instead of widening a union every consumer switches on. */
export interface ToolCaller {
  type: ToolCallerType;
  /** The id of the {@link ProgramCallPart} that made this call. Present when
   *  `type === 'program'`. */
  callerId?: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Who invoked this tool. Absent means the ordinary case — the model called it
   *  directly — so existing consumers read exactly as before. */
  caller?: ToolCaller;
  /** Provider-specific metadata (e.g. Google thought signatures). */
  _meta?: Record<string, unknown>;
  /** The model asked for this tool but its arguments did not parse — a stream
   *  truncated mid-JSON is the usual cause. Absent in the ordinary case, so
   *  existing consumers read exactly as before.
   *
   *  A call marked this way is NEVER executed. `arguments` is left empty because
   *  nothing could be recovered from it, and an empty object is indistinguishable
   *  from a deliberate no-argument call — which is precisely how a truncated
   *  `delete_files({"path": "/et` once became `delete_files({})`. */
  malformed?: true;
}

export interface ToolResultPart {
  type: 'tool_result';
  id: string;
  content: string | ContentPart[];
  isError?: boolean;
  /** The namespace of the tool that produced this result, when the provider tracks one (OpenAI
   *  Responses). Round-tripped so a namespaced tool's output is attributable on the next turn; the
   *  tool NAME is derived from the matching call rather than stored twice. */
  namespace?: string;
  /** Who invoked the call this result answers. Mirrors {@link ToolCallPart.caller}. */
  caller?: ToolCaller;
}

/** Code the model wrote to orchestrate tool calls itself, instead of emitting them
 *  one at a time and waiting for each result (OpenAI Responses "programmatic tool
 *  calling", `gpt-5.6` family).
 *
 *  The program runs on the provider's side and suspends at every `await`, so its
 *  tool calls still arrive as ordinary {@link ToolCallPart}s — each tagged with a
 *  `caller` pointing back at this part's `id`. When the program finishes, a
 *  {@link ProgramResultPart} carries what it returned.
 *
 *  **This part must be preserved in history and sent back.** Dropping it does not
 *  merely lose an audit trail: the model re-emits the program and runs it again
 *  from the start (verified 2026-08-09). */
export interface ProgramCallPart {
  type: 'program_call';
  /** Call id shared with the matching {@link ProgramResultPart} and referenced by
   *  `ToolCaller.callerId` on every tool call the program made. */
  id: string;
  /** The source the model wrote — JavaScript for OpenAI. Readable, and worth showing
   *  to a user: it is the plan the model is executing. */
  code: string;
  /** Opaque provider token that must be round-tripped verbatim. */
  fingerprint: string;
  /** Provider-specific metadata: the raw item id, and the provider items this one is
   *  bound to (OpenAI rejects the program without its reasoning item). Echoed back
   *  by the adapter that produced it and ignored by every other provider. */
  _meta?: Record<string, unknown>;
}

/** What a {@link ProgramCallPart} returned once it ran to completion. */
export interface ProgramResultPart {
  type: 'program_result';
  /** Matches the {@link ProgramCallPart} `id`. */
  id: string;
  /** The program's return value, as the provider serialised it. */
  result: string;
  /** Terminal state. Open union (R1): `incomplete` means the program stopped early —
   *  hitting a step limit or throwing — so the result is partial. */
  status?: 'completed' | 'incomplete' | (string & {});
  /** Provider-specific metadata: the raw item id, which OpenAI requires when this item
   *  is sent back as history ("Missing required parameter: 'input[n].id'"). */
  _meta?: Record<string, unknown>;
}

/** How hard to think, for a {@link ConfigurationUpdatePart}.
 *
 *  A superset of the unified `ThinkingEffort`: OpenAI's stored-configuration item
 *  also takes `none` and `minimal`, and `none` is the rung that PROVES the item
 *  works -- measured 2026-10-01, an update to `none` drove the next turn's
 *  reasoning tokens to a flat 0 three runs out of three where the default sits
 *  near 170. A part that could not say it would ship the feature without its
 *  clearest use.
 *
 *  They are not in the unified ladder because putting them there means measuring
 *  every provider's behaviour for both values first (Anthropic, Google and xAI all
 *  map effort through their own tables, and xAI is already known to split --
 *  grok-4.5/4.6/4.7 refuse `none`, 4.3 accepts it). When that is done this union
 *  collapses into `ThinkingEffort` with no break for anyone.
 *
 *  `minimal` is model-dependent even within OpenAI: `gpt-5.6-luna` takes it,
 *  `gpt-5.6-sol` answers 400 naming the values it does take. That is the honest
 *  outcome -- better than being quietly served a different amount of thinking. */
export type ConfigurationEffort = ThinkingEffort | 'none' | 'minimal';

/** A change to the configuration a STORED conversation runs under, from this point
 *  on. OpenAI Responses only (`gpt-5.6-sol`, `gpt-5.6-luna` as of 2026-10-01; every
 *  other model answers 400 `The 'configuration_update' item type is not supported
 *  with this model`).
 *
 *  Why this exists when `thinking.effort` already does: the top-level option
 *  applies to ITS request and nothing else. Measured 2026-10-01 on
 *  `gpt-5.6-luna`, three runs per arm, by setting effort in turn 1 and naming
 *  nothing in turn 2:
 *
 *    via this item          turn 2 reasoning tokens 0, 0, 0
 *    via `thinking.effort`  turn 2 reasoning tokens 244, 189, 172
 *    nothing at all         turn 2 reasoning tokens 155, 129, 198
 *
 *  So the option does not persist and the item does. There is no other way to say
 *  "think less from here on" to a conversation the server is holding.
 *
 *  The part is emitted as its own top-level input item, BEFORE the message it
 *  travels with: the API applies it to subsequent responses, so an update placed
 *  after the message it was meant to govern governs the next one instead. */
export interface ConfigurationUpdatePart {
  type: 'configuration_update';
  /** Required, and so is `effort` -- the API refuses both omissions by name
   *  (`Missing required parameter: 'input[0].reasoning'`, then
   *  `...'input[0].reasoning.effort'`) and refuses `effort: null` as a type error.
   *  The official SDK types all three as optional/nullable; measured 2026-10-01,
   *  none of them is. */
  reasoning: { effort: ConfigurationEffort };
  /** The provider's id for the stored item (`cnfu_…`), when this part came back
   *  from a conversation rather than being written by the caller. Never sent. */
  id?: string;
}

// ─── Media Output Parts (generated by models) ───────────────────────────────

export interface ImageOutputPart {
  type: 'image_output';
  mediaId: string;
  mimeType: string;
  revisedPrompt?: string;
  width?: number;
  height?: number;
  /** Transient: raw base64 from provider. Stripped after storage. */
  _data?: string;
}

export interface AudioOutputPart {
  type: 'audio_output';
  mediaId: string;
  mimeType: string;
  durationMs?: number;
  sampleRate?: number;
  _data?: string;
}

export interface VideoOutputPart {
  type: 'video_output';
  mediaId: string;
  mimeType: string;
  durationMs?: number;
  width?: number;
  height?: number;
  _data?: string;
}

export type MediaOutputPart = ImageOutputPart | AudioOutputPart | VideoOutputPart;

// ─── Data sources ──────────────────────────────────────────────────────────

export type DataSource =
  | { type: 'base64'; mimeType: string; data: string }
  | { type: 'url'; url: string }
  | { type: 'file'; fileId: string }
  | { type: 'path'; mimeType: string; path: string }
  | { type: 'buffer'; mimeType: string; data: Uint8Array }
  | { type: 'provider_ref'; mimeType: string; refId: string };

export type Content = string | ContentPart[];

export interface Message {
  role: Role;
  content: Content;
  cache?: boolean;
  /** Universal message id (ours) — for dedup / referencing / editing. */
  id?: string;
  /** Creation timestamp (ms epoch) — universal; drives server-state TTL checks. */
  createdAt?: number;
  /** Producer-bound provenance (assistant turns). See {@link MessageOrigin}. */
  origin?: MessageOrigin;
}

/** Normalize any content to ContentPart array. */
export function contentParts(content: Content): ContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content;
}

/** Extract plain text from content. */
export function contentText(content: Content): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** The assistant's ANSWER, with commentary removed.
 *
 *  Codex-family models narrate before answering and mark the narration `phase: 'commentary'`.
 *  Concatenating everything makes an agent's final output include its own thinking-out-loud.
 *
 *  Excludes only what is explicitly `'commentary'` rather than keeping only `'final_answer'`: the
 *  phase vocabulary is open (R1), and a phase we do not recognise yet must never cause us to drop
 *  the answer. Text with no phase at all — every other model — is returned unchanged, so this is
 *  identical to `contentText` outside the codex family. */
export function finalAnswerText(content: Content): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is TextPart => p.type === 'text' && p.phase !== 'commentary')
    .map((p) => p.text)
    .join('');
}
