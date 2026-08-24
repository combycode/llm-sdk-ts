/** The utility spec family: exact token counting, live model listing, file
 *  content retrieval, and the provenance check.
 *
 *  Four small surfaces that share nothing except being requests. They are loaded
 *  together because each is a handful of specs and no consumer reaches one without
 *  reaching the layer that owns it.
 */

import { resolveSpec, type SpecDelta } from './inherit';
import type { WireSpec } from './interpreter';

import countAnthropic from './specs/count/anthropic.json' with { type: 'json' };
import countGoogle from './specs/count/google.json' with { type: 'json' };
import countXai from './specs/count/xai.json' with { type: 'json' };

import modelsOpenai from './specs/models/openai.json' with { type: 'json' };
import modelsAnthropic from './specs/models/anthropic.json' with { type: 'json' };
import modelsGoogle from './specs/models/google.json' with { type: 'json' };
import modelsXai from './specs/models/xai.json' with { type: 'json' };
import modelsOpenrouter from './specs/models/openrouter.json' with { type: 'json' };

import contentOpenai from './specs/files/openai.content.json' with { type: 'json' };
import contentOpenaiContainer from './specs/files/openai.content.container.json' with { type: 'json' };
import contentAnthropic from './specs/files/anthropic.content.json' with { type: 'json' };
import contentGoogle from './specs/files/google.content.json' with { type: 'json' };
import downloadByUrl from './specs/files/download.byUrl.json' with { type: 'json' };

import provenanceOpenai from './specs/provenance/openai.json' with { type: 'json' };

const UTILITY_SPECS = new Map<string, SpecDelta>(
  (
    [
      countAnthropic, countGoogle, countXai,
      modelsOpenai, modelsAnthropic, modelsGoogle, modelsXai, modelsOpenrouter,
      contentOpenai, contentOpenaiContainer, contentAnthropic, contentGoogle, downloadByUrl,
      provenanceOpenai,
    ] as unknown as SpecDelta[]
  ).map((s) => [(s as { id: string }).id, s]),
);

const cache = new Map<string, WireSpec>();

/** Resolve a utility spec by id, flattening its `extends` chain. */
export function utilitySpec(id: string): WireSpec {
  const hit = cache.get(id);
  if (hit) return hit;
  const spec = resolveSpec(id, UTILITY_SPECS) as WireSpec;
  cache.set(id, spec);
  return spec;
}
