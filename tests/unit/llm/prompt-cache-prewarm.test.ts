/** A response with no output is an empty answer, not a broken one.
 *
 *  `prompt_cache_options.prewarm: true` asks OpenAI to write the prompt cache
 *  and generate nothing — it overrides `generate` to false. What comes back is
 *  `status: 'completed'` with an **empty `output[]`**, which is a shape most of
 *  the parse path never sees: no message item, no text, no tool call.
 *
 *  That is the shape a finish-reason extractor gets wrong. Reporting it as a
 *  failure, or as `length`, would make a successful cache warm look like a
 *  broken request — and the caller would have no way to tell the difference
 *  from a real empty completion.
 *
 *  Measured 2026-09-30 on `gpt-5.6-terra`, which is also where the feature
 *  itself was confirmed: the prewarm call returned 0 output items and 0 cached
 *  tokens, and the next call on the same 4177-token prompt read 4174 from
 *  cache. The prompt carried a per-run nonce, so that hit can only have come
 *  from the prewarm.
 */

import { describe, expect, it } from 'bun:test';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import type { PromptCacheOptions } from '../../../src/llm/types/request';

const adapter = new OpenAIResponsesAdapter({ apiKey: 'k' });

/** The body OpenAI returns for a prewarm: completed, and empty. */
const PREWARMED = {
  id: 'resp_prewarm',
  object: 'response',
  status: 'completed',
  model: 'gpt-5.6-terra-2026-09-01',
  output: [],
  usage: {
    input_tokens: 4177,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 4174 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 4177,
  },
};

describe('a prewarm response', () => {
  it('parses as a finished, empty result', () => {
    const r = adapter.parseResponse(PREWARMED, 0);
    // `stop`, not `error` and not `length`: the request did exactly what it
    // was asked to do.
    expect(r.finishReason).toBe('stop');
    expect(r.text).toBe('');
    expect(r.content).toEqual([]);
    expect(r.toolCalls).toEqual([]);
  });

  it('reports no failure', () => {
    // The distinguishing check. An empty `output[]` must not be mistaken for
    // a provider error, or a successful cache warm reads as a broken call.
    expect(adapter.parseResponse(PREWARMED, 0).error).toBeUndefined();
  });

  it('still accounts the tokens it was billed for', () => {
    // A prewarm is not free: it pays for the input it wrote to the cache.
    const usage = adapter.parseResponse(PREWARMED, 0).usage;
    expect(usage.inputTokens).toBe(4177);
    expect(usage.outputTokens).toBe(0);
    expect(usage.cacheWriteTokens).toBe(4174);
  });
});

describe('the request side', () => {
  function body(providerOptions: Record<string, unknown>) {
    return adapter.buildRequest({
      model: 'gpt-5.6-terra',
      messages: [{ role: 'user', content: 'long prompt' }],
      providerOptions,
    } as never).body as Record<string, unknown>;
  }

  it('forwards prewarm to prompt_cache_options', () => {
    const opts: PromptCacheOptions = { prewarm: true, ttl: '30m' };
    expect(body({ promptCacheOptions: opts }).prompt_cache_options).toEqual({
      prewarm: true,
      ttl: '30m',
    });
  });

  it('sends nothing when the caller asked for nothing', () => {
    // `prompt_cache_options` is refused outright on a pre-5.6 model (measured
    // 2026-09-30: `400 prompt_cache_options is not supported on this model`),
    // so an empty object must not be sent on every request.
    expect(body({})).not.toHaveProperty('prompt_cache_options');
  });

  it('keeps a field the typed shape does not know', () => {
    const opts: PromptCacheOptions = { prewarm: true, some_future_knob: 7 };
    expect(body({ promptCacheOptions: opts }).prompt_cache_options).toEqual({
      prewarm: true,
      some_future_knob: 7,
    });
  });
});
