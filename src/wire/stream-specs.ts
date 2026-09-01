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
import type { StreamSpec } from './stream-interpreter';

export const STREAM_SPECS: Map<string, StreamSpec> = new Map<string, StreamSpec>([
  [anthropicMessages.id, anthropicMessages as unknown as StreamSpec],
]);

/** The stream spec id for a corpus/runtime target key. */
export const streamSpecId = (target: string): string => `${target}.stream`;

export function getStreamSpec(id: string): StreamSpec {
  const spec = STREAM_SPECS.get(id);
  if (!spec) throw new Error(`unknown stream spec: ${id}`);
  return spec;
}
