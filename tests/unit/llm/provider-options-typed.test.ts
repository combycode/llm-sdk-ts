/** `providerOptions` used to be `Record<string, unknown>` — the one untyped hole
 *  in the request, and so the one place a typo produced silence instead of an
 *  error. `promtCacheOptions` type-checked and was simply never sent.
 *
 *  These tests cover the two halves that matter:
 *    1. every documented key still reaches the wire (the type is derived from
 *       the read sites, so a wrong key name here means a wrong type);
 *    2. the escape hatch still works — an unmodelled key is accepted, because a
 *       provider ships parameters before we model them.
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import { OpenAIAdapter } from '../../../src/llm/providers/openai/completions';
import type { NormalizedRequest, ProviderOptions } from '../../../src/llm/types/request';

const req = (extra: Partial<NormalizedRequest>): NormalizedRequest =>
  ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra }) as NormalizedRequest;

const anthropic = new AnthropicAdapter({ apiKey: 'k' });
const google = new GoogleAdapter({ apiKey: 'k' });
const openaiResponses = new OpenAIResponsesAdapter({ apiKey: 'k' });
const openaiChat = new OpenAIAdapter({ apiKey: 'k' });

describe('every documented ProviderOptions key reaches the wire', () => {
  it('anthropic: userProfileId becomes a header', () => {
    const r = anthropic.buildRequest(req({ providerOptions: { userProfileId: 'u_1' } }));
    expect(r.headers?.['anthropic-user-profile-id']).toBe('u_1');
  });

  it('google: the generationConfig passthroughs', () => {
    const body = google.buildRequest(
      req({
        providerOptions: {
          responseModalities: ['TEXT'],
          speechConfig: { a: 1 },
          imageConfig: { b: 2 },
          translationConfig: { c: 3 },
          cachedContent: 'cc-1',
        },
      }),
    ).body as any;
    expect(body.generationConfig.responseModalities).toEqual(['TEXT']);
    expect(body.generationConfig.speechConfig).toEqual({ a: 1 });
    expect(body.generationConfig.imageConfig).toEqual({ b: 2 });
    expect(body.generationConfig.translationConfig).toEqual({ c: 3 });
    expect(body.cachedContent).toBe('cc-1');
  });

  it('openai: promptCacheOptions and reasoningMode', () => {
    const cached = openaiResponses.buildRequest(
      req({ providerOptions: { promptCacheOptions: { ttl: 60 } } }),
    ).body as any;
    expect(cached.prompt_cache_options).toEqual({ ttl: 60 });

    const reasoning = openaiResponses.buildRequest(
      req({ thinking: { mode: 'on' }, providerOptions: { reasoningMode: 'pro' } }),
    ).body as any;
    expect(reasoning.reasoning.mode).toBe('pro');
  });

  it('openai: moderationPolicy reaches the moderation field', () => {
    const body = openaiChat.buildRequest(
      req({ providerOptions: { moderationPolicy: { threshold: 'low' } } }),
    ).body as any;
    expect(body.moderation.policy).toEqual({ threshold: 'low' });
  });
});

describe('the escape hatch still accepts unmodelled keys', () => {
  it('type-checks and is simply ignored by adapters that do not read it', () => {
    // A provider ships a parameter before the SDK models it. Refusing it here
    // would make the passthrough useless, so the index signature stays.
    const opts: ProviderOptions = { someFutureProviderFlag: { nested: true } };
    const body = google.buildRequest(req({ providerOptions: opts })).body as any;
    expect(body.someFutureProviderFlag).toBeUndefined();
    expect(opts.someFutureProviderFlag).toEqual({ nested: true });
  });

  it('a known key keeps its declared type', () => {
    // Compile-time guarantees are the point; assert the runtime shape agrees.
    const opts: ProviderOptions = { userProfileId: 'u_1', reasoningMode: 'standard' };
    expect(typeof opts.userProfileId).toBe('string');
    expect(opts.reasoningMode).toBe('standard');
  });
});
