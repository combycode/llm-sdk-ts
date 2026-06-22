/** Server-state decision — the unified "send id vs resend history" brain.
 *
 *  Several providers keep conversation state server-side (OpenAI Responses
 *  `previous_response_id`, xAI, Google Interactions `previous_interaction_id`).
 *  When the prior assistant turn carries a server id we produced, we can send
 *  just that id + the new turn instead of the whole transcript.
 *
 *  Safe by default — reuse only when ALL hold:
 *    - the caller didn't opt out (`stateful !== false`),
 *    - the prior id was produced by the SAME provider (cross-provider ids are
 *      meaningless elsewhere — history stays portable),
 *    - the provider/model supports it (catalog),
 *    - it's within the retention TTL (catalog duration),
 *    - the model matches, OR the provider is not model-bound (catalog).
 *  Otherwise we fall back to resending full history (always correct). */

import type { ModelCatalog } from '../plugins/model-catalog/catalog';
import { parseDurationOrNull } from '../util/duration';
import type { Message } from './types/messages';
import type { ProviderName } from './types/provider';

export interface ServerStateDecision {
  /** Provider-agnostic id to continue from (adapter maps to its own param). */
  previousResponseId?: string;
  /** Messages to actually send: trimmed to the new turn(s) when chaining, else full. */
  messages: Message[];
}

export function resolveServerState(args: {
  messages: Message[];
  provider: ProviderName;
  model: string;
  catalog: ModelCatalog;
  stateful: boolean;
  now: number;
}): ServerStateDecision {
  const { messages, provider, model, catalog, stateful, now } = args;
  if (!stateful) return { messages };

  // Most recent assistant turn that carries a server-state id.
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].origin?.serverStateId) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return { messages };

  const origin = messages[idx].origin;
  if (!origin?.serverStateId) return { messages };
  if (origin.provider !== provider) return { messages }; // foreign id — ignore, stay portable
  if (!catalog.supportsPreviousResponseId(provider, model)) return { messages };

  // TTL: if expired, the server has forgotten — resend history.
  const ttlMs = parseDurationOrNull(catalog.getStateRetention(provider, model));
  const createdAt = messages[idx].createdAt;
  if (ttlMs != null && createdAt != null && now - createdAt > ttlMs) return { messages };

  // Model-bound providers lose context across model swaps — resend history.
  if (catalog.isStateModelBound(provider, model) && origin.model && origin.model !== model) {
    return { messages };
  }

  // Continue server-side: send only the turns AFTER the stored interaction.
  const trimmed = messages.slice(idx + 1);
  if (trimmed.length === 0) return { messages }; // nothing new to add — just resend
  return { previousResponseId: origin.serverStateId, messages: trimmed };
}
