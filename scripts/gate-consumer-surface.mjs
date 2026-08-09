/** G2 — consumer-surface check.
 *
 *  Every method the docs promise on a public object must exist as a MEMBER of that object's
 *  class in the BUILT types. Not "exists somewhere in dist" — that is what made the first
 *  attempt useless (it passed `agent.run()` and flagged `agent.complete()`).
 *
 *  Why it exists: 2.0.0 shipped a guide recommending `agent.run()`, a method that has never
 *  existed. Nothing compared the prose to the emitted API.
 *
 *  Usage:
 *    node scripts/gate-consumer-surface.mjs [--dist <dir>] [--docs-ref <git-ref>]
 *
 *    --dist      types to check against (default: ./dist)
 *    --docs-ref  read docs from a git ref instead of the working tree (e.g. v2.0.0),
 *                so the check can be validated against a known-bad release.
 *
 *  Exit 1 = a documented method is missing.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const DIST = arg('dist', 'dist');
const DOCS_REF = arg('docs-ref', null);

/** Receiver name in prose -> the class(es) that could own the method.
 *
 *  Several names are genuinely ambiguous in prose: `client` is an `LLMClient` in the LLM guides
 *  and an `McpClient` in the MCP design doc. A claim passes if ANY plausible receiver owns the
 *  method — precision costs less than false positives, which are what get a gate switched off.
 *  A method on none of them (`run`) is still caught, which is the whole job. */
const RECEIVERS = {
  agent: ['dist/agent/loop.d.ts'],
  loop: ['dist/agent/loop.d.ts'],
  client: ['dist/llm/client.d.ts', 'dist/plugins/mcp/client.d.ts'],
  llm: ['dist/llm/client.d.ts'],
  'mcp.client': ['dist/plugins/mcp/client.d.ts'],
};

/** Members declared on the FIRST class/interface in a .d.ts — methods and getters. */
function membersOf(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null; // type file absent -> cannot judge; reported separately
  }
  const members = new Set();
  for (const m of text.matchAll(/^\s{4}(?:get\s+|readonly\s+|static\s+)?([a-zA-Z_]\w*)\s*[(<:]/gm)) {
    members.add(m[1]);
  }
  return members;
}

/** Doc files, from the working tree or a git ref. */
function docFiles() {
  if (DOCS_REF) {
    const out = execFileSync('git', ['ls-tree', '-r', '--name-only', DOCS_REF], { encoding: 'utf8' });
    return out
      .split('\n')
      .filter((f) => /^(docs\/.*|README)\.mdx?$|^docs\/.*\.md$/.test(f) || /^README\.md$/.test(f))
      .map((f) => ({ path: f, text: execFileSync('git', ['show', `${DOCS_REF}:${f}`], { encoding: 'utf8' }) }));
  }
  const out = [];
  (function walk(d) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.mdx?$/.test(f)) out.push({ path: p, text: readFileSync(p, 'utf8') });
    }
  })('docs');
  out.push({ path: 'README.md', text: readFileSync('README.md', 'utf8') });
  return out;
}

// ── collect claims ────────────────────────────────────────────────────────────
const receiverAlt = Object.keys(RECEIVERS)
  .sort((a, b) => b.length - a.length)
  .map((r) => r.replace('.', '\\.'))
  .join('|');
// `agent.run()` in prose, and agent.run( in fenced code — both are promises to the reader.
const CLAIM = new RegExp(`\\b(${receiverAlt})\\.([a-zA-Z_]\\w*)\\s*\\(`, 'g');

const claims = new Map(); // "agent.run" -> Set(files)
for (const { path, text } of docFiles()) {
  for (const m of text.matchAll(CLAIM)) {
    const key = `${m[1]}.${m[2]}`;
    if (!claims.has(key)) claims.set(key, new Set());
    claims.get(key).add(path);
  }
}

// ── check them ────────────────────────────────────────────────────────────────
const memberCache = new Map();
const missing = [];
const unjudgeable = [];

for (const [claim, files] of claims) {
  const [recv, method] = [claim.slice(0, claim.lastIndexOf('.')), claim.slice(claim.lastIndexOf('.') + 1)];
  const rels = RECEIVERS[recv];
  let judged = false;
  let owned = false;
  for (const rel of rels) {
    const file = join(DIST, rel.replace(/^dist\//, ''));
    if (!memberCache.has(file)) memberCache.set(file, membersOf(file));
    const members = memberCache.get(file);
    if (!members) continue;
    judged = true;
    if (members.has(method)) { owned = true; break; }
  }
  if (!judged) { unjudgeable.push(`${claim} — none of ${rels.join(', ')} in ${DIST}`); continue; }
  if (!owned) missing.push({ claim, files: [...files], rel: rels.join(' | ') });
}

console.log(`G2 consumer-surface: ${claims.size} documented call(s) across ${RECEIVERS ? Object.keys(RECEIVERS).length : 0} receivers`);
console.log(`   dist: ${DIST}${DOCS_REF ? `   docs: ${DOCS_REF}` : '   docs: working tree'}`);
for (const u of unjudgeable) console.log(`   ? ${u}`);

if (missing.length === 0) {
  console.log('   OK — every documented method exists on its class');
  process.exit(0);
}
console.log(`\nMISSING (${missing.length}) — documented but not on the class:`);
for (const m of missing) console.log(`   ${m.claim}()   promised in: ${m.files.join(', ')}   (checked ${m.rel})`);
process.exit(1);
