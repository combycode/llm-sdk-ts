/** Freeze what the three HOSTED retrieval backends send.
 *
 *  Same technique as the other freezes, and for the same reason: these backends
 *  assemble a request inline and hand it straight to `fetch`, so the only way to
 *  see one is to intercept the network. The capture goes through the PUBLIC method,
 *  which is what makes this fixture a differential rather than a snapshot of the
 *  implementation — it measures the backend identically before and after the specs
 *  take over.
 *
 *  Run: bun run scripts/freeze-retrieval-golden.ts [--force]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  RETRIEVAL_CASES,
  canon,
  driveRetrieval,
  keyFor,
} from '../tests/unit/wire/retrieval-corpus';

const OUT = resolve(import.meta.dir, '../tests/fixtures/retrieval-golden.json');
if (existsSync(OUT) && !process.argv.includes('--force')) {
  console.error(`refusing to overwrite ${OUT} — pass --force and say why in the commit.`);
  process.exit(1);
}

const index: Record<string, unknown> = {};
let count = 0;

for (const c of RETRIEVAL_CASES) {
  const seen = await driveRetrieval(c);
  if (!seen.length) {
    console.error(`${c.provider}/${c.op}/${c.name}: no request captured`);
    continue;
  }
  seen.forEach((r, i) => {
    index[keyFor(c, i)] = JSON.parse(JSON.stringify(canon(r) ?? null));
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
        'What the hosted retrieval backends sent, captured through an injected fetch. ' +
        'Regenerate ONLY with --force and only when the wire genuinely changed.',
      frozenAtCommit: sha,
      counts: { cases: RETRIEVAL_CASES.length, requests: count },
      index,
    },
    null,
    2,
  )}\n`,
);
console.log(`froze ${count} requests from ${RETRIEVAL_CASES.length} cases`);
console.log(`  commit : ${sha}`);
console.log(`  file   : ${OUT}`);
