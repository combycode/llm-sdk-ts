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
import {
  EMBED_CASES,
  OPENROUTER_MEDIA_CASES,
  XAI_MEDIA_CASES,
  type OrMediaCase,
  type XaiMediaCase,
} from './service-corpus';
import type {
  AudioGenRequest,
  ImageEditRequest,
  ImageGenRequest,
  VideoGenRequest,
} from '../../../src/plugins/media/types';
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
