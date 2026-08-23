/** Give every catalogued CHAT model a `wireSpec` pin.
 *
 *  The pin names the spec that builds a model's requests, and the library holds
 *  an invariant that every chat model has one. Pins were assigned once, by hand;
 *  a catalog import then adds models that have none, and the invariant breaks on
 *  the next test run — which is a poor way to find out.
 *
 *  Nothing here is invented. `pinFor` is the same derivation the adapters use for
 *  a model the catalog has never heard of: ordered rules over the model id, in
 *  `src/wire/pins/*.json`. Writing it into the catalog only makes the answer
 *  explicit and reviewable — and a hand-set pin always wins, because a pin that
 *  contradicts the id is exactly what the catalog is for.
 *
 *  Run: bun run scripts/pin-catalog.ts [--check]
 *
 *  Belongs immediately after `catalog-loader`'s export: import → pin → test.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ANTHROPIC_MESSAGE_PINS, GOOGLE_GENERATE_PINS, pinFor } from '../src/wire/pins';

const DATA = resolve(import.meta.dir, '../src/catalog/data');
const CHECK = process.argv.includes('--check');

/** Which spec a provider's chat model uses when nothing else says otherwise.
 *  Anthropic and Google have version chains, so their pin is derived per model;
 *  the rest have exactly one chat spec. */
function pinOf(provider: string, model: string): string | undefined {
  switch (provider) {
    case 'anthropic':
      return pinFor(model, ANTHROPIC_MESSAGE_PINS);
    case 'google':
      return pinFor(model, GOOGLE_GENERATE_PINS);
    case 'openai':
      return 'openai/responses';
    case 'xai':
      return 'openai/responses';
    case 'openrouter':
      return 'openai/chat-completions';
    default:
      return undefined;
  }
}

let pinned = 0;
let already = 0;
const missing: string[] = [];

for (const file of readdirSync(DATA).filter((f) => f.endsWith('.json'))) {
  const provider = file.replace('.json', '');
  const path = join(DATA, file);
  const catalog = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
  let touched = false;

  for (const [slug, info] of Object.entries(catalog)) {
    if (info.type !== 'chat') continue;
    if (info.wireSpec) {
      already++;
      continue;
    }
    const model = slug.slice(slug.indexOf('/') + 1);
    const pin = pinOf(provider, model);
    if (!pin) {
      missing.push(slug);
      continue;
    }
    if (CHECK) {
      missing.push(slug);
      continue;
    }
    info.wireSpec = pin;
    pinned++;
    touched = true;
    console.log(`  pinned ${slug.padEnd(46)} -> ${pin}`);
  }

  if (touched) writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
}

if (CHECK) {
  if (missing.length) {
    console.error(`${missing.length} chat model(s) have no wireSpec:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`every chat model is pinned (${already})`);
} else {
  console.log(`\n${pinned} newly pinned, ${already} already pinned` + (missing.length ? `, ${missing.length} UNPINNABLE: ${missing.join(', ')}` : ''));
  if (missing.length) process.exit(1);
}
