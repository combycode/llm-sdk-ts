/** Embeddings, xAI media and OpenRouter media still send what they sent before,
 *  and their specs reproduce it.
 *
 *  These adapters had no builder seam — the request was assembled inline and handed
 *  straight to `fetch`, so the only way to see one was to intercept the network.
 *  That is exactly what this does, through the PUBLIC method, which means it
 *  measures the adapter identically before and after the migration.
 *
 *  The fixture was frozen from the pre-migration commit
 *  (`tests/fixtures/service-golden.json`), so a green run here is evidence that the
 *  wire did not move — not merely that the spec and the current code agree.
 */

import { describe, expect, it } from 'bun:test';
import { OpenAIEmbeddingAdapter } from '../../../src/llm/providers/openai/embeddings';
import { OpenRouterEmbeddingAdapter } from '../../../src/llm/providers/openrouter/embeddings';
import { GoogleEmbeddingAdapter } from '../../../src/llm/providers/google/embeddings';
import { XAIMediaAdapter } from '../../../src/llm/providers/xai/media';
import { OpenRouterMediaAdapter } from '../../../src/llm/providers/openrouter/media';
import { AnthropicBatchAdapter } from '../../../src/llm/providers/anthropic/batch';
import { OpenAIBatchAdapter } from '../../../src/llm/providers/openai/batch';
import { GoogleBatchAdapter } from '../../../src/llm/providers/google/batch';
import { XAIBatchAdapter } from '../../../src/llm/providers/xai/batch';
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
} from './service-corpus';
import type {
  AudioGenRequest,
  ImageEditRequest,
  ImageGenRequest,
  VideoGenRequest,
} from '../../../src/plugins/media/types';
import {
  OpenAIRealtimeAdapter,
  buildOpenAISessionUpdate,
  buildOpenAITurnFrames,
} from '../../../src/llm/providers/openai/realtime';
import {
  GoogleRealtimeAdapter,
  buildGoogleSetupFrame,
  buildGoogleTurnFrames,
} from '../../../src/llm/providers/google/realtime';
import golden from '../../fixtures/service-golden.json' with { type: 'json' };

const K = 'k';

function capturing(response: unknown = {}) {
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
// canon FIRST: JSON.stringify would flatten a FormData to `{}` before canon ever
// saw it, which is how a multipart upload managed to compare unequal to itself.
const onWire = (v: unknown) => JSON.stringify(canon(v ?? null));

const index = golden.index as Record<string, unknown>;

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

const xai = new XAIMediaAdapter({ apiKey: K });
const XAI_RESPONSE = { data: [{ b64_json: 'AAAA' }], id: 'vid_1', request_id: 'vid_1' };
const orm = new OpenRouterMediaAdapter({ apiKey: K });
const OR_RESPONSE = {
  choices: [
    { message: { images: [{ image_url: { url: 'data:image/png;base64,AAAA' } }], audio: { data: 'AAAA' } } },
  ],
};

async function runXai(c: XaiMediaCase, fetch: never): Promise<unknown> {
  switch (c.kind) {
    case 'image':
      return xai.generateImage(c.req as ImageGenRequest, fetch);
    case 'imageEdit':
      return xai.editImage(c.req as ImageEditRequest, fetch);
    case 'audio':
      return xai.generateAudio(c.req as AudioGenRequest, fetch);
    default:
      return xai.submitVideo(c.req as VideoGenRequest, fetch);
  }
}

async function runOr(c: OrMediaCase, fetch: never): Promise<unknown> {
  switch (c.kind) {
    case 'image':
      return orm.generateImage(c.req as ImageGenRequest, fetch);
    case 'imageEdit':
      return orm.editImage(c.req as ImageEditRequest, fetch);
    default:
      return orm.generateAudio(c.req as AudioGenRequest, fetch);
  }
}

describe('the frozen service corpus is intact', () => {
  it('has an entry for every case', () => {
    const keys = [
      ...EMBED_CASES.map((c) => `embeddings/${c.provider}/${c.name}`),
      ...XAI_MEDIA_CASES.map((c) => `xai-media/${c.name}`),
      ...OPENROUTER_MEDIA_CASES.map((c) => `openrouter-media/${c.name}`),
    ];
    expect(keys.filter((k) => !(k in index))).toEqual([]);
    expect(keys.length).toBeGreaterThanOrEqual(18);
  });
});

describe('embeddings still send what was frozen', () => {
  it('openai, openrouter and google', async () => {
    const drift: string[] = [];
    for (const c of EMBED_CASES) {
      const { fetch, seen } = capturing(EMBED_RESPONSE);
      await EMBED_ADAPTERS[c.provider].embed(c.req, fetch);
      const key = `embeddings/${c.provider}/${c.name}`;
      const now = onWire(seen[0]);
      const was = onWire(index[key]);
      if (now !== was) drift.push(`${key}:\n    frozen: ${was}\n    now:    ${now}`);
    }
    expect(drift).toEqual([]);
  });
});

describe('xai media still sends what was frozen', () => {
  it('images, audio and the three video endpoints', async () => {
    const drift: string[] = [];
    for (const c of XAI_MEDIA_CASES) {
      const { fetch, seen } = capturing(XAI_RESPONSE);
      try {
        await runXai(c, fetch);
      } catch {
        /* the fake response may not parse; the request is already captured */
      }
      const key = `xai-media/${c.name}`;
      if (!seen.length) {
        drift.push(`${key}: no request made`);
        continue;
      }
      const now = onWire(seen[0]);
      const was = onWire(index[key]);
      if (now !== was) drift.push(`${key}:\n    frozen: ${was}\n    now:    ${now}`);
    }
    expect(drift.slice(0, 3)).toEqual([]);
  });
});

describe('openrouter media still sends what was frozen', () => {
  it('image, edit and audio', async () => {
    const drift: string[] = [];
    for (const c of OPENROUTER_MEDIA_CASES) {
      const { fetch, seen } = capturing(OR_RESPONSE);
      try {
        await runOr(c, fetch);
      } catch {
        /* as above */
      }
      const key = `openrouter-media/${c.name}`;
      if (!seen.length) {
        drift.push(`${key}: no request made`);
        continue;
      }
      const now = onWire(seen[0]);
      const was = onWire(index[key]);
      if (now !== was) drift.push(`${key}:\n    frozen: ${was}\n    now:    ${now}`);
    }
    expect(drift.slice(0, 3)).toEqual([]);
  });
});

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

describe('realtime still produces what was frozen', () => {
  it('connection descriptors, handshake frames and turn frames', () => {
    const drift: string[] = [];
    let compared = 0;
    for (const c of REALTIME_CASES) {
      const rt = RT[c.provider];
      const check = (key: string, got: unknown) => {
        compared++;
        const now = onWire(got);
        const was = onWire(index[key]);
        if (now !== was) drift.push(`${key}:
    frozen: ${was}
    now:    ${now}`);
      };
      const base = `realtime/${c.provider}/${c.name}`;
      check(`${base}/connect`, rt.adapter.buildConnectRequest(c.config as never));
      check(`${base}/open`, rt.open(c.config as never));
      for (const t of c.turns) {
        check(`${base}/turn.${t.name}`, rt.turn(t.input as never, { turnComplete: t.turnComplete }));
      }
    }
    expect({ compared: compared > 0, drift: drift.slice(0, 3) }).toEqual({ compared: true, drift: [] });
  });
});

const BATCH_ADAPTERS = {
  anthropic: new AnthropicBatchAdapter({ apiKey: K }),
  openai: new OpenAIBatchAdapter({ apiKey: K }),
  google: new GoogleBatchAdapter({ apiKey: K, model: 'gemini-3-flash' }),
  xai: new XAIBatchAdapter({ apiKey: K }),
};
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

describe('batch still sends what was frozen', () => {
  it('four providers, four different batching shapes', async () => {
    const drift: string[] = [];
    let compared = 0;
    for (const c of BATCH_CASES) {
      const a = BATCH_ADAPTERS[c.provider] as unknown as Record<
        string,
        (...x: never[]) => Promise<unknown>
      >;
      const { fetch, seen } = capturing(BATCH_RESPONSE);
      try {
        if (c.op === 'submit') await a.submit(BATCH_REQUESTS as never, fetch);
        else await a[c.op]?.(BATCH_ID as never, fetch);
      } catch {
        /* the fake response may not parse; the requests are already captured */
      }
      if (!seen.length) {
        drift.push(`batch/${c.provider}/${c.op}: no request made`);
        continue;
      }
      // Some operations make more than one call: OpenAI uploads a JSONL file then
      // creates the batch, xAI creates an empty batch then adds requests to it.
      seen.forEach((r, i) => {
        const key = `batch/${c.provider}/${c.op}${i ? `.${i}` : ''}`;
        compared++;
        const now = onWire(r);
        const was = onWire(index[key]);
        if (now !== was) drift.push(`${key}:\n    frozen: ${was}\n    now:    ${now}`);
      });
    }
    expect({ compared: compared > 0, drift: drift.slice(0, 3) }).toEqual({ compared: true, drift: [] });
  });
});
