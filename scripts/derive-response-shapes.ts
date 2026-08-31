/** Derive `src/llm/response-shapes.json` from the recorded response corpus.
 *
 *  The shape descriptions are NOT hand-written. A hand-written list of "fields we
 *  understand" is a second source of truth that drifts from the first one the day
 *  after it is written, and its drift is invisible — it describes what someone
 *  believed, which is the exact failure the corpus exists to end.
 *
 *  So the descriptions come out of the recordings:
 *
 *    known     every path seen in any recording for that provider/api.
 *    expected  every path seen in ALL of them. A field the provider sends every
 *              single time is one whose absence means something changed.
 *    values    for the discriminator keys only (`type`, `role`, `finish_reason`,
 *              …), the values actually observed. A value outside this set is a
 *              branch nothing handles.
 *
 *  `expected` is deliberately the strict intersection. Anything conditional — a
 *  tool call, a thinking block, a refusal — appears in some recordings and not
 *  others, so it lands in `known` and never in `expected`, and cannot produce a
 *  false "missing".
 *
 *  Re-run after `bun run record:responses`:
 *    bun run scripts/derive-response-shapes.ts
 *
 *  The corpus test then proves the result: every recorded body must yield zero
 *  unknown paths against what this wrote.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  discriminatorsOf,
  pathsOf,
  streamEventKey,
  type ShapeBook,
  type ShapeDecl,
} from '../src/llm/response-shape';
import type { SSEEvent } from '../src/network/types';
import type { ResponseCell } from '../tests/unit/llm/response-corpus';

const CORPUS = resolve(import.meta.dir, '../tests/fixtures/response-golden.json');
const OUT = resolve(import.meta.dir, '../src/llm/response-shapes.json');

const corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as Record<string, ResponseCell>;

/** One observation: the paths of a single body, and its discriminator values. */
interface Sample {
  paths: Set<string>;
  values: Array<[string, string]>;
  /** A CONSTRUCTED body (see `ResponseScenario.synthetic`). It is evidence about
   *  what the parser must tolerate, and no evidence at all about what a provider
   *  always sends. */
  weak?: boolean;
}

function sample(body: unknown, weak = false): Sample {
  return { paths: pathsOf(body), values: discriminatorsOf(body), ...(weak ? { weak } : {}) };
}

/** Fold samples into a declaration: union of paths, intersection for expected. */
function declare(samples: Sample[]): ShapeDecl {
  const known = new Set<string>();
  const values: Record<string, Set<string>> = {};
  for (const s of samples) {
    for (const p of s.paths) known.add(p);
    for (const [path, value] of s.values) (values[path] ??= new Set()).add(value);
  }
  // `expected` is the intersection over RECORDED bodies only. A synthetic error
  // cell carries `output: []`, so letting it in would delete `output[].id` from
  // `expected` for every genuine recording — weakening the check on the strength
  // of a body no provider ever sent. `known` and `values` above still learn from
  // it, which is the half that should widen.
  let expected: Set<string> | undefined;
  for (const s of samples.filter((x) => !x.weak)) {
    if (!expected) {
      expected = new Set(s.paths);
      continue;
    }
    for (const p of [...expected]) if (!s.paths.has(p)) expected.delete(p);
  }
  const decl: ShapeDecl = {
    known: [...known].sort(),
    expected: [...(expected ?? new Set<string>())].sort(),
  };
  const valueEntries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  if (valueEntries.length) {
    decl.values = Object.fromEntries(valueEntries.map(([k, v]) => [k, [...v].sort()]));
  }
  return decl;
}

const responseSamples: Record<string, Sample[]> = {};
/** target -> SSE event type -> samples. Per event type, because a stream's event
 *  types share almost no fields and pooling them leaves `expected` empty. */
const streamSamples: Record<string, Record<string, Sample[]>> = {};

for (const cell of Object.values(corpus)) {
  // The corpus target key IS `provider/api` — the same key the client builds at
  // runtime — so no mapping table sits between the two.
  const key = cell.target;
  if (cell.streaming) {
    for (const event of cell.raw as SSEEvent[]) {
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        continue; // `[DONE]` and keep-alives describe no shape
      }
      const evKey = streamEventKey(event, data);
      ((streamSamples[key] ??= {})[evKey] ??= []).push(sample(data));
    }
  } else {
    (responseSamples[key] ??= []).push(sample(cell.raw, cell.synthetic === true));
  }
}

const book: ShapeBook = {};
for (const key of new Set([...Object.keys(responseSamples), ...Object.keys(streamSamples)])) {
  book[key] = {};
  if (responseSamples[key]) book[key].response = declare(responseSamples[key]);
  const byEvent = streamSamples[key];
  if (byEvent) {
    book[key].stream = Object.fromEntries(
      Object.entries(byEvent)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([evKey, samples]) => [evKey, declare(samples)]),
    );
  }
}

const ordered = Object.fromEntries(Object.entries(book).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(OUT, `${JSON.stringify(ordered, null, 2)}\n`);

console.log(`response shapes: ${Object.keys(ordered).length} targets`);
for (const [key, set] of Object.entries(ordered)) {
  const r = set.response;
  const events = Object.keys(set.stream ?? {});
  console.log(
    `  ${key.padEnd(26)} response ${String(r?.known.length ?? 0).padStart(3)} paths / ` +
      `${String(r?.expected.length ?? 0).padStart(3)} always   stream ${String(events.length).padStart(2)} event type(s)`,
  );
}
