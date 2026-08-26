/** Emit the golden corpus's request SHAPES as language-agnostic JSON.
 *
 *  `wire-golden.json` already stores what each (model, shape) pair produced —
 *  438 recorded bodies, keyed by hash, with the model id replaced by `$MODEL`.
 *  What it does not store is the INPUT: the 23 request shapes live in
 *  `tests/unit/wire/wire-corpus.ts` as `(model) => ({...})` closures.
 *
 *  That is fine while TypeScript is the only implementation. It stops being fine
 *  the moment a second one has to prove it builds the same bytes: the Python port
 *  can read the expected outputs and cannot read the inputs, so the corpus is
 *  half a conformance suite.
 *
 *  The closures are pure data — the only dynamic part is substituting the model —
 *  so this writes them out with the same `$MODEL` placeholder the bodies already
 *  use. `wire-corpus.ts` stays the single definition; this is a projection of it,
 *  regenerated rather than maintained.
 *
 *  Run: bun run scripts/export-wire-shapes.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHAPES } from '../tests/unit/wire/wire-corpus';

const MODEL = '$MODEL';

const shapes = SHAPES.map((s) => {
  const req = s.req(MODEL) as Record<string, unknown>;
  // Guard the projection: if a shape ever stops putting the model where we
  // expect, the placeholder would silently vanish and the Python side would
  // replay a request for a model that does not exist.
  if (req.model !== MODEL) {
    throw new Error(`shape "${s.name}" does not carry the model verbatim; cannot project it`);
  }
  return { name: s.name, req };
});

const out = {
  _doc:
    'Request shapes for the wire golden corpus, projected from tests/unit/wire/wire-corpus.ts ' +
    'so implementations in other languages can replay it. "$MODEL" is substituted per model. ' +
    'Generated — edit wire-corpus.ts and re-run scripts/export-wire-shapes.ts.',
  modelPlaceholder: MODEL,
  shapes,
};

const path = join(import.meta.dir, '..', 'tests', 'fixtures', 'wire-shapes.json');
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${shapes.length} shapes -> ${path}`);
