/** Freeze what the HAND-WRITTEN adapters send today, for every catalogued chat
 *  model and every request shape.
 *
 *  This exists because of what happens to the differential test in 3.0.0. Today
 *  `every-model-reproduces-its-adapter.test.ts` asks "does the spec agree with the
 *  adapter?" and answers it over 4,913 comparisons. The moment an adapter is driven
 *  by its spec, that question becomes "does the spec agree with itself" — it stays
 *  green forever and proves nothing, and that is precisely when the hand-written
 *  path gets deleted.
 *
 *  So before any adapter is switched, the current output is frozen here. Afterwards
 *  the assertion is "the spec-driven request equals the request 2.3.0 actually
 *  shipped", which survives the deletion of the code that produced it and is the
 *  only thing that can catch a silent wire change during the migration.
 *
 *  ── why it is content-addressed ────────────────────────────────────────────
 *  Verbatim, the corpus is 0.98 MB and mostly the same body repeated with a
 *  different model id. Factoring the model out leaves 551 distinct bodies. So the
 *  file stores each distinct body once under a hash of itself, and an index from
 *  model+shape to that hash. A spec change that alters one shape then shows up as
 *  ONE changed body plus the models that moved to it — a reviewable diff instead of
 *  289 identical ones.
 *
 *  Run: bun run scripts/freeze-wire-golden.ts
 *  It refuses to overwrite unless --force is passed, because re-freezing after a
 *  behaviour change is how a golden corpus quietly becomes a copy of the bug.
 *
 *  ── --add-new, for models that arrive later ────────────────────────────────
 *  A catalog import brings models that did not exist at 2.3.0, so there is no
 *  2.3.0 behaviour to compare them against — but leaving them out breaks the
 *  corpus's coverage invariant, and coverage is what stops a model from quietly
 *  going unchecked. `--add-new` captures ONLY models absent from the index and
 *  leaves every existing entry untouched, so the 2.3.0 baseline survives.
 *
 *  The content-addressing makes this stronger than it sounds: a new model that
 *  behaves like its already-frozen siblings lands on a body hash that is ALREADY
 *  in the file. A genuinely new body is therefore the interesting case, and the
 *  run says how many there were.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ModelCatalog, type ModelInfo } from '../src/catalog/catalog';
import { fnv1a32Hex } from '../src/util/hash';
import { AnthropicAdapter } from '../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../src/llm/providers/google/generate';
import { GoogleInteractionsAdapter } from '../src/llm/providers/google/interactions';
import { OpenAIResponsesAdapter } from '../src/llm/providers/openai/responses';
import { OpenAIAdapter } from '../src/llm/providers/openai/completions';
import { XAIAdapter } from '../src/llm/providers/xai/completions';
import { XAIResponsesAdapter } from '../src/llm/providers/xai/responses';
import { OpenRouterAdapter } from '../src/llm/providers/openrouter/completions';
import { OpenRouterResponsesAdapter } from '../src/llm/providers/openrouter/responses';
import { SHAPES, subjectsFrom, onWire, type Adapterish } from '../tests/unit/wire/wire-corpus';
import pkg from '../package.json' with { type: 'json' };

const OUT = resolve(import.meta.dir, '../tests/fixtures/wire-golden.json');
const force = process.argv.includes('--force');
const addNew = process.argv.includes('--add-new');
// --add-shapes is --add-new's counterpart for SHAPES: capture only shapes the
// index does not already carry, and leave every frozen cell untouched. Needed
// because a shape added now cannot have a 2.3.0 baseline -- the hand-written
// adapters that would have produced one are gone -- so re-freezing wholesale
// would silently relabel the entire corpus as "whatever the specs do today".
const addShapes = process.argv.includes('--add-shapes');

if (existsSync(OUT) && !force && !addNew && !addShapes) {
  console.error(
    `refusing to overwrite ${OUT}\n` +
      `A golden corpus is only worth what it was frozen from. Re-freezing after a\n` +
      `behaviour change turns it into a copy of that change, so this needs --force\n` +
      `and a reason in the commit message.`,
  );
  process.exit(1);
}

const K = 'k';
const adapters: Record<string, Record<string, Adapterish | undefined>> = {
  anthropic: { messages: new AnthropicAdapter({ apiKey: K }) },
  google: {
    generate: new GoogleAdapter({ apiKey: K }),
    interactions: new GoogleInteractionsAdapter({ apiKey: K }),
  },
  openai: {
    responses: new OpenAIResponsesAdapter({ apiKey: K }),
    completions: new OpenAIAdapter({ apiKey: K }),
  },
  xai: {
    responses: new XAIResponsesAdapter({ apiKey: K }),
    completions: new XAIAdapter({ apiKey: K }),
  },
  openrouter: {
    responses: new OpenRouterResponsesAdapter({ apiKey: K }),
    completions: new OpenRouterAdapter({ apiKey: K }),
  },
};

const catalog = new ModelCatalog();
catalog.loadProviderDefaults();
const subjects = subjectsFrom(catalog.list() as ModelInfo[], adapters);

// --add-new starts from what is already frozen and only appends.
const prior = (addNew || addShapes) && existsSync(OUT)
  ? (JSON.parse(readFileSync(OUT, 'utf8')) as {
      bodies: Record<string, unknown>;
      index: Record<string, Record<string, string>>;
      frozenAt?: string;
      addedLater?: Record<string, string>;
      shapesAddedLater?: Record<string, string>;
    })
  : undefined;

const bodies: Record<string, unknown> = { ...(prior?.bodies ?? {}) };
const index: Record<string, Record<string, string>> = { ...(prior?.index ?? {}) };
const addedLater: Record<string, string> = { ...(prior?.addedLater ?? {}) };
const shapesAddedLater: Record<string, string> = { ...(prior?.shapesAddedLater ?? {}) };
const priorBodyCount = Object.keys(bodies).length;
let added = 0;
let count = 0;

for (const s of subjects) {
  const key = s.key;
  if (addNew && index[key]) continue; // already frozen — never re-capture
  if (addNew) {
    added++;
    addedLater[key] = pkg.version;
  }
  // --add-shapes keeps the existing cells for this model and fills only the gaps.
  index[key] = addShapes ? { ...(index[key] ?? {}) } : {};
  for (const shape of SHAPES) {
    if (addShapes && index[key][shape.name] !== undefined) continue;
    if (addShapes) shapesAddedLater[shape.name] ??= pkg.version;
    const wire = onWire(s.adapter.buildRequest(shape.req(s.model) as never));
    // Factor the model id out so "same request, different model" stores once. The
    // placeholder is put back before comparing, so nothing is lost.
    const generic = wire.split(JSON.stringify(s.model)).join('"$MODEL"');
    const hash = fnv1a32Hex(generic);
    const existing = bodies[hash];
    if (existing !== undefined && JSON.stringify(existing) !== generic) {
      throw new Error(
        `hash collision on ${hash} (${key} ${shape.name}) — widen the digest before trusting this file`,
      );
    }
    bodies[hash] = JSON.parse(generic);
    index[key][shape.name] = hash;
    count++;
  }
}

const out = {
  _doc:
    'What the hand-written adapters sent, frozen before the spec-driven migration. ' +
    'Bodies are stored once each, keyed by a hash of themselves, with the model id ' +
    'replaced by "$MODEL". Regenerate ONLY with scripts/freeze-wire-golden.ts --force, ' +
    'and only when the wire genuinely changed — say why in the commit.',
  frozenAt: prior?.frozenAt ?? pkg.version,
  // Models that arrived after the freeze, and the version they were captured at.
  // Their baseline is that version, not the original one — worth knowing when a
  // diff shows up on one of them.
  ...(Object.keys(addedLater).length ? { addedLater } : {}),
  // Shapes captured after the freeze. Their baseline is the version named here,
  // NOT `frozenAt` -- they are a regression guard and a cross-language
  // reference, not evidence about pre-migration behaviour.
  ...(Object.keys(shapesAddedLater).length ? { shapesAddedLater } : {}),
  shapes: SHAPES.map((s) => s.name),
  counts: { models: Object.keys(index).length, shapes: SHAPES.length, bodies: count, distinct: Object.keys(bodies).length },
  bodies,
  index,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

if (addNew) {
  const newBodies = Object.keys(bodies).length - priorBodyCount;
  console.log(
    `added ${added} model(s) not previously frozen — ${newBodies} genuinely new bodies ` +
      `(0 means each one behaves exactly like an already-frozen sibling)`,
  );
} else {
  console.log(`froze ${count} bodies (${Object.keys(bodies).length} distinct) from ${subjects.length} models`);
}
console.log(`  version : ${pkg.version}`);
console.log(`  file    : ${OUT}`);
