/** Freeze what the MCP OAuth flow sends.
 *
 *  Captured through the exported flow functions with an injected fetch, so it
 *  measures them identically before and after the specs take over. This is the ONLY
 *  oracle here: an OAuth round-trip cannot be run live without a real authorization
 *  server and a browser.
 *
 *  Run: bun run scripts/freeze-mcp-oauth-golden.ts [--force]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { OAUTH_CASES, driveOauth, oauthKey } from '../tests/unit/wire/mcp-oauth-corpus';
import { frozenForm } from '../tests/unit/wire/canon';

const OUT = resolve(import.meta.dir, '../tests/fixtures/mcp-oauth-golden.json');
if (existsSync(OUT) && !process.argv.includes('--force')) {
  console.error(`refusing to overwrite ${OUT} — pass --force and say why in the commit.`);
  process.exit(1);
}

const index: Record<string, unknown> = {};
let count = 0;

for (const c of OAUTH_CASES) {
  const seen = await driveOauth(c);
  if (!seen.length) {
    console.error(`${c.op}/${c.name}: no request captured`);
    continue;
  }
  seen.forEach((r, i) => {
    index[oauthKey(c, i)] = frozenForm(r);
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
        'What the MCP OAuth flow sent, captured through an injected fetch. ' +
        'Regenerate ONLY with --force and only when the wire genuinely changed.',
      frozenAtCommit: sha,
      counts: { cases: OAUTH_CASES.length, requests: count },
      index,
    },
    null,
    2,
  )}\n`,
);
console.log(`froze ${count} requests from ${OAUTH_CASES.length} cases`);
console.log(`  commit : ${sha}`);
console.log(`  file   : ${OUT}`);
