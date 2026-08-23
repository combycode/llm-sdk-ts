/** Is every piece of named code the specs can reach actually reachable, reached,
 *  and correct — and does anything the specs name not exist?
 *
 *  This exists because "no spec references X" was asserted from a single grep of a
 *  single directory, and that is not evidence. The name could appear under any of
 *  FIVE different keys, in specs the grep did not cover, or be reached only by a
 *  model generation the corpus never builds.
 *
 *  Two passes, because they answer different questions and neither is sufficient:
 *
 *    STATIC   parse every shipped spec, collect every named reference under all
 *             five forms, and diff against the registry.
 *               referenced but missing -> the spec throws at runtime. A BUG.
 *               present but unreferenced -> dead code, safe to delete.
 *    DYNAMIC  drive the corpus and record what actually fires.
 *               referenced but never fired -> untested path, NOT dead. The most
 *               dangerous category: it looks covered and is not.
 *
 *  A name can be referenced statically and still never fire (guarded by a
 *  predicate no corpus case satisfies), so the second pass cannot be inferred from
 *  the first.
 *
 *  Run: bun run scripts/audit-wire-coverage.ts
 *  Exit 1 if a spec names code that does not exist.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ModelCatalog, type ModelInfo } from '../src/catalog/catalog';
import { WIRE_SPECS } from '../src/wire/registry';
import { resolveSpec, type SpecDelta } from '../src/wire/inherit';
import {
  buildConnection,
  buildFrames,
  buildFromSpec,
  type Registry,
  type WireSpec,
} from '../src/wire/interpreter';
import { makeRegistry } from '../src/llm/wire-transforms';
import { AnthropicAdapter } from '../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../src/llm/providers/google/generate';
import { GoogleInteractionsAdapter } from '../src/llm/providers/google/interactions';
import { OpenAIResponsesAdapter } from '../src/llm/providers/openai/responses';
import { OpenAIAdapter } from '../src/llm/providers/openai/completions';
import { XAIAdapter } from '../src/llm/providers/xai/completions';
import { XAIResponsesAdapter } from '../src/llm/providers/xai/responses';
import { OpenRouterAdapter } from '../src/llm/providers/openrouter/completions';
import { OpenRouterResponsesAdapter } from '../src/llm/providers/openrouter/responses';
import { SHAPES, subjectsFrom, type Adapterish } from '../tests/unit/wire/wire-corpus';
import { MEDIA_SUITES, type MediaCase } from '../tests/unit/wire/media-corpus';
import {
  EMBED_CASES,
  XAI_MEDIA_CASES,
  OPENROUTER_MEDIA_CASES,
  REALTIME_CASES,
  BATCH_CASES,
  BATCH_REQUESTS,
  BATCH_ID,
  FILE_CASES,
  FILE_REMOTE_ID,
  type OrMediaCase,
  type XaiMediaCase,
} from '../tests/unit/wire/service-corpus';
import { OpenAIEmbeddingAdapter } from '../src/llm/providers/openai/embeddings';
import { OpenRouterEmbeddingAdapter } from '../src/llm/providers/openrouter/embeddings';
import { GoogleEmbeddingAdapter } from '../src/llm/providers/google/embeddings';
import { XAIMediaAdapter } from '../src/llm/providers/xai/media';
import { OpenRouterMediaAdapter } from '../src/llm/providers/openrouter/media';
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
import { AnthropicBatchAdapter } from '../src/llm/providers/anthropic/batch';
import { OpenAIBatchAdapter } from '../src/llm/providers/openai/batch';
import { GoogleBatchAdapter } from '../src/llm/providers/google/batch';
import { XAIBatchAdapter } from '../src/llm/providers/xai/batch';
import { AnthropicFileAdapter } from '../src/llm/providers/anthropic/files';
import { OpenAIFileAdapter } from '../src/llm/providers/openai/files';
import { GoogleFileAdapter } from '../src/llm/providers/google/files';
import { XAIFileAdapter } from '../src/llm/providers/xai/files';
import { FileAttachment } from '../src/plugins/files/attachment';
import type {
  AudioGenRequest,
  ImageEditRequest,
  ImageGenRequest,
  VideoGenRequest,
} from '../src/plugins/media/types';

const EMBED_ADAPTERS = {
  openai: new OpenAIEmbeddingAdapter({ apiKey: 'k' }),
  openrouter: new OpenRouterEmbeddingAdapter({ apiKey: 'k' }),
  google: new GoogleEmbeddingAdapter({ apiKey: 'k' }),
};
const xaiMedia = new XAIMediaAdapter({ apiKey: 'k' });
const orMedia = new OpenRouterMediaAdapter({ apiKey: 'k' });
const RT_AUDIT = {
  openai: {
    adapter: new OpenAIRealtimeAdapter({ apiKey: 'k' }),
    open: buildOpenAISessionUpdate,
    turn: buildOpenAITurnFrames,
  },
  google: {
    adapter: new GoogleRealtimeAdapter({ apiKey: 'k' }),
    open: buildGoogleSetupFrame,
    turn: buildGoogleTurnFrames,
  },
};
const BATCH_ADAPTERS = {
  anthropic: new AnthropicBatchAdapter({ apiKey: 'k' }),
  openai: new OpenAIBatchAdapter({ apiKey: 'k' }),
  google: new GoogleBatchAdapter({ apiKey: 'k', model: 'gemini-3-flash' }),
  xai: new XAIBatchAdapter({ apiKey: 'k' }),
};
const FILE_ADAPTERS = {
  anthropic: new AnthropicFileAdapter({ apiKey: 'k' }),
  openai: new OpenAIFileAdapter({ apiKey: 'k' }),
  google: new GoogleFileAdapter({ apiKey: 'k' }),
  xai: new XAIFileAdapter({ apiKey: 'k' }),
};
const AUDIT_ATTACHMENT = new FileAttachment({
  filename: 'note.txt',
  mimeType: 'text/plain',
  sizeBytes: 5,
  content: { type: 'buffer', mimeType: 'text/plain', data: new Uint8Array([104, 101, 108, 108, 111]) },
});
const SERVICE_RESPONSE = {
  id: 'x',
  name: 'x',
  uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc',
  file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc' },
  batch: { name: 'x' },
  output_file_id: 'file_out',
  data: [{ embedding: [0.1], b64_json: 'AAAA' }],
  files: [],
  embedding: { values: [0.1] },
  choices: [
    { message: { images: [{ image_url: { url: 'data:image/png;base64,AAAA' } }], audio: { data: 'AAAA' } } },
  ],
};

const runXaiMedia = (c: XaiMediaCase, fetch: never): Promise<unknown> =>
  c.kind === 'image'
    ? xaiMedia.generateImage(c.req as ImageGenRequest, fetch)
    : c.kind === 'imageEdit'
      ? xaiMedia.editImage(c.req as ImageEditRequest, fetch)
      : c.kind === 'audio'
        ? xaiMedia.generateAudio(c.req as AudioGenRequest, fetch)
        : xaiMedia.submitVideo(c.req as VideoGenRequest, fetch);

const runOrMedia = (c: OrMediaCase, fetch: never): Promise<unknown> =>
  c.kind === 'image'
    ? orMedia.generateImage(c.req as ImageGenRequest, fetch)
    : c.kind === 'imageEdit'
      ? orMedia.editImage(c.req as ImageEditRequest, fetch)
      : orMedia.generateAudio(c.req as AudioGenRequest, fetch);
import { mediaSpec } from '../src/wire/media-specs';
import { serviceSpec } from '../src/wire/service-specs';
import { retrievalSpec } from '../src/wire/retrieval-specs';
import { mcpSpec } from '../src/wire/mcp-specs';
import { mcpWireRegistry } from '../src/plugins/mcp/wire-rules';

const MEDIA_BASE: Record<string, string> = {
  openai: 'https://api.openai.com',
  google: 'https://generativelanguage.googleapis.com',
};

/** The pins the media adapters use. Kept beside them rather than imported so the
 *  audit measures the specs, not the adapter's opinion of which one applies. */
function mediaSpecIdFor(provider: string, c: MediaCase): string {
  if (provider === 'openai') {
    if (c.kind === 'image') {
      return c.model.startsWith('gpt-image-')
        ? 'openai/images.generations'
        : 'openai/images.generations@dall-e';
    }
    if (c.kind === 'imageEdit') return 'openai/images.edits';
    if (c.kind === 'audio') return 'openai/audio.speech';
    return 'openai/videos';
  }
  if (c.kind === 'image') {
    return c.model.startsWith('imagen')
      ? 'google/imagen@predict'
      : 'google/gemini-image@generateContent';
  }
  if (c.kind === 'imageEdit') return 'google/gemini-image-edit@generateContent';
  if (c.kind === 'audio') return 'google/gemini-tts@generateContent';
  return 'google/veo@predictLongRunning';
}

const SPEC_DIR = resolve(import.meta.dir, '../src/wire/specs');
const K = 'k';

const anthropic = new AnthropicAdapter({ apiKey: K });
const google = new GoogleAdapter({ apiKey: K });
const googleInteractions = new GoogleInteractionsAdapter({ apiKey: K });
const openaiResponses = new OpenAIResponsesAdapter({ apiKey: K });
const openaiCompletions = new OpenAIAdapter({ apiKey: K });

const adapters: Record<string, Record<string, Adapterish | undefined>> = {
  anthropic: { messages: anthropic },
  google: { generate: google, interactions: googleInteractions },
  openai: { responses: openaiResponses, completions: openaiCompletions },
  xai: {
    responses: new XAIResponsesAdapter({ apiKey: K }),
    completions: new XAIAdapter({ apiKey: K }),
  },
  openrouter: {
    responses: new OpenRouterResponsesAdapter({ apiKey: K }),
    completions: new OpenRouterAdapter({ apiKey: K }),
  },
};

// MCP composes two more rules onto the shared registry — `llm -> plugins` is a
// forbidden edge, so they cannot live in wire-transforms. The audit measures the
// composition the library actually builds; against the base alone the MCP specs
// would report as referencing code that does not exist.
const base = mcpWireRegistry(
  makeRegistry({
    anthropic,
    google,
    googleInteractions,
    openaiResponses,
    openaiCompletions,
    // OpenRouter's image_config rules call back into its media adapter, so the
    // audit needs that handle to reach them at all.
    openrouterMedia: new OpenRouterMediaAdapter({ apiKey: 'k' }),
  }),
);

// ── walk every shipped spec file ─────────────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.json')) out.push(p);
  }
  return out;
}
const specFiles = walk(SPEC_DIR);

/** Every registry name a spec references, under every key the interpreter reads.
 *
 *  The five forms are not interchangeable and a search for one finds none of the
 *  others: `pred` (conditions), `$call` (templates), `fn` (variant selectors),
 *  `call` (field / block / overlay), and bare strings inside `effects`. */
type Kind = 'predicates' | 'transforms' | 'builders' | 'effects';
const refs: Record<Kind, Map<string, string[]>> = {
  predicates: new Map(),
  transforms: new Map(),
  builders: new Map(),
  effects: new Map(),
};
const note = (kind: Kind, name: string, where: string) => {
  const m = refs[kind];
  if (!m.has(name)) m.set(name, []);
  const list = m.get(name) as string[];
  if (!list.includes(where)) list.push(where);
};

function scan(node: unknown, file: string, inBlock = false): void {
  if (Array.isArray(node)) {
    for (const x of node) scan(x, file, inBlock);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;

  if (typeof o.pred === 'string') note('predicates', o.pred, file);
  if (typeof o.$call === 'string') note('transforms', o.$call, file);
  if (typeof o.fn === 'string') note('transforms', o.fn, file);
  // `call` is a transform on a field/overlay and a builder on a block. Record it
  // under both rather than guessing: a name present in either registry is fine,
  // and the dynamic pass says which one actually ran.
  if (typeof o.call === 'string') {
    note('transforms', o.call, file);
    note('builders', o.call, file);
    note('effects', o.call, file);
  }
  if (Array.isArray(o.effects)) {
    for (const e of o.effects) if (typeof e === 'string') note('effects', e, file);
  }
  for (const v of Object.values(o)) scan(v, file, inBlock);
}

for (const f of specFiles) {
  scan(JSON.parse(readFileSync(f, 'utf8')), relative(SPEC_DIR, f).replaceAll('\\', '/'));
}

/** Registry entries the INTERPRETER calls by name, with no spec reference at all.
 *
 *  The first version of this audit missed these and reported `isFunctionTool` as
 *  unreferenced dead code. It is the opposite of dead: `evalCond` calls it from
 *  four places to implement the built-in `isFunctionTool` / `builtin` / `hasTool` /
 *  `hasFunctionTool` conditions, which five shipped specs rely on. No spec ever
 *  names it, so scanning specs alone cannot see it — and deleting it on that
 *  evidence would have broken every builtin-tool rule in the library.
 *
 *  Read out of the source rather than listed from memory, so a newly added
 *  hardcoded call cannot quietly reopen the same hole. */
const INTERPRETER_SRC = readFileSync(resolve(import.meta.dir, '../src/wire/interpreter.ts'), 'utf8');
const hardcoded = new Set<string>();
const HARDCODED_RE = /reg\.(transforms|builders|predicates|effects)\.([A-Za-z_]\w*)/g;
for (const m of INTERPRETER_SRC.matchAll(HARDCODED_RE)) {
  hardcoded.add(`${m[1]}.${m[2]}`);
  note(m[1] as Kind, m[2] as string, '<interpreter builtin>');
}

// ── static: does everything a spec names exist? ──────────────────────────────
const missing: string[] = [];
for (const kind of Object.keys(refs) as Kind[]) {
  for (const [name, where] of refs[kind]) {
    // `call` is recorded under three kinds; it only has to exist in one of them.
    const anywhere =
      name in base.transforms || name in base.builders || name in base.predicates || name in base.effects;
    if (!anywhere) missing.push(`${kind}.${name} — named in ${where.join(', ')}`);
  }
}

// ── dynamic: what actually fires when the corpus runs ────────────────────────
const fired = new Set<string>();
function recording(reg: Registry): Registry {
  const wrap = (kind: Kind) =>
    new Proxy(reg[kind] as Record<string, (...a: unknown[]) => unknown>, {
      get(target, prop: string) {
        const fn = target[prop];
        if (typeof fn !== 'function') return fn;
        return (...args: unknown[]) => {
          fired.add(`${kind}.${prop}`);
          return fn(...args);
        };
      },
    });
  return {
    transforms: wrap('transforms'),
    builders: wrap('builders'),
    predicates: wrap('predicates'),
    effects: wrap('effects'),
  } as Registry;
}
const recorded = recording(base);

const byId = WIRE_SPECS as unknown as Map<string, SpecDelta>;
const cache = new Map<string, WireSpec>();
const spec = (id: string): WireSpec => {
  let s = cache.get(id);
  if (!s) {
    s = resolveSpec(id, byId);
    cache.set(id, s);
  }
  return s;
};

const catalog = new ModelCatalog();
catalog.loadProviderDefaults();
const subjects = subjectsFrom(catalog.list() as ModelInfo[], adapters);

/** Spec rules that fired, from the interpreter's own coverage hook. */
const rulesFired = new Set<string>();
let builds = 0;
for (const s of subjects) {
  for (const shape of SHAPES) {
    buildFromSpec(
      spec(s.specId),
      shape.req(s.model) as never,
      recorded,
      s.flavor,
      (kind, name) => rulesFired.add(`${s.specId}|${kind}|${name}`),
    );
    builds++;
  }
}

// ── also drive the MEDIA corpus ──────────────────────────────────────────────
//
// Without this the audit reports the media transforms as never-fired even after
// `media-differential.test.ts` began executing them — an instrument that
// understates coverage is worse than none, because the gap it invents draws
// attention away from the gap that is real.
const mediaSpecIds = new Set<string>();
let mediaBuilds = 0;
for (const { provider, cases } of MEDIA_SUITES) {
  for (const c of cases) {
    const id = mediaSpecIdFor(provider, c);
    mediaSpecIds.add(id);
    try {
      buildFromSpec(
        mediaSpec(id),
        { ...c.req, model: c.model } as never,
        recorded,
        provider,
        (kind, name) => rulesFired.add(`${id}|${kind}|${name}`),
        { baseURL: MEDIA_BASE[provider], apiKey: K },
      );
      mediaBuilds++;
    } catch (e) {
      console.error(`media ${provider}/${c.name} (${id}) threw: ${(e as Error).message}`);
    }
  }
}

// ── also drive every SERVICE spec DIRECTLY ───────────────────────────────────
//
// Driving them through the adapters does not work: each adapter builds its OWN
// registry, so the proxy below never sees those calls and the audit reports live
// code as never-fired. Executed here against the audit's registry instead, which
// is the only arrangement that can actually observe a transform running.
//
// The inputs are chosen to reach the GUARDED rules — a source image so the ref
// transforms fire, an image_config so its predicate is true, an audio frame so
// the realtime encoder runs. A spec driven only through its happy path measures
// nothing about the branches.
const OPENAI_B = 'https://api.openai.com';
const GOOGLE_B = 'https://generativelanguage.googleapis.com';
const ANTHROPIC_B = 'https://api.anthropic.com';
const XAI_B = 'https://api.x.ai';
const OR_B = 'https://openrouter.ai';
const A_CFG = { baseURL: ANTHROPIC_B, apiKey: 'k', apiVersion: '2023-06-01' };
const PNGSRC = { type: 'base64', mimeType: 'image/png', data: 'aGk=' };
const MP4SRC = { type: 'base64', mimeType: 'video/mp4', data: 'AAAAGGZ0' };

interface Drive {
  id: string;
  input: Record<string, unknown>;
  config: Record<string, unknown>;
  flavor?: string;
  op?: 'connect' | 'open' | 'send';
}

const SERVICE_DRIVES: Drive[] = [
  // embeddings — `asArray` lives here: one string must reach the wire as an array.
  { id: 'openai/embeddings', input: { model: 'm', input: 'hi' }, config: { baseURL: OPENAI_B, apiKey: 'k' } },
  { id: 'openai/embeddings', input: { model: 'm', input: ['a', 'b'] }, config: { baseURL: OPENAI_B, apiKey: 'k' } },
  { id: 'openrouter/embeddings', input: { model: 'm', input: 'hi' }, config: { baseURL: OR_B, apiKey: 'k' } },
  { id: 'google/embeddings', input: { model: 'm', text: 'hi' }, config: { baseURL: GOOGLE_B, apiKey: 'k' } },

  // xai media — the source-ref transforms only fire when a source is present.
  { id: 'xai/images.generations', input: { model: 'grok-2-image', prompt: 'a cat' }, config: { baseURL: XAI_B, apiKey: 'k' }, flavor: 'xai' },
  { id: 'xai/images.edits', input: { model: 'grok-2-image', prompt: 'hat', sourceImage: PNGSRC }, config: { baseURL: XAI_B, apiKey: 'k' }, flavor: 'xai' },
  { id: 'xai/tts', input: { model: 'grok-tts', input: 'hi', params: { voice: 'eve', format: 'wav' } }, config: { baseURL: XAI_B, apiKey: 'k' }, flavor: 'xai' },
  { id: 'xai/videos.generations', input: { model: 'grok-video', prompt: 'wave', sourceImage: PNGSRC }, config: { baseURL: XAI_B, apiKey: 'k' }, flavor: 'xai' },
  { id: 'xai/videos.extensions', input: { model: 'grok-video', prompt: 'more', sourceVideo: MP4SRC }, config: { baseURL: XAI_B, apiKey: 'k' }, flavor: 'xai' },
  { id: 'xai/videos.edits', input: { model: 'grok-video', prompt: 'night', sourceVideo: MP4SRC }, config: { baseURL: XAI_B, apiKey: 'k' }, flavor: 'xai' },

  // openrouter media — image_config appears only when a param asks for it.
  { id: 'openrouter/media.image', input: { model: 'm', prompt: 'a cat', params: { aspectRatio: '16:9', imageSize: '1K', strength: 0.5 } }, config: { baseURL: OR_B, apiKey: 'k' }, flavor: 'openrouter' },
  { id: 'openrouter/media.imageEdit', input: { model: 'm', prompt: 'hat', sourceImage: PNGSRC }, config: { baseURL: OR_B, apiKey: 'k' }, flavor: 'openrouter' },
  { id: 'openrouter/media.audio', input: { model: 'm', input: 'hi', params: { voice: 'alloy' } }, config: { baseURL: OR_B, apiKey: 'k' }, flavor: 'openrouter' },

  // batch — requestCount and xaiBatchName are both submit-time.
  { id: 'anthropic/batch.submit', input: { requests: BATCH_REQUESTS }, config: A_CFG },
  { id: 'anthropic/batch.getStatus', input: { batchId: BATCH_ID }, config: A_CFG },
  { id: 'anthropic/batch.getResults', input: { batchId: BATCH_ID }, config: A_CFG },
  { id: 'anthropic/batch.cancel', input: { batchId: BATCH_ID }, config: A_CFG },
  { id: 'openai/batch.uploadJsonl', input: { requests: BATCH_REQUESTS }, config: { baseURL: OPENAI_B, apiKey: 'k' } },
  { id: 'openai/batch.getStatus', input: { batchId: BATCH_ID }, config: { baseURL: OPENAI_B, apiKey: 'k' } },
  { id: 'openai/batch.getResults', input: { fileId: 'file_out' }, config: { baseURL: OPENAI_B, apiKey: 'k' } },
  { id: 'openai/batch.cancel', input: { batchId: BATCH_ID }, config: { baseURL: OPENAI_B, apiKey: 'k' } },
  { id: 'google/batch.submit', input: { requests: BATCH_REQUESTS }, config: { baseURL: GOOGLE_B, apiKey: 'k', model: 'gemini-3-flash' } },
  { id: 'google/batch.getStatus', input: { batchId: BATCH_ID }, config: { baseURL: GOOGLE_B, apiKey: 'k' } },
  { id: 'google/batch.getResults', input: { batchId: BATCH_ID }, config: { baseURL: GOOGLE_B, apiKey: 'k' } },
  { id: 'google/batch.cancel', input: { batchId: BATCH_ID }, config: { baseURL: GOOGLE_B, apiKey: 'k' } },
  { id: 'xai/batch.create', input: { requests: BATCH_REQUESTS }, config: { baseURL: XAI_B, apiKey: 'k' } },
  { id: 'xai/batch.addRequests', input: { batchId: BATCH_ID, requests: BATCH_REQUESTS }, config: { baseURL: XAI_B, apiKey: 'k' } },
  { id: 'xai/batch.getStatus', input: { batchId: BATCH_ID }, config: { baseURL: XAI_B, apiKey: 'k' } },
  { id: 'xai/batch.getResults', input: { batchId: BATCH_ID }, config: { baseURL: XAI_B, apiKey: 'k' } },

  // files
  { id: 'anthropic/files.upload', input: {}, config: A_CFG },
  { id: 'anthropic/files.delete', input: { remoteId: 'f' }, config: A_CFG },
  { id: 'anthropic/files.getInfo', input: { remoteId: 'f' }, config: A_CFG },
  { id: 'anthropic/files.list', input: {}, config: A_CFG },
  { id: 'openai/files.upload', input: {}, config: { baseURL: OPENAI_B, apiKey: 'k' } },
  { id: 'openai/files.delete', input: { remoteId: 'f' }, config: { baseURL: OPENAI_B, apiKey: 'k' } },
  { id: 'openai/files.getInfo', input: { remoteId: 'f' }, config: { baseURL: OPENAI_B, apiKey: 'k' } },
  { id: 'openai/files.list', input: {}, config: { baseURL: OPENAI_B, apiKey: 'k' } },
  { id: 'xai/files.upload', input: {}, config: { baseURL: XAI_B, apiKey: 'k' } },
  { id: 'google/files.startUpload', input: { filename: 'n.txt', mimeType: 'text/plain', byteLength: 5 }, config: { baseURL: GOOGLE_B, apiKey: 'k' } },
  { id: 'google/files.delete', input: { name: 'abc' }, config: { baseURL: GOOGLE_B, apiKey: 'k' } },
  { id: 'google/files.getInfo', input: { name: 'abc' }, config: { baseURL: GOOGLE_B, apiKey: 'k' } },
  { id: 'google/files.list', input: {}, config: { baseURL: GOOGLE_B, apiKey: 'k' } },

  // realtime — three operations; the audio and turn transforms only fire on send.
  { id: 'openai/realtime', input: { model: 'gpt-realtime' }, config: { apiKey: 'k' }, op: 'connect' },
  { id: 'openai/realtime', input: { model: 'gpt-realtime', modalities: ['text', 'audio'], voice: 'alloy', instructions: 'x' }, config: { apiKey: 'k' }, op: 'open' },
  { id: 'openai/realtime', input: { text: 'hi', audio: new Uint8Array([1, 2]), turnComplete: true }, config: { apiKey: 'k' }, op: 'send' },
  { id: 'google/realtime', input: { model: 'm' }, config: { wsBase: 'wss://x', apiVersion: 'v1beta', apiKey: 'k' }, op: 'connect' },
  { id: 'google/realtime', input: { model: 'm', modalities: ['audio'], voice: 'Kore', instructions: 'x' }, config: { wsBase: 'wss://x', apiVersion: 'v1beta', apiKey: 'k' }, op: 'open' },
  { id: 'google/realtime', input: { text: 'hi', audio: new Uint8Array([1, 2]), turnComplete: false }, config: { wsBase: 'wss://x', apiVersion: 'v1beta', apiKey: 'k' }, op: 'send' },
];

let serviceBuilds = 0;
const serviceFailures: string[] = [];
for (const d of SERVICE_DRIVES) {
  const spec = serviceSpec(d.id);
  const note = (kind: string, name: string) => rulesFired.add(`${d.id}|${kind}|${name}`);
  try {
    if (d.op === 'connect') buildConnection(spec, 'connect', d.input, recorded, d.config);
    else if (d.op) buildFrames(spec, d.op, d.input, recorded, d.config);
    else buildFromSpec(spec, d.input as never, recorded, d.flavor ?? spec.provider, note, d.config);
    serviceBuilds++;
  } catch (e) {
    serviceFailures.push(`${d.id}${d.op ? `/${d.op}` : ''}: ${(e as Error).message}`);
  }
}


// ── also drive every RETRIEVAL spec DIRECTLY ─────────────────────────────────
//
// Same reason as the service specs: the hosted backends build their own registry,
// so a transform firing inside one is invisible here. The inputs deliberately
// reach the GUARDED rules — a chunking object, an expiry, metadata (the only
// caller of googleCustomMetadata), a page token, and each search mode.
const XAI_MGMT_B = 'https://management-api.x.ai/v1';
const XAI_STD_B = 'https://api.x.ai/v1';
const OA_R = { baseURL: OPENAI_B, apiKey: 'k' };
const GG_R = { baseURL: GOOGLE_B, apiKey: 'k' };
const XAI_R = { baseURL: XAI_STD_B, managementBaseURL: XAI_MGMT_B, apiKey: 'k', managementApiKey: 'mk' };

const RETRIEVAL_DRIVES: Drive[] = [
  { id: 'openai/retrieval.createCorpus', input: { name: 'docs' }, config: OA_R },
  { id: 'openai/retrieval.createCorpus', input: { name: 'docs', chunking: { maxTokens: 400, overlapTokens: 100 }, expiresAfter: { anchor: 'last_active_at', days: 7 } }, config: OA_R },
  { id: 'openai/retrieval.uploadFile', input: {}, config: OA_R },
  { id: 'openai/retrieval.attachDocument', input: { corpusId: 'vs_1', fileId: 'f_1', metadata: { a: 1 } }, config: OA_R },
  { id: 'openai/retrieval.indexStatus', input: { corpusId: 'vs_1' }, config: OA_R },
  { id: 'openai/retrieval.removeDocument', input: { corpusId: 'vs_1', docId: 'f_1' }, config: OA_R },
  { id: 'openai/retrieval.deleteCorpus', input: { corpusId: 'vs_1' }, config: OA_R },
  { id: 'openai/retrieval.listCorpora', input: {}, config: OA_R },

  { id: 'google/retrieval.createCorpus', input: { name: 'docs' }, config: GG_R },
  { id: 'google/retrieval.createCorpus', input: { name: 'docs', embeddingModel: 'models/x' }, config: GG_R },
  { id: 'google/retrieval.uploadFile', input: {}, config: GG_R },
  { id: 'google/retrieval.importFile', input: { corpusId: 'fileSearchStores/s', fileName: 'files/f', metadata: { a: 1 }, text: 'hi' }, config: GG_R },
  { id: 'google/retrieval.pollOperation', input: { operationName: 'op/1' }, config: GG_R },
  { id: 'google/retrieval.indexStatus', input: { corpusId: 'fileSearchStores/s' }, config: GG_R },
  { id: 'google/retrieval.removeDocument', input: { docId: 'files/f' }, config: GG_R },
  { id: 'google/retrieval.deleteCorpus', input: { corpusId: 'fileSearchStores/s' }, config: GG_R },
  { id: 'google/retrieval.listCorpora', input: {}, config: GG_R },
  { id: 'google/retrieval.listCorpora', input: { pageToken: 'tok+1' }, config: GG_R },

  { id: 'xai/retrieval.createCorpus', input: { name: 'docs' }, config: XAI_R },
  { id: 'xai/retrieval.uploadFile', input: {}, config: XAI_R },
  { id: 'xai/retrieval.attachDocument', input: { corpusId: 'c_1', fileId: 'f_1', label: 'a.txt', metadata: { a: 1 } }, config: XAI_R },
  { id: 'xai/retrieval.indexStatus', input: { corpusId: 'c_1' }, config: XAI_R },
  { id: 'xai/retrieval.removeDocument', input: { corpusId: 'c_1', docId: 'f_1' }, config: XAI_R },
  { id: 'xai/retrieval.deleteCorpus', input: { corpusId: 'c_1' }, config: XAI_R },
  { id: 'xai/retrieval.listCorpora', input: {}, config: XAI_R },
  { id: 'xai/retrieval.search', input: { query: 'q', corpusIds: ['c_1'] }, config: XAI_R },
  { id: 'xai/retrieval.search', input: { query: 'q', corpusIds: ['c_1'], searchMode: 'keyword' }, config: XAI_R },
  { id: 'xai/retrieval.search', input: { query: 'q', corpusIds: ['c_1'], searchMode: 'semantic' }, config: XAI_R },
  { id: 'xai/retrieval.search', input: { query: 'q', corpusIds: ['c_1'], searchMode: 'telepathy' }, config: XAI_R },
];

let retrievalBuilds = 0;
const retrievalFailures: string[] = [];
for (const d of RETRIEVAL_DRIVES) {
  const spec = retrievalSpec(d.id);
  const note = (kind: string, name: string) => rulesFired.add(`${d.id}|${kind}|${name}`);
  try {
    buildFromSpec(spec, d.input as never, recorded, d.flavor ?? spec.provider, note, d.config);
    retrievalBuilds++;
  } catch (e) {
    retrievalFailures.push(`${d.id}: ${(e as Error).message}`);
  }
}


// ── also drive every MCP spec DIRECTLY ───────────────────────────────────────
//
// The transport builds its own composed registry, so the proxy cannot see inside
// it. The inputs reach the guarded rules: a modern era, a modern version with NO
// era (the discover probe), each of the three name-bearing methods, and a session
// on both wires.
const MCP_CFG = { url: 'https://mcp.example.com/mcp', headers: { 'x-tenant': 'acme' } };
const MODERN = '2026-07-28';

const OAUTH_ORIGIN = 'https://mcp.example.com';
const OAUTH_DRIVES: Drive[] = [
  { id: 'mcp-oauth/discover.oauth', input: {}, config: { origin: OAUTH_ORIGIN } },
  { id: 'mcp-oauth/discover.oidc', input: {}, config: { origin: OAUTH_ORIGIN } },
  { id: 'mcp-oauth/register', input: { registrationEndpoint: `${OAUTH_ORIGIN}/reg`, metadata: { client_name: 'x' } }, config: {} },
  { id: 'mcp-oauth/register', input: { registrationEndpoint: `${OAUTH_ORIGIN}/reg`, metadata: { client_name: 'x', application_type: 'web' } }, config: {} },
  { id: 'mcp-oauth/token.exchange', input: { tokenEndpoint: `${OAUTH_ORIGIN}/token`, code: 'c', code_verifier: 'v', client_id: 'id', redirect_uri: 'http://127.0.0.1/cb' }, config: {} },
  { id: 'mcp-oauth/token.exchange', input: { tokenEndpoint: `${OAUTH_ORIGIN}/token`, code: 'c', code_verifier: 'v', client_id: 'id', redirect_uri: 'http://127.0.0.1/cb', client_secret: 's', resource: 'r' }, config: {} },
  { id: 'mcp-oauth/token.refresh', input: { tokenEndpoint: `${OAUTH_ORIGIN}/token`, refresh_token: 'rt', client_id: 'id' }, config: {} },
  { id: 'mcp-oauth/token.refresh', input: { tokenEndpoint: `${OAUTH_ORIGIN}/token`, refresh_token: 'rt', client_id: 'id', client_secret: 's' }, config: {} },
  { id: 'mcp-oauth/authorize', input: { authorizationEndpoint: `${OAUTH_ORIGIN}/authorize`, client_id: 'id', redirect_uri: 'http://127.0.0.1/cb', code_challenge: 'ch' }, config: {} },
  { id: 'mcp-oauth/authorize', input: { authorizationEndpoint: `${OAUTH_ORIGIN}/authorize`, client_id: 'id', redirect_uri: 'http://127.0.0.1/cb', code_challenge: 'ch', scope: 's', state: 'st', resource: 'r' }, config: {} },
];

const MCP_DRIVES: Drive[] = [
  { id: 'mcp/http.request', input: { id: 1, method: 'tools/list', era: 'handshake' }, config: MCP_CFG },
  { id: 'mcp/http.request', input: { id: 2, method: 'tools/list', era: 'handshake', sessionId: 's1', protocolVersion: '2025-11-25' }, config: MCP_CFG },
  { id: 'mcp/http.request', input: { id: 3, method: 'tools/call', params: { name: 'search' }, era: 'modern', protocolVersion: MODERN }, config: MCP_CFG },
  { id: 'mcp/http.request', input: { id: 4, method: 'prompts/get', params: { name: 'p' }, era: 'modern', protocolVersion: MODERN }, config: MCP_CFG },
  { id: 'mcp/http.request', input: { id: 5, method: 'resources/read', params: { uri: 'file:///x' }, era: 'modern', protocolVersion: MODERN }, config: MCP_CFG },
  { id: 'mcp/http.request', input: { id: 6, method: 'tools/call', params: { name: 'поиск' }, era: 'modern', protocolVersion: MODERN }, config: MCP_CFG },
  // The probe: modern by DECLARED version while the era is still handshake.
  { id: 'mcp/http.request', input: { id: 7, method: 'server/discover', era: 'handshake', protocolVersion: MODERN }, config: MCP_CFG },
  // A modern session id must NOT be echoed back.
  { id: 'mcp/http.request', input: { id: 8, method: 'tools/list', era: 'modern', protocolVersion: MODERN, sessionId: 's1' }, config: MCP_CFG },
  { id: 'mcp/http.notify', input: { method: 'notifications/initialized', era: 'handshake' }, config: MCP_CFG },
  { id: 'mcp/http.longLived', input: { id: 9, method: 'subscriptions/listen', params: { filter: {} }, era: 'modern', protocolVersion: MODERN }, config: MCP_CFG },
  { id: 'mcp/http.message', input: { message: { jsonrpc: '2.0', id: 1, result: {} }, era: 'handshake' }, config: MCP_CFG },
  { id: 'mcp/http.events', input: { era: 'handshake' }, config: MCP_CFG },
  { id: 'mcp/http.events', input: { era: 'handshake', lastEventId: 'ev-1' }, config: MCP_CFG },
  { id: 'mcp/http.close', input: { era: 'handshake', sessionId: 's1' }, config: MCP_CFG },
  // Auth headers arrive resolved, and must beat everything the spec set before them.
  { id: 'mcp/http.request', input: { id: 10, method: 'tools/list', era: 'handshake', authHeaders: { authorization: 'Bearer t' } }, config: MCP_CFG },
];

let mcpBuilds = 0;
const mcpFailures: string[] = [];
for (const d of [...MCP_DRIVES, ...OAUTH_DRIVES]) {
  const spec = mcpSpec(d.id);
  const note = (kind: string, name: string) => rulesFired.add(`${d.id}|${kind}|${name}`);
  try {
    buildFromSpec(spec, d.input as never, recorded, d.flavor ?? spec.provider, note, d.config);
    mcpBuilds++;
  } catch (e) {
    mcpFailures.push(`${d.id}: ${(e as Error).message}`);
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const CHAT = new Set(subjects.map((s) => s.specId));
const line = (s: string) => console.log(s);

line(`specs on disk        : ${specFiles.length}`);
line(`interpreter builtins : ${hardcoded.size}  (${[...hardcoded].sort().join(', ')})`);
line(`specs driven here    : ${CHAT.size}  (${[...CHAT].sort().join(', ')})`);
line(`chat builds          : ${builds}  (${subjects.length} subjects x ${SHAPES.length} shapes)`);
line(`media builds         : ${mediaBuilds}  (${mediaSpecIds.size} media specs driven)`);
line(`service builds       : ${serviceBuilds}/${SERVICE_DRIVES.length} service specs driven`);
for (const f of serviceFailures) line(`  DRIVE FAILED  ${f}`);
line(`retrieval builds     : ${retrievalBuilds}/${RETRIEVAL_DRIVES.length} retrieval specs driven`);
for (const f of retrievalFailures) line(`  DRIVE FAILED  ${f}`);
line(`mcp builds           : ${mcpBuilds}/${MCP_DRIVES.length + OAUTH_DRIVES.length} mcp + oauth specs driven`);
for (const f of mcpFailures) line(`  DRIVE FAILED  ${f}`);
line('');

if (missing.length) {
  line(`NAMED BUT MISSING (${missing.length}) — these throw at runtime:`);
  for (const m of missing) line(`  ${m}`);
} else {
  line('NAMED BUT MISSING: none — every name any spec uses exists in the registry');
}
line('');

for (const kind of ['predicates', 'transforms', 'builders', 'effects'] as Kind[]) {
  const all = Object.keys(base[kind]).sort();
  const unref = all.filter((n) => !refs[kind].has(n) && !refs.transforms.has(n));
  const refdNotFired = all.filter(
    (n) => (refs[kind].has(n) || refs.transforms.has(n)) && !fired.has(`${kind}.${n}`),
  );
  line(`${kind}: ${all.length} defined`);
  line(`  unreferenced by ANY spec  (${unref.length}): ${unref.join(', ') || '-'}`);
  line(`  referenced, never fired   (${refdNotFired.length}): ${refdNotFired.join(', ') || '-'}`);
}
line('');
const stillDark = ['predicates', 'transforms', 'builders', 'effects'].some((k) =>
  Object.keys(base[k as Kind]).some((n) => !fired.has(`${k}.${n}`)),
);
line(
  stillDark
    ? 'Some named code is referenced but never executed. That is a COVERAGE gap, not dead code: it looks covered and is not.'
    : 'Every named piece of code any spec can reach was EXECUTED by this run.',
);

process.exit(missing.length ? 1 : 0);
