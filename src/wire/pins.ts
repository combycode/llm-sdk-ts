/** Which spec builds a model's request when the catalog has no pin for it.
 *
 *  Every catalogued model carries an explicit `wireSpec`, so this only decides for
 *  the models the catalog does not know: one released after this build, or an
 *  engine running without a catalog at all. That case is not an edge — it is how
 *  the SDK works on the day a provider ships something new — so it keeps a real
 *  answer rather than a guess.
 *
 *  It is DATA, not code, for the same reason the specs are: the Python and Rust
 *  ports read this file instead of each re-implementing version arithmetic and
 *  drifting from it. Two versions of that arithmetic is exactly how the 2.2.1
 *  regression happened.
 *
 *  Rules are ordered and the first match wins; `default` answers everything else.
 */

import anthropicMessages from './pins/anthropic.messages.json' with { type: 'json' };
import googleGenerate from './pins/google.generate.json' with { type: 'json' };

export interface PinRule {
  /** Anchored regular expression, matched against the model id. */
  match: string;
  spec: string;
  /** Why this band exists. Read by humans, not by the resolver. */
  why?: string;
}

export interface ModelPins {
  id: string;
  rules?: PinRule[];
  default: string;
}

const compiled = new Map<string, Array<{ re: RegExp; spec: string }>>();

function rulesFor(pins: ModelPins): Array<{ re: RegExp; spec: string }> {
  let list = compiled.get(pins.id);
  if (!list) {
    list = (pins.rules ?? []).map((r) => ({ re: new RegExp(r.match), spec: r.spec }));
    compiled.set(pins.id, list);
  }
  return list;
}

/** The spec id for `model`, from an ordered rule table.
 *
 *  The id is lower-cased and stripped of a `provider/` prefix first, because a
 *  caller may legitimately pass either form and a band must not depend on which. */
export function pinFor(model: string, pins: ModelPins): string {
  const id = model.toLowerCase().replace(/^anthropic\//, '');
  for (const { re, spec } of rulesFor(pins)) {
    if (re.test(id)) return spec;
  }
  return pins.default;
}

export const ANTHROPIC_MESSAGE_PINS = anthropicMessages as unknown as ModelPins;
export const GOOGLE_GENERATE_PINS = googleGenerate as unknown as ModelPins;
