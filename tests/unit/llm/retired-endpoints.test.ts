/** Two endpoints that are gone, and what the library does about it.
 *
 *  Both were settled by a live check on 2026-09-29, because SDK evidence alone
 *  cannot tell "deprecated in the types" from "still answering":
 *
 *    models/imagen-4.0-generate-001:predict -> 404, "not supported for predict"
 *    /v1/videos (GET and POST)              -> 404
 *
 *  The Imagen one mattered most: it was this library's DEFAULT image model, so
 *  the default Google image path 404'd. The Sora one is quieter and nastier —
 *  `sora-2` and `sora-2-pro` are STILL listed by /v1/models, so a catalog built
 *  from ListModels keeps reporting a model no endpoint serves.
 *
 *  Neither public function is removed (R7). They fail with a typed error that
 *  names the cause, instead of a bare 404. */

import { describe, expect, it } from 'bun:test';
import { GoogleMediaAdapter } from '../../../src/llm/providers/google/media';
import { OpenAIMediaAdapter } from '../../../src/llm/providers/openai/media';
import { LLMError } from '../../../src/network/errors';

const cfg = { apiKey: 'k' };

describe('Google image generation no longer defaults to a dead endpoint', () => {
  it('builds against a Gemini image model when the caller names none', () => {
    const req = new GoogleMediaAdapter(cfg).buildImageRequest({ prompt: 'a cube' } as never);
    expect(req.url).toContain('gemini-3.1-flash-image');
    expect(req.url).toContain('generateContent');
    expect(req.url).not.toContain('predict');
  });

  it('still honours a Gemini model the caller does name', () => {
    const req = new GoogleMediaAdapter(cfg).buildImageRequest({
      prompt: 'a cube',
      model: 'gemini-3-pro-image',
    } as never);
    expect(req.url).toContain('gemini-3-pro-image');
  });

  /** What a caller who NAMES an imagen model gets today: the `:predict` request,
   *  and Google's own 404 when it is sent.
   *
   *  Routing that to a typed refusal was tried and reverted — it breaks the
   *  frozen media corpus and the spec/adapter parity check, which both record
   *  the `:predict` envelope as this adapter's contract, and an Enterprise
   *  deployment can still reach it. The measurement stands; the decision does
   *  not belong to a test. */
  it('still builds the :predict envelope for an explicitly named imagen model', () => {
    const req = new GoogleMediaAdapter(cfg).buildImageRequest({
      prompt: 'a cube',
      model: 'imagen-4.0-generate-001',
    } as never);
    expect(req.url).toContain('predict');
  });

  /** An Enterprise deployment can still build the `:predict` envelope; only the
   *  Developer-API entry points refuse it. */
  it('leaves buildImagenRequest reachable for Enterprise callers', () => {
    const req = new GoogleMediaAdapter(cfg).buildImagenRequest({ prompt: 'a cube' } as never);
    expect(req.url).toContain('predict');
  });
});

describe('the Sora video endpoint', () => {
  it('reports the shutdown instead of returning an empty id on a 404', async () => {
    const adapter = new OpenAIMediaAdapter(cfg);
    const fetch404 = (async () => ({ status: 404, headers: {}, body: {} })) as never;
    let caught: unknown;
    try {
      await adapter.submitVideo({ prompt: 'a cube', model: 'sora-2' } as never, fetch404);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LLMError);
    expect((caught as LLMError).kind).toBe('unsupported');
    expect((caught as LLMError).message).toContain('2026-09-24');
    expect((caught as LLMError).message).toContain('sora-2');
  });

  // The old behaviour: a 404 produced `''`, which reads as a submitted job with
  // no id and fails later somewhere that cannot explain itself.
  it('does not return an empty id', async () => {
    const adapter = new OpenAIMediaAdapter(cfg);
    const fetch404 = (async () => ({ status: 404, headers: {}, body: {} })) as never;
    const result = await adapter
      .submitVideo({ prompt: 'x' } as never, fetch404)
      .catch(() => 'threw');
    expect(result).toBe('threw');
  });

  it('still submits normally when the endpoint answers', async () => {
    const adapter = new OpenAIMediaAdapter(cfg);
    const ok = (async () => ({ status: 200, headers: {}, body: { id: 'vid_1' } })) as never;
    expect(await adapter.submitVideo({ prompt: 'x' } as never, ok)).toBe('vid_1');
  });
});
