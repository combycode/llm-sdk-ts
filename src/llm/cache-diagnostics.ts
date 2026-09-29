/** Prompt-cache diagnostics, unified across the two providers that report them.
 *
 *  Both answer the same question -- "why did the cache not reuse the prefix of
 *  the request I named?" -- and neither answers it in the same shape. Every
 *  mapping below was MEASURED on 2026-09-29 (claude-haiku-4-5 on the GA
 *  `/v1/messages` with no beta header, gpt-5.6-luna on `/v1/responses`) with a
 *  prompt large enough to actually be cached, because a short one produces
 *  nothing to diagnose on either side and reads as a broken feature.
 *
 *  | | Anthropic | OpenAI |
 *  |---|---|---|
 *  | hit | `diagnostics: null` | `{type:'cache_hit'}` |
 *  | miss | `{cache_miss_reason:{type:'system_changed',cache_missed_input_tokens:9197}}` | `{type:'cache_miss',reason:'input_changed',cache_missed_tokens:10052,comparison_reusable_tokens:10052}` |
 *  | unknown id | `{cache_miss_reason:{type:'previous_message_not_found'}}`, HTTP 200 | `{type:'comparison_response_not_found'}`, HTTP 200 |
 *  | nothing to say | `diagnostics: null` | `{type:'unavailable'}` |
 *
 *  **Anthropic has no hit signal, and that is the load-bearing fact.** A request
 *  whose prefix WAS reused returns exactly the body an undiagnosed request
 *  returns. Its SDK calls that null "diagnosis still pending"; the measurement
 *  says it is also what a hit looks like. So nothing here turns an Anthropic
 *  null into `status: 'hit'` -- that would publish our inference as the
 *  provider's answer. `usage.cachedTokens` is what says whether the cache was
 *  used; this says why it was not, when the provider chose to say.
 */

import type { CacheDiagnostics } from './types/response';

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const withNum = (key: 'missedTokens' | 'reusableTokens', v: unknown) =>
  num(v) === undefined ? {} : { [key]: num(v) };

/** `Message.diagnostics` on Anthropic messages. Undefined when the provider said
 *  nothing -- which covers both "not requested" and "the prefix matched". */
export function anthropicCacheDiagnostics(value: unknown): CacheDiagnostics | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const miss = (value as { cache_miss_reason?: unknown }).cache_miss_reason;
  if (!miss || typeof miss !== 'object') return undefined;
  const type = (miss as { type?: unknown }).type;
  if (type === 'unavailable') return { status: 'unavailable', raw: value };
  if (type === 'previous_message_not_found') return { status: 'comparison_not_found', raw: value };
  return {
    status: 'miss',
    // The block that diverged rides through under its own name. Anthropic's
    // vocabulary is NOT translated into OpenAI's: `system_changed` and
    // `input_changed` are not the same claim, and picking one for the other
    // would be a guess dressed as a unification.
    ...(typeof type === 'string' ? { reason: type } : {}),
    ...withNum('missedTokens', (miss as { cache_missed_input_tokens?: unknown }).cache_missed_input_tokens),
    raw: value,
  };
}

/** `response.prompt_cache_diagnostics` on OpenAI Responses. */
export function openaiCacheDiagnostics(value: unknown): CacheDiagnostics | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const d = value as {
    type?: unknown;
    reason?: unknown;
    cache_missed_tokens?: unknown;
    comparison_reusable_tokens?: unknown;
  };
  if (typeof d.type !== 'string') return undefined;
  // Unmapped values pass through unchanged rather than collapsing to a
  // neighbour: `status` is an open union (R1) and OpenAI has grown this enum
  // twice already.
  const status =
    d.type === 'cache_hit'
      ? 'hit'
      : d.type === 'cache_miss'
        ? 'miss'
        : d.type === 'comparison_response_not_found'
          ? 'comparison_not_found'
          : d.type;
  return {
    status,
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...withNum('missedTokens', d.cache_missed_tokens),
    ...withNum('reusableTokens', d.comparison_reusable_tokens),
    raw: value,
  };
}
