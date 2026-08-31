/** Response spec id -> the registry supplying the names that spec calls.
 *
 *  A response spec expresses shape; the handful of things that are not shape
 *  reach code through `$call`, `pred` and `effect` names. Those names resolve
 *  per PROVIDER, not globally: `anthropicFinish` means nothing to an OpenAI
 *  spec, and putting them all in one bag would let a spec silently call another
 *  provider's helper.
 *
 *  This map is what makes a response spec usable, and it is also what the
 *  architecture test resolves names against — so a spec whose registry is
 *  missing from here is a failing test, not a runtime surprise.
 */
import { ANTHROPIC_RESPONSE_REGISTRY } from './anthropic/response-registry';
import { GOOGLE_INTERACTIONS_REGISTRY } from './google/interactions-registry';
import { GOOGLE_RESPONSE_REGISTRY } from './google/response-registry';
import { OPENAI_RESPONSE_REGISTRY } from './openai/response-registry';
import { OPENAI_RESPONSES_REGISTRY } from './openai/responses-registry';
import { OPENROUTER_RESPONSE_REGISTRY } from './openrouter/response-registry';
import type { Registry } from '../../wire/interpreter';

export const RESPONSE_REGISTRIES: Record<string, Registry> = {
  'anthropic/messages.response': ANTHROPIC_RESPONSE_REGISTRY,
  'google/generate.response': GOOGLE_RESPONSE_REGISTRY,
  'google/interactions.response': GOOGLE_INTERACTIONS_REGISTRY,
  'openai/completions.response': OPENAI_RESPONSE_REGISTRY,
  'openai/responses.response': OPENAI_RESPONSES_REGISTRY,
  'openrouter/completions.response': OPENROUTER_RESPONSE_REGISTRY,
  // xAI's Responses adapter subclasses OpenAI's and overrides no parsing.
  'xai/responses.response': OPENAI_RESPONSES_REGISTRY,
};

/** Every name any response registry supplies. For checks that only ask "does
 *  this resolve anywhere", never for dispatch. */
export function allResponseNames(): Set<string> {
  const out = new Set<string>();
  for (const reg of Object.values(RESPONSE_REGISTRIES)) {
    for (const bag of [reg.transforms, reg.builders, reg.predicates, reg.effects]) {
      for (const k of Object.keys(bag)) out.add(k);
    }
  }
  return out;
}
