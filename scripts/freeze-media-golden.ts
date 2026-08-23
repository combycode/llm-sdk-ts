/** Freeze what the hand-written MEDIA adapters send, before they are spec-driven.
 *
 *  Same contract as `freeze-wire-golden.ts`, different entry points: media requests
 *  do not pass through `buildRequest(NormalizedRequest)`, so the chat corpus cannot
 *  reach them at all.
 *
 *  Unlike the chat freeze this one can be taken from HEAD, because these adapters
 *  are still hand-written. Once any of them is switched, re-taking it from HEAD
 *  would freeze the migration's own output — which is why the file records the
 *  commit it came from, and why re-freezing needs --force and a reason.
 *
 *  Run: bun run scripts/freeze-media-golden.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { OpenAIMediaAdapter } from '../src/llm/providers/openai/media';
import { GoogleMediaAdapter } from '../src/llm/providers/google/media';
import { MEDIA_SUITES, type MediaCase } from '../tests/unit/wire/media-corpus';
import type {
  AudioGenRequest,
  ImageEditRequest,
  ImageGenRequest,
  VideoGenRequest,
} from '../src/plugins/media/types';

const OUT = resolve(import.meta.dir, '../tests/fixtures/media-golden.json');
const force = process.argv.includes('--force');

if (existsSync(OUT) && !force) {
  console.error(
    `refusing to overwrite ${OUT}\n` +
      `Re-freezing after a behaviour change turns the corpus into a copy of that\n` +
      `change. This needs --force and a reason in the commit message.`,
  );
  process.exit(1);
}

const K = 'k';
const openai = new OpenAIMediaAdapter({ apiKey: K });
const google = new GoogleMediaAdapter({ apiKey: K });

type Media = { [k: string]: (...a: never[]) => unknown };
const ADAPTERS: Record<string, Media> = {
  openai: openai as unknown as Media,
  google: google as unknown as Media,
};

/** Which method each kind maps to, per provider. The names differ — OpenAI's
 *  image entry point is `buildGenerateImageRequest`, Google's is
 *  `buildImageRequest`, which itself forks to Imagen or generateContent. */
const METHOD: Record<string, Record<MediaCase['kind'], string>> = {
  openai: {
    image: 'buildGenerateImageRequest',
    imageEdit: 'buildEditImageRequest',
    audio: 'buildAudioRequest',
    video: 'buildVideoRequest',
  },
  google: {
    image: 'buildImageRequest',
    imageEdit: 'buildEditImageRequest',
    audio: 'buildAudioRequest',
    video: 'buildVideoRequest',
  },
};

/** Key-sorted, undefined-dropped — the wire has no opinion on object order. */
const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) if (src[k] !== undefined) out[k] = canon(src[k]);
    return out;
  }
  return v;
};

export function buildMedia(provider: string, c: MediaCase): unknown {
  const adapter = ADAPTERS[provider];
  const method = METHOD[provider]?.[c.kind];
  if (!adapter || !method) throw new Error(`no ${provider} method for ${c.kind}`);
  const fn = adapter[method];
  if (typeof fn !== 'function') throw new Error(`${provider}.${method} is not a function`);
  const req = c.req as ImageGenRequest & ImageEditRequest & AudioGenRequest & VideoGenRequest;
  return (fn as (r: unknown, m: string) => unknown).call(adapter, req, c.model);
}

const index: Record<string, unknown> = {};
let count = 0;
for (const { provider, cases } of MEDIA_SUITES) {
  for (const c of cases) {
    // The API key is baked into Google's URLs; strip it so the fixture carries no
    // secret shape and stays stable if the placeholder ever changes.
    const built = JSON.parse(JSON.stringify(canon(buildMedia(provider, c)) ?? null));
    index[`${provider}/${c.name}`] = built;
    count++;
  }
}

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      _doc:
        'What the hand-written media adapters sent, frozen before the spec-driven ' +
        'migration. Regenerate ONLY with scripts/freeze-media-golden.ts --force, and ' +
        'only when the wire genuinely changed — say why in the commit.',
      frozenAtCommit: sha,
      counts: { cases: count },
      index,
    },
    null,
    2,
  )}\n`,
);

console.log(`froze ${count} media requests`);
console.log(`  commit : ${sha}`);
console.log(`  file   : ${OUT}`);
