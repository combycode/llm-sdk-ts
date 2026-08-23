/** Freeze what the embeddings and seamless-media adapters send.
 *
 *  These adapters had no request-builder seam: they assembled a request inline and
 *  handed it straight to `fetch`. So instead of calling a builder, this injects a
 *  capturing fetch and records what the adapter would really have sent — the same
 *  technique the lab used, and the only one available when the request never exists
 *  as a value the caller can hold.
 *
 *  That is also why this script doubles as the differential: it captures through
 *  the PUBLIC method either way, so it measures the adapter before and after the
 *  migration without caring which one is in place.
 *
 *  Run: bun run scripts/freeze-service-golden.ts [--force]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { OpenAIEmbeddingAdapter } from '../src/llm/providers/openai/embeddings';
import { OpenRouterEmbeddingAdapter } from '../src/llm/providers/openrouter/embeddings';
import { GoogleEmbeddingAdapter } from '../src/llm/providers/google/embeddings';
import { XAIMediaAdapter } from '../src/llm/providers/xai/media';
import { OpenRouterMediaAdapter } from '../src/llm/providers/openrouter/media';
import {
  EMBED_CASES,
  OPENROUTER_MEDIA_CASES,
  XAI_MEDIA_CASES,
  type OrMediaCase,
  type XaiMediaCase,
  REALTIME_CASES,
} from '../tests/unit/wire/service-corpus';
import type { ImageEditRequest, ImageGenRequest, AudioGenRequest, VideoGenRequest } from '../src/plugins/media/types';
import {
  OpenAIRealtimeAdapter,
  buildOpenAISessionUpdate,
  buildOpenAITurnFrames,
} from '../src/llm/providers/openai/realtime';
import {
  GoogleRealtimeAdapter,
  buildGoogleSetupFrame,
  buildGoogleTurnFrames,
} from '../src/llm/providers/google/realtime';

const OUT = resolve(import.meta.dir, '../tests/fixtures/service-golden.json');
const force = process.argv.includes('--force');
if (existsSync(OUT) && !force) {
  console.error(`refusing to overwrite ${OUT} — pass --force and say why in the commit.`);
  process.exit(1);
}

const K = 'k';

/** Records every request an adapter makes, and answers with something plausible so
 *  the method gets far enough to make the NEXT one. */
export function capturing(response: unknown = {}) {
  const seen: unknown[] = [];
  const fetch = (async (r: unknown) => {
    seen.push(r);
    return { status: 200, headers: {}, body: response };
  }) as never;
  return { fetch, seen };
}

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

const index: Record<string, unknown> = {};
let count = 0;
const record = (key: string, req: unknown) => {
  index[key] = JSON.parse(JSON.stringify(canon(req) ?? null));
  count++;
};

// ── embeddings ───────────────────────────────────────────────────────────────
const EMBED_ADAPTERS = {
  openai: new OpenAIEmbeddingAdapter({ apiKey: K }),
  openrouter: new OpenRouterEmbeddingAdapter({ apiKey: K }),
  google: new GoogleEmbeddingAdapter({ apiKey: K }),
};
const EMBED_RESPONSE = {
  data: [{ embedding: [0.1, 0.2] }],
  usage: { prompt_tokens: 3 },
  embedding: { values: [0.1, 0.2] },
};
for (const c of EMBED_CASES) {
  const { fetch, seen } = capturing(EMBED_RESPONSE);
  await EMBED_ADAPTERS[c.provider].embed(c.req, fetch);
  // Google loops one call per input; the corpus uses single inputs there so each
  // case is exactly one request either way.
  record(`embeddings/${c.provider}/${c.name}`, seen[0]);
}

// ── xai media ────────────────────────────────────────────────────────────────
const xai = new XAIMediaAdapter({ apiKey: K });
const XAI_RESPONSE = { data: [{ b64_json: 'AAAA' }], id: 'vid_1', request_id: 'vid_1' };
for (const c of XAI_MEDIA_CASES) {
  const { fetch, seen } = capturing(XAI_RESPONSE);
  try {
    await run(xai, c, fetch);
  } catch {
    /* parsing the fake response may fail; the request was already captured */
  }
  if (seen.length) record(`xai-media/${c.name}`, seen[0]);
  else console.error(`xai-media/${c.name}: no request captured`);
}

// ── openrouter media ─────────────────────────────────────────────────────────
const orm = new OpenRouterMediaAdapter({ apiKey: K });
const OR_RESPONSE = {
  choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,AAAA' } }], audio: { data: 'AAAA' } } }],
};
for (const c of OPENROUTER_MEDIA_CASES) {
  const { fetch, seen } = capturing(OR_RESPONSE);
  try {
    await runOr(orm, c, fetch);
  } catch {
    /* same: the request is what matters here */
  }
  if (seen.length) record(`openrouter-media/${c.name}`, seen[0]);
  else console.error(`openrouter-media/${c.name}: no request captured`);
}

async function run(a: XAIMediaAdapter, c: XaiMediaCase, fetch: never): Promise<unknown> {
  switch (c.kind) {
    case 'image':
      return a.generateImage(c.req as ImageGenRequest, fetch);
    case 'imageEdit':
      return a.editImage(c.req as ImageEditRequest, fetch);
    case 'audio':
      return a.generateAudio(c.req as AudioGenRequest, fetch);
    default:
      return a.submitVideo(c.req as VideoGenRequest, fetch);
  }
}

async function runOr(a: OpenRouterMediaAdapter, c: OrMediaCase, fetch: never): Promise<unknown> {
  switch (c.kind) {
    case 'image':
      return a.generateImage(c.req as ImageGenRequest, fetch);
    case 'imageEdit':
      return a.editImage(c.req as ImageEditRequest, fetch);
    default:
      return a.generateAudio(c.req as AudioGenRequest, fetch);
  }
}

// ── realtime ─────────────────────────────────────────────────────────────────
const RT = {
  openai: {
    adapter: new OpenAIRealtimeAdapter({ apiKey: K }),
    open: buildOpenAISessionUpdate,
    turn: buildOpenAITurnFrames,
  },
  google: {
    adapter: new GoogleRealtimeAdapter({ apiKey: K }),
    open: buildGoogleSetupFrame,
    turn: buildGoogleTurnFrames,
  },
};
for (const c of REALTIME_CASES) {
  const rt = RT[c.provider];
  record(`realtime/${c.provider}/${c.name}/connect`, rt.adapter.buildConnectRequest(c.config as never));
  record(`realtime/${c.provider}/${c.name}/open`, rt.open(c.config as never));
  for (const t of c.turns) {
    record(
      `realtime/${c.provider}/${c.name}/turn.${t.name}`,
      rt.turn(t.input as never, { turnComplete: t.turnComplete }),
    );
  }
}

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      _doc:
        'What the embeddings and seamless-media adapters sent, captured through an ' +
        'injected fetch. Regenerate ONLY with --force and only when the wire genuinely changed.',
      frozenAtCommit: sha,
      counts: { cases: count },
      index,
    },
    null,
    2,
  )}\n`,
);
console.log(`froze ${count} requests`);
console.log(`  commit : ${sha}`);
console.log(`  file   : ${OUT}`);
