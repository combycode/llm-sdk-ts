/** The wire specs the RUNTIME loads: chat only, resolved and memoised.
 *
 *  Deliberately not `registry.ts`. That index imports all 71 specs — every media,
 *  realtime, files and batch spec included — so an adapter importing it would pull
 *  the whole set into every bundle whether or not anything reads them. Measured on
 *  the 2.3.0 build: interpreter + inherit + transforms is 18 KB minified, the nine
 *  chat specs add 15 KB, and all 71 specs add 41 KB. Chat-only is +2.7% on the
 *  bundle; everything is +4.8% for specs nothing executes yet.
 *
 *  `registry.ts` stays as the complete index for the tests and the ports. This is
 *  the runtime's subset, and it grows a family at a time as each adapter is
 *  migrated — so what ships is always what runs.
 *
 *  Chains are resolved once per id and cached: resolution walks `extends` and
 *  merges deltas, which is pure setup work and has no business happening per
 *  request.
 */

import { resolveSpec, type SpecDelta } from './inherit';
import type { WireSpec } from './interpreter';

import anthropic40 from './specs/anthropic-chain/messages@4.0.json' with { type: 'json' };
import anthropic41 from './specs/anthropic-chain/messages@4.1.json' with { type: 'json' };
import anthropic46 from './specs/anthropic-chain/messages@4.6.json' with { type: 'json' };
import anthropic47 from './specs/anthropic-chain/messages@4.7.json' with { type: 'json' };
import google25 from './specs/google-chain/generate@2.5.json' with { type: 'json' };
import google3 from './specs/google-chain/generate@3.json' with { type: 'json' };
import googleInteractions from './specs/google-interactions.json' with { type: 'json' };
import openaiCompletions from './specs/openai-completions.json' with { type: 'json' };
import openaiResponses from './specs/openai-responses.json' with { type: 'json' };

const DELTAS = new Map<string, SpecDelta>(
  (
    [
      anthropic40,
      anthropic41,
      anthropic46,
      anthropic47,
      google25,
      google3,
      googleInteractions,
      openaiCompletions,
      openaiResponses,
    ] as unknown as SpecDelta[]
  ).map((s) => [s.id, s]),
);

const resolved = new Map<string, WireSpec>();

/** The spec for `id`, with its inheritance chain already applied.
 *
 *  Throws on an unknown id rather than falling back to something plausible: a
 *  silently-substituted spec is a wrong request sent confidently, which is the
 *  exact failure the specs exist to end. Callers pick the fallback themselves —
 *  see each adapter's DEFAULT_SPEC. */
export function chatSpec(id: string): WireSpec {
  const hit = resolved.get(id);
  if (hit) return hit;
  const spec = resolveSpec(id, DELTAS);
  resolved.set(id, spec);
  return spec;
}

/** Whether a spec id is one the runtime can build. Lets an adapter fall back to
 *  its default instead of throwing when a catalog pin names a spec from a family
 *  that is not migrated yet. */
export const isChatSpec = (id: string | undefined): id is string =>
  id !== undefined && DELTAS.has(id);

/** Ids the runtime carries — asserted by the tests so this list and the shipped
 *  spec files cannot drift apart unnoticed. */
export const CHAT_SPEC_IDS: readonly string[] = [...DELTAS.keys()].sort();
