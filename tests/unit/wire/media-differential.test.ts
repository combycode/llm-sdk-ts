/** The MEDIA specs must reproduce the media adapters, request for request.
 *
 *  Until this file existed, all 26 media specs were unexecuted data. The coverage
 *  audit is blunt about what that meant: sixteen transforms and two predicates in
 *  the registry were referenced by a spec and had never once run. Data that is
 *  never executed is data nobody has checked — and the two cases where that was
 *  true on the CHAT path both turned out to be real gaps.
 *
 *  So this drives every media spec against the frozen output of the hand-written
 *  adapters (`tests/fixtures/media-golden.json`, taken before any of them was
 *  migrated). It is the same contract the chat differential had, extended to the
 *  entry points the chat corpus structurally cannot reach: media requests never
 *  pass through `buildRequest(NormalizedRequest)`, and several return a whole
 *  envelope — url, method, response type — rather than a body.
 */

import { describe, expect, it } from 'bun:test';
import { OpenAIMediaAdapter } from '../../../src/llm/providers/openai/media';
import { GoogleMediaAdapter } from '../../../src/llm/providers/google/media';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import { OpenAIAdapter } from '../../../src/llm/providers/openai/completions';
import { makeRegistry } from '../../../src/llm/wire-transforms';
import { buildFromSpec, type WireSpec } from '../../../src/wire/interpreter';
import { resolveSpec, type SpecDelta } from '../../../src/wire/inherit';
import { WIRE_SPECS } from '../../../src/wire/registry';
import { MEDIA_SUITES, type MediaCase } from './media-corpus';
import golden from '../../fixtures/media-golden.json' with { type: 'json' };

const K = 'k';
const OPENAI_BASE = 'https://api.openai.com';
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com';

const openaiMedia = new OpenAIMediaAdapter({ apiKey: K });
const googleMedia = new GoogleMediaAdapter({ apiKey: K });

const reg = makeRegistry({
  anthropic: new AnthropicAdapter({ apiKey: K }),
  google: new GoogleAdapter({ apiKey: K }),
  openaiResponses: new OpenAIResponsesAdapter({ apiKey: K }),
  openaiCompletions: new OpenAIAdapter({ apiKey: K }),
});

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
const onWire = (v: unknown) => JSON.stringify(canon(JSON.parse(JSON.stringify(v ?? null))));

/** Which spec builds each case.
 *
 *  These are the pins a catalog would carry. Two of them fork by MODEL, and both
 *  forks are real wire differences rather than tidiness: dall-e still requires
 *  `response_format` where gpt-image-1 rejects it, and a Gemini image model goes to
 *  `generateContent` while Imagen goes to `predict` — a different endpoint, body
 *  and response shape. */
function specIdFor(provider: string, c: MediaCase): string {
  if (provider === 'openai') {
    switch (c.kind) {
      case 'image':
        return c.model.startsWith('gpt-image-')
          ? 'openai/images.generations'
          : 'openai/images.generations@dall-e';
      case 'imageEdit':
        return 'openai/images.edits';
      case 'audio':
        return 'openai/audio.speech';
      case 'video':
        return 'openai/videos';
    }
  }
  switch (c.kind) {
    case 'image':
      return c.model.startsWith('imagen')
        ? 'google/imagen@predict'
        : 'google/gemini-image@generateContent';
    case 'imageEdit':
      return 'google/gemini-image-edit@generateContent';
    case 'audio':
      return 'google/gemini-tts@generateContent';
    case 'video':
      return 'google/veo@predictLongRunning';
  }
}

const CONFIG: Record<string, Record<string, unknown>> = {
  openai: { baseURL: OPENAI_BASE, apiKey: K },
  google: { baseURL: GOOGLE_BASE, apiKey: K },
};

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

const adapters: Record<string, Record<string, (...a: never[]) => unknown>> = {
  openai: openaiMedia as unknown as Record<string, (...a: never[]) => unknown>,
  google: googleMedia as unknown as Record<string, (...a: never[]) => unknown>,
};

const build = (provider: string, c: MediaCase): unknown => {
  const fn = adapters[provider]?.[METHOD[provider]![c.kind]] as
    | ((r: unknown, m: string) => unknown)
    | undefined;
  if (!fn) throw new Error(`no ${provider} builder for ${c.kind}`);
  return fn.call(adapters[provider], c.req, c.model);
};

/** The parts of an adapter's request the SPEC is responsible for.
 *
 *  `provider`, `model` and `responseType` are engine metadata, not wire: the
 *  NetworkEngine routes and decodes with them and no provider ever sees them. The
 *  specs deliberately do not model them, so a migrated adapter keeps supplying them
 *  around the spec's output.
 *
 *  Filtering them out silently would hide a NEW adapter field, so the extras are
 *  asserted to be exactly this set rather than merely dropped. */
const ENGINE_META = ['model', 'provider', 'responseType'] as const;
const WIRE_KEYS = ['body', 'headers', 'method', 'multipart', 'noBody', 'path', 'url'];

const wireOnly = (v: unknown): unknown => {
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of WIRE_KEYS) if (o[k] !== undefined) out[k] = o[k];
  return out;
};

const extraKeys = (v: unknown): string[] =>
  Object.keys(v as Record<string, unknown>)
    .filter((k) => !WIRE_KEYS.includes(k))
    .sort();

const index = golden.index as Record<string, unknown>;

describe('the frozen media corpus is intact', () => {
  it('covers every case the corpus defines', () => {
    const missing: string[] = [];
    for (const { provider, cases } of MEDIA_SUITES) {
      for (const c of cases) if (!(`${provider}/${c.name}` in index)) missing.push(`${provider}/${c.name}`);
    }
    expect(missing).toEqual([]);
    expect(Object.keys(index).length).toBeGreaterThanOrEqual(21);
  });
});

describe('the media adapters still send what was frozen', () => {
  for (const { provider, cases } of MEDIA_SUITES) {
    it(provider, () => {
      const drift: string[] = [];
      for (const c of cases) {
        const was = onWire(index[`${provider}/${c.name}`]);
        const now = onWire(build(provider, c));
        if (now !== was) drift.push(`${c.name}:\n    frozen: ${was}\n    now:    ${now}`);
      }
      expect(drift.slice(0, 3)).toEqual([]);
    });
  }
});

describe('the media SPECS reproduce the media adapters', () => {
  for (const { provider, cases } of MEDIA_SUITES) {
    it(provider, () => {
      const drift: string[] = [];
      let compared = 0;
      for (const c of cases) {
        const id = specIdFor(provider, c);
        let built: string;
        try {
          // The model rides ON the request for the spec, exactly as it does for a
          // caller: the adapter takes it as a defaulted second argument, but the
          // envelope's URL template has only the request to read it from.
          built = onWire(
            buildFromSpec(
              spec(id),
              { ...c.req, model: c.model } as never,
              reg,
              provider,
              undefined,
              CONFIG[provider],
            ),
          );
        } catch (e) {
          drift.push(`${c.name} (${id}): spec threw ${(e as Error).message}`);
          continue;
        }
        compared++;
        const realFull = build(provider, c);
        // Anything the adapter adds beyond the wire must be known engine metadata.
        // A new key here means the spec is missing something, not that the diff is noise.
        const extras = extraKeys(realFull);
        if (extras.join(',') !== [...ENGINE_META].join(',')) {
          drift.push(`${c.name}: unexpected non-wire keys [${extras.join(', ')}]`);
        }
        const real = onWire(wireOnly(realFull));
        if (built !== real) {
          drift.push(`${c.name} (${id}):\n    adapter: ${real}\n    spec:    ${built}`);
        }
      }
      expect({ compared: compared > 0, drift: drift.slice(0, 3) }).toEqual({
        compared: true,
        drift: [],
      });
    });
  }
});
