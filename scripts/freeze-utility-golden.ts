/** Freeze what the the four utility surfaces send.
 *
 *  Captured through the public entry points with an injected fetch, normalised to
 *  the four fields that actually go on the wire — two of these surfaces take a
 *  WHATWG `(url, init)` fetch today and an engine request object afterwards.
 *
 *  Run: bun run scripts/freeze-utility-golden.ts [--force]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { UTILITY_CASES, driveUtility, utilityKey } from '../tests/unit/wire/utility-corpus';
import { frozenForm } from '../tests/unit/wire/canon';

const OUT = resolve(import.meta.dir, '../tests/fixtures/utility-golden.json');
if (existsSync(OUT) && !process.argv.includes('--force')) {
  console.error(`refusing to overwrite ${OUT} — pass --force and say why in the commit.`);
  process.exit(1);
}

const index: Record<string, unknown> = {};
let count = 0;

for (const c of UTILITY_CASES) {
  const seen = await driveUtility(c);
  if (!seen.length) {
    console.error(`${c.op}/${c.name}: no request captured`);
    continue;
  }
  seen.forEach((r, i) => {
    index[utilityKey(c, i)] = frozenForm(r);
    count++;
  });
}

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      _doc:
        'What token counting, model listing, file retrieval and the provenance check sent, normalised so the record survives the fetch-shape change. ' +
        'Regenerate ONLY with --force and only when the wire genuinely changed.',
      frozenAtCommit: sha,
      counts: { cases: UTILITY_CASES.length, requests: count },
      index,
    },
    null,
    2,
  )}\n`,
);
console.log(`froze ${count} requests from ${UTILITY_CASES.length} cases`);
console.log(`  commit : ${sha}`);
console.log(`  file   : ${OUT}`);
