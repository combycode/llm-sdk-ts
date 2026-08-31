/** Every shipped response spec, keyed by its id.
 *
 *  Imported one by one rather than globbed, for the same reason `registry.ts`
 *  does it: the bundler has to see each import at build time, and a spec that
 *  only exists on disk would work in tests and be missing from the package.
 *
 *  The id follows the corpus target key -- `anthropic/messages` becomes
 *  `anthropic/messages.response` -- so the differential can find a target's spec
 *  without a second mapping table to keep in step.
 */
import anthropicMessages from './specs/responses/anthropic.messages.json' with { type: 'json' };
import googleGenerate from './specs/responses/google.generate.json' with { type: 'json' };
import googleInteractions from './specs/responses/google.interactions.json' with { type: 'json' };
import openaiCompletions from './specs/responses/openai.completions.json' with { type: 'json' };
import openaiResponses from './specs/responses/openai.responses.json' with { type: 'json' };
import openrouterCompletions from './specs/responses/openrouter.completions.json' with { type: 'json' };
import xaiResponses from './specs/responses/xai.responses.json' with { type: 'json' };
import { resolveResponseSpec, type ResponseSpec } from './response-interpreter';

export const RESPONSE_SPECS: Map<string, ResponseSpec> = new Map<string, ResponseSpec>([
  [anthropicMessages.id, anthropicMessages as unknown as ResponseSpec],
  [googleGenerate.id, googleGenerate as unknown as ResponseSpec],
  [googleInteractions.id, googleInteractions as unknown as ResponseSpec],
  [openaiCompletions.id, openaiCompletions as unknown as ResponseSpec],
  [openaiResponses.id, openaiResponses as unknown as ResponseSpec],
  [openrouterCompletions.id, openrouterCompletions as unknown as ResponseSpec],
  [xaiResponses.id, xaiResponses as unknown as ResponseSpec],
]);

/** The spec id for a corpus/runtime target key, e.g. `openai/completions`. */
export const responseSpecId = (target: string): string => `${target}.response`;

/** The spec FLATTENED: `extends` is walked here, so no caller ever sees a delta
 *  and mistakes it for the whole thing. */
export function getResponseSpec(id: string): ResponseSpec {
  return resolveResponseSpec(id, RESPONSE_SPECS);
}
