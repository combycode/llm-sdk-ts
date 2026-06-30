/** Inline-moderation option + result shapes (parity with OpenAI's `moderation`
 *  request field, extended to work across all providers).
 *
 *  Two halves:
 *    - `ModerationRequest` — the per-call request option (ExecuteOptions.moderation).
 *    - `ModerationReport`  — what lands on `CompletionResponse.moderation`.
 *
 *  The option is REPORT-ONLY: it attaches results, it never aborts the call. To
 *  BLOCK on flagged content use `moderationGuardrail` at the agent layer.
 *
 *  Provider coverage:
 *    - OpenAI satisfies it NATIVELY (one round-trip; `mode:'native'`).
 *    - Every other provider is satisfied by EMULATION — the client runs OpenAI's
 *      moderations endpoint around the call (`mode:'emulate'`). Emulation needs an
 *      OpenAI API key (the only public moderations endpoint). */

import type { ModerationResult } from '../../helpers/moderate-types';

/** One side's outcome: a result, or an error string if moderation itself failed. */
export type ModerationEntry = ModerationResult | { error: string };

/** Streaming output-moderation strategy (emulated path only):
 *    - `buffer`   — hold chunks, moderate at each boundary, emit the result BEFORE
 *                   releasing the held chunks (flag never arrives later than the
 *                   text it refers to). Highest containment, adds latency.
 *    - `parallel` — forward chunks in real-time; moderate concurrently; surface the
 *                   result as soon as it lands. Preserves streaming; the triggering
 *                   segment is already delivered when the flag arrives.
 *    - `post`     — forward everything, moderate once after the stream ends. Pure
 *                   after-the-fact observability. */
export type ModerationStreamStrategy = 'buffer' | 'parallel' | 'post';

export interface ModerationStreamOptions {
  /** How output moderation interleaves with streamed chunks. Default 'buffer'. */
  strategy?: ModerationStreamStrategy;
  /** Characters of new output between moderation checks (also released on newline
   *  boundaries). Default 400. */
  interval?: number;
}

export interface ModerationRequest {
  /** Moderation model. Default 'omni-moderation-latest'. */
  model?: string;
  /** Moderate the request input. Default true. */
  input?: boolean;
  /** Moderate the generated output. Default true. */
  output?: boolean;
  /** Force native (OpenAI passthrough) or emulated (client-side moderations call).
   *  Default: 'native' for the OpenAI provider, 'emulate' for everyone else. */
  mode?: 'native' | 'emulate';
  /** OpenAI API key for the emulated path. Falls back to the client's own key when
   *  the client provider is OpenAI; otherwise required (emulation throws without it). */
  apiKey?: string;
  /** Streaming output-moderation controls (emulated path). */
  stream?: ModerationStreamOptions;
}

/** Moderation outcome attached to a response (`CompletionResponse.moderation`). */
export interface ModerationReport {
  /** Moderation of the request input, when requested. */
  input?: ModerationEntry;
  /** Moderation of the generated output, when requested. */
  output?: ModerationEntry;
  /** Whether the provider produced it natively or the client emulated it. */
  source: 'native' | 'emulated';
}

/** Default moderation model when none is specified. */
export const MODERATION_DEFAULT_MODEL = 'omni-moderation-latest';
/** Default streaming strategy. */
export const MODERATION_DEFAULT_STRATEGY: ModerationStreamStrategy = 'buffer';
/** Default characters between streaming moderation checks. */
export const MODERATION_DEFAULT_INTERVAL = 400;
