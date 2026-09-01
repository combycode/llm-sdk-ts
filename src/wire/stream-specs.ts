/** Every shipped stream spec, keyed by its id.
 *
 *  Imported one by one for the same reason `response-specs.ts` does it: the
 *  bundler has to see each import, and a spec that only exists on disk would
 *  work in tests and be missing from the package.
 *
 *  The id follows the corpus target key -- `anthropic/messages` becomes
 *  `anthropic/messages.stream` -- so the differential finds a target's spec
 *  without a second table to keep in step.
 */
import anthropicMessages from './specs/stream/anthropic.messages.json' with { type: 'json' };
import googleGenerate from './specs/stream/google.generate.json' with { type: 'json' };
import googleInteractions from './specs/stream/google.interactions.json' with { type: 'json' };
import openaiCompletions from './specs/stream/openai.completions.json' with { type: 'json' };
import openaiResponses from './specs/stream/openai.responses.json' with { type: 'json' };
import openrouterCompletions from './specs/stream/openrouter.completions.json' with { type: 'json' };
import xaiResponses from './specs/stream/xai.responses.json' with { type: 'json' };
import type { StreamSpec } from './stream-interpreter';

export const STREAM_SPECS: Map<string, StreamSpec> = new Map<string, StreamSpec>([
  [anthropicMessages.id, anthropicMessages as unknown as StreamSpec],
  [googleGenerate.id, googleGenerate as unknown as StreamSpec],
  [googleInteractions.id, googleInteractions as unknown as StreamSpec],
  [openaiCompletions.id, openaiCompletions as unknown as StreamSpec],
  [openaiResponses.id, openaiResponses as unknown as StreamSpec],
  [openrouterCompletions.id, openrouterCompletions as unknown as StreamSpec],
  [xaiResponses.id, xaiResponses as unknown as StreamSpec],
]);

/** The stream spec id for a corpus/runtime target key. */
export const streamSpecId = (target: string): string => `${target}.stream`;

/** Flattened: `extends` is walked here, so no caller sees a delta and mistakes
 *  it for the whole thing. Merge rules mirror the response side -- `state` by
 *  key, `on` appended parent-first, since rule order is rule meaning. */
export function getStreamSpec(id: string, seen: Set<string> = new Set()): StreamSpec {
  if (seen.has(id)) throw new Error(`cycle in stream spec inheritance at ${id}`);
  seen.add(id);
  const spec = STREAM_SPECS.get(id);
  if (!spec) throw new Error(`unknown stream spec: ${id}`);
  if (!spec.extends) return spec;
  const base = getStreamSpec(spec.extends, seen);
  return {
    ...base,
    ...spec,
    state: { ...(base.state ?? {}), ...(spec.state ?? {}) },
    on: [...(base.on ?? []), ...(spec.on ?? [])],
    tables: { ...(base.tables ?? {}), ...(spec.tables ?? {}) },
  };
}
