/** Our effort vocabulary, in OpenAI's.
 *
 *  This map exists in two places: here, for the `configuration_update` input item
 *  that the adapter builds in TypeScript, and as the `reasoningEffort` table in
 *  `wire/specs/openai-responses.json`, for the top-level `reasoning.effort` field
 *  the spec interpreter builds. They MUST agree — an effort that means one thing
 *  on a request and another on a stored configuration update is a bug nobody
 *  would look for — and `tests/unit/llm/configuration-update.test.ts` asserts the
 *  two are identical rather than trusting that a later edit touches both.
 *
 *  `max` is MAPPED, not sent. It means "the most this model will do", and the
 *  model-specific truth is that OpenAI's ladder tops out at `xhigh`; sending the
 *  word itself was measured as a 400 on `gpt-5.4-nano` ("Unsupported value: 'max'
 *  is not supported"). The `configuration_update` validator does list `max` among
 *  its accepted values on `gpt-5.6-*`, so passing it through would also work
 *  there — but then `max` would mean the top rung on a request and something
 *  OpenAI defines on an update, in the same conversation. One meaning is worth
 *  more than one fewer line of mapping.
 *
 *  `none` and `minimal` pass through: they exist in OpenAI's vocabulary and not
 *  in ours, and the only reason they are nameable at all is that
 *  `ConfigurationEffort` admits them (see its doc comment for why they are not in
 *  the unified ladder yet). */

import type { ConfigurationEffort } from '../../types/messages';

/** Our name -> theirs. Keys we do not list are passed through unchanged. */
export const OPENAI_REASONING_EFFORT: Readonly<Record<string, string>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'xhigh',
  xhigh: 'xhigh',
};

export function toOpenAIReasoningEffort(effort: ConfigurationEffort): string {
  return OPENAI_REASONING_EFFORT[effort] ?? effort;
}
