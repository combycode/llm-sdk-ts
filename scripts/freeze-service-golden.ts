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
import { AnthropicBatchAdapter } from '../src/llm/providers/anthropic/batch';
import { OpenAIBatchAdapter } from '../src/llm/providers/openai/batch';
import { GoogleBatchAdapter } from '../src/llm/providers/google/batch';
import { XAIBatchAdapter } from '../src/llm/providers/xai/batch';
import { AnthropicFileAdapter } from '../src/llm/providers/anthropic/files';
import { OpenAIFileAdapter } from '../src/llm/providers/openai/files';
import { GoogleFileAdapter } from '../src/llm/providers/google/files';
import { XAIFileAdapter } from '../src/llm/providers/xai/files';
import { FileAttachment } from '../src/plugins/files/attachment';
import {
  EMBED_CASES,
  OPENROUTER_MEDIA_CASES,
  XAI_MEDIA_CASES,
  type OrMediaCase,
  type XaiMediaCase,
  REALTIME_CASES,
  BATCH_CASES,
  BATCH_REQUESTS,
  BATCH_ID,
  FILE_CASES,
  FILE_REMOTE_ID,
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

/** FormData does not JSON-serialise in any stable way - depending on the runtime
 *  it comes out as `{}` or as its own enumerable properties, which made a
 *  multipart upload compare unequal to itself across two runs of the same code.
 *  So it is converted explicitly: field order preserved, and a file part reduced
 *  to the things that actually describe it on the wire. */
const fromForm = (f: FormData): unknown => ({
  __formData: [...f.entries()].map(([name, v]) =>
    typeof v === 'string'
      ? { name, value: v }
      : {
          name,
          filename: (v as File).name,
          type: (v as File).type,
          size: (v as File).size,
        },
  ),
});

const canon = (v: unknown): unknown => {
  // Re-enter canon so the converted entries get key-sorted like everything else.
  if (typeof FormData !== 'undefined' && v instanceof FormData) return canon(fromForm(v));
  if (v instanceof Uint8Array) return { __bytes: v.length };
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

// ── batch ────────────────────────────────────────────────────────────────────
const BATCH_ADAPTERS = {
  anthropic: new AnthropicBatchAdapter({ apiKey: K }),
  openai: new OpenAIBatchAdapter({ apiKey: K }),
  google: new GoogleBatchAdapter({ apiKey: K, model: 'gemini-3-flash' }),
  xai: new XAIBatchAdapter({ apiKey: K }),
};
// Enough of a response for each step to reach the next one: an id for submit,
// a file id for OpenAI's two-step upload, and empty result payloads.
const BATCH_RESPONSE = {
  id: BATCH_ID,
  name: BATCH_ID,
  batch: { name: BATCH_ID },
  output_file_id: 'file_out',
  results_url: 'https://x/results',
  request_counts: {},
  metadata: {},
  data: [],
};
for (const c of BATCH_CASES) {
  const a = BATCH_ADAPTERS[c.provider] as Record<string, (...x: never[]) => Promise<unknown>>;
  const { fetch, seen } = capturing(BATCH_RESPONSE);
  try {
    if (c.op === 'submit') await a.submit(BATCH_REQUESTS as never, fetch);
    else await a[c.op](BATCH_ID as never, fetch);
  } catch {
    /* the fake response may not parse; the requests are already captured */
  }
  if (!seen.length) {
    console.error(`batch/${c.provider}/${c.op}: no request captured`);
    continue;
  }
  // Some operations make MORE than one call (OpenAI uploads then creates, xAI
  // creates then adds). Freeze every one of them, in order.
  seen.forEach((r, i) => record(`batch/${c.provider}/${c.op}${i ? `.${i}` : ''}`, r));
}

// ── files ────────────────────────────────────────────────────────────────────
const FILE_ADAPTERS = {
  anthropic: new AnthropicFileAdapter({ apiKey: K }),
  openai: new OpenAIFileAdapter({ apiKey: K }),
  google: new GoogleFileAdapter({ apiKey: K }),
  xai: new XAIFileAdapter({ apiKey: K }),
};
// `FileContent` is a discriminated union on `type`, with the bytes under `data`.
// Getting that wrong does not throw for OpenAI-style uploads — `toBuffer()` just
// returns undefined and the Blob comes out empty — so three of the four uploads
// froze silently malformed before this was corrected.
const ATTACHMENT = new FileAttachment({
  filename: 'note.txt',
  mimeType: 'text/plain',
  sizeBytes: 5,
  content: { type: 'buffer', mimeType: 'text/plain', data: new Uint8Array([104, 101, 108, 108, 111]) },
});
// Google's resumable upload reads the upload URL out of a RESPONSE HEADER, so the
// fake response has to carry one or the second call never happens.
const FILE_RESPONSE = {
  id: 'file_abc',
  uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
  file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc' },
  data: [],
  files: [],
};
for (const c of FILE_CASES) {
  const a = FILE_ADAPTERS[c.provider] as unknown as Record<
    string,
    (...x: never[]) => Promise<unknown>
  >;
  const seenAll: unknown[] = [];
  const fetch = (async (r: unknown) => {
    seenAll.push(r);
    return {
      status: 200,
      headers: { 'x-goog-upload-url': 'https://upload.example/session' },
      body: FILE_RESPONSE,
    };
  }) as never;
  try {
    if (c.op === 'upload') await a.upload(ATTACHMENT as never, fetch);
    else if (c.op === 'list') await a.list(fetch);
    else await a[c.op]?.(FILE_REMOTE_ID[c.provider] as never, fetch);
  } catch {
    /* the fake response may not parse; the requests are already captured */
  }
  if (!seenAll.length) {
    console.error(`files/${c.provider}/${c.op}: no request captured`);
    continue;
  }
  seenAll.forEach((r, i) => record(`files/${c.provider}/${c.op}${i ? `.${i}` : ''}`, r));
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
