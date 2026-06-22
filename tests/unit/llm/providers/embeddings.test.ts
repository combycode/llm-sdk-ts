/** Embedding adapter unit tests — request shape + response parsing (no network). */

import { describe, expect, it } from 'bun:test';
import { GoogleEmbeddingAdapter } from '../../../../src/llm/providers/google/embeddings';
import { OpenAIEmbeddingAdapter } from '../../../../src/llm/providers/openai/embeddings';
import { OpenRouterEmbeddingAdapter } from '../../../../src/llm/providers/openrouter/embeddings';
import type { EngineFetch, HttpRequest, HttpResponse } from '../../../../src/network/types';

function fakeFetch(body: unknown): EngineFetch & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const fn = (async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    return { status: 200, headers: {}, body } as HttpResponse;
  }) as EngineFetch & { calls: HttpRequest[] };
  fn.calls = calls;
  return fn;
}

describe('OpenAIEmbeddingAdapter', () => {
  it('POSTs /v1/embeddings and parses data[].embedding + usage', async () => {
    const fetch = fakeFetch({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: 5 },
    });
    const r = await new OpenAIEmbeddingAdapter({ apiKey: 'k' }).embed(
      { model: 'text-embedding-3-small', input: 'hi' },
      fetch,
    );
    expect(fetch.calls[0].url).toBe('https://api.openai.com/v1/embeddings');
    expect(fetch.calls[0].body).toEqual({ model: 'text-embedding-3-small', input: ['hi'] });
    expect(r.embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(r.dimensions).toBe(3);
    expect(r.usage).toEqual({ inputTokens: 5 });
  });
});

describe('OpenRouterEmbeddingAdapter', () => {
  it('uses openrouter.ai/api/v1/embeddings', async () => {
    const fetch = fakeFetch({ data: [{ embedding: [1, 2] }] });
    const a = new OpenRouterEmbeddingAdapter({ apiKey: 'k' });
    await a.embed({ model: 'openai/text-embedding-3-small', input: 'hi' }, fetch);
    expect(fetch.calls[0].url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(a.name).toBe('openrouter');
  });
});

describe('GoogleEmbeddingAdapter', () => {
  it('POSTs :embedContent per input and parses embedding.values', async () => {
    const fetch = fakeFetch({ embedding: { values: [0.5, 0.6] } });
    const r = await new GoogleEmbeddingAdapter({ apiKey: 'k' }).embed(
      { model: 'gemini-embedding-001', input: ['hi'] },
      fetch,
    );
    expect(fetch.calls[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent',
    );
    expect(fetch.calls[0].body).toEqual({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: 'hi' }] },
    });
    expect(r.embeddings).toEqual([[0.5, 0.6]]);
    expect(r.dimensions).toBe(2);
  });
});
