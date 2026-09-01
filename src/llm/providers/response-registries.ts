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
import { ANTHROPIC_STREAM_REGISTRY } from './anthropic/stream-registry';
import { GOOGLE_INTERACTIONS_REGISTRY } from './google/interactions-registry';
import { GOOGLE_INTERACTIONS_STREAM_REGISTRY } from './google/interactions-stream-registry';
import { GOOGLE_RESPONSE_REGISTRY } from './google/response-registry';
import { GOOGLE_STREAM_REGISTRY } from './google/stream-registry';
import { OPENAI_RESPONSE_REGISTRY } from './openai/response-registry';
import { OPENAI_STREAM_REGISTRY } from './openai/stream-registry';
import { OPENAI_RESPONSES_REGISTRY } from './openai/responses-registry';
import { OPENAI_RESPONSES_STREAM_REGISTRY } from './openai/responses-stream-registry';
import { OPENROUTER_RESPONSE_REGISTRY } from './openrouter/response-registry';
import { OPENROUTER_STREAM_REGISTRY } from './openrouter/stream-registry';
import { XAI_RESPONSES_REGISTRY } from './xai/responses-registry';
import { XAI_STREAM_REGISTRY } from './xai/stream-registry';
import type { Registry } from '../../wire/interpreter';

export const RESPONSE_REGISTRIES: Record<string, Registry> = {
  'anthropic/messages.response': ANTHROPIC_RESPONSE_REGISTRY,
  'anthropic/messages.stream': ANTHROPIC_STREAM_REGISTRY,
  'google/generate.response': GOOGLE_RESPONSE_REGISTRY,
  'google/generate.stream': GOOGLE_STREAM_REGISTRY,
  'google/interactions.response': GOOGLE_INTERACTIONS_REGISTRY,
  'google/interactions.stream': GOOGLE_INTERACTIONS_STREAM_REGISTRY,
  'openai/completions.response': OPENAI_RESPONSE_REGISTRY,
  'openai/completions.stream': OPENAI_STREAM_REGISTRY,
  'openai/responses.response': OPENAI_RESPONSES_REGISTRY,
  'openai/responses.stream': OPENAI_RESPONSES_STREAM_REGISTRY,
  'openrouter/completions.response': OPENROUTER_RESPONSE_REGISTRY,
  'openrouter/completions.stream': OPENROUTER_STREAM_REGISTRY,
  // xAI subclasses OpenAI's Responses adapter but DOES extend file extraction.
  'xai/responses.response': XAI_RESPONSES_REGISTRY,
  'xai/responses.stream': XAI_STREAM_REGISTRY,
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
