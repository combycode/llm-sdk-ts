/** topK / seed emission gating.
 *
 *  These two params are NOT universally accepted, and the failure mode is a hard 400 —
 *  so what matters is not that we send them, but that we send them ONLY where the wire
 *  takes them. Every expectation below mirrors a live probe run on 2026-07-28:
 *
 *              anthropic  openai-chat  openai-responses  google-gen  google-inter  xai-chat  xai-resp  openrouter-chat
 *    top_k        200         n/a           n/a             200         200          200       n/a         200
 *    seed         400         200           400             200         200          200       200         200
 */
import { describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '../../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../../src/llm/providers/google/generate';
import { GoogleInteractionsAdapter } from '../../../../src/llm/providers/google/interactions';
import { OpenAIAdapter } from '../../../../src/llm/providers/openai/completions';
import { OpenAIResponsesAdapter } from '../../../../src/llm/providers/openai/responses';
import { OpenRouterAdapter } from '../../../../src/llm/providers/openrouter/completions';
import { XAIAdapter } from '../../../../src/llm/providers/xai/completions';
import { XAIResponsesAdapter } from '../../../../src/llm/providers/xai/responses';
import type { NormalizedRequest } from '../../../../src/llm/types/request';

const req = (extra: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});
const body = (a: { buildRequest: (r: NormalizedRequest) => { body: unknown } }, r: NormalizedRequest) =>
  a.buildRequest(r).body as Record<string, unknown>;

describe('topK — emitted only where the wire accepts it', () => {
  it('anthropic sends top_k on models that still accept it', () => {
    for (const model of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']) {
      expect(body(new AnthropicAdapter({ apiKey: 'k' }), req({ model, topK: 5 })).top_k).toBe(5);
    }
  });

  // Anthropic DEPRECATED top_k: models after Opus 4.6 return 400 "`top_k` is deprecated for
  // this model" (live-verified 2026-07-29). Sending it would break the call outright, so the
  // gate is an ALLOW-list and anything unrecognised — including future models — is omitted.
  it('anthropic OMITS top_k on models that reject it', () => {
    for (const model of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']) {
      expect(body(new AnthropicAdapter({ apiKey: 'k' }), req({ model, topK: 5 })).top_k).toBeUndefined();
    }
  });

  it('anthropic omits top_k for an UNKNOWN model (fail-safe default)', () => {
    expect(body(new AnthropicAdapter({ apiKey: 'k' }), req({ model: 'claude-future-9', topK: 5 })).top_k).toBeUndefined();
  });

  it('google generateContent sends generationConfig.topK', () => {
    const b = body(new GoogleAdapter({ apiKey: 'k' }), req({ topK: 5 }));
    expect((b.generationConfig as Record<string, unknown>).topK).toBe(5);
  });

  it('google interactions sends generation_config.top_k', () => {
    const b = body(new GoogleInteractionsAdapter({ apiKey: 'k' }), req({ topK: 5 }));
    expect((b.generation_config as Record<string, unknown>).top_k).toBe(5);
  });

  it('xai + openrouter chat send top_k', () => {
    expect(body(new XAIAdapter({ apiKey: 'k' }), req({ topK: 5 })).top_k).toBe(5);
    expect(body(new OpenRouterAdapter({ apiKey: 'k' }), req({ topK: 5 })).top_k).toBe(5);
  });

  it('OpenAI NEVER sends top_k — it defines no such field', () => {
    expect(body(new OpenAIAdapter({ apiKey: 'k' }), req({ topK: 5 })).top_k).toBeUndefined();
    expect(body(new OpenAIResponsesAdapter({ apiKey: 'k' }), req({ topK: 5 })).top_k).toBeUndefined();
  });

  it('omitted when unset', () => {
    expect(body(new AnthropicAdapter({ apiKey: 'k' }), req({ model: 'claude-opus-4-6' })).top_k).toBeUndefined();
  });
});

describe('seed — emitted only where the wire accepts it', () => {
  it('openai chat-completions sends seed', () => {
    expect(body(new OpenAIAdapter({ apiKey: 'k' }), req({ seed: 42 })).seed).toBe(42);
  });

  it('openai RESPONSES never sends seed (live: 400 "Unknown parameter: seed")', () => {
    expect(body(new OpenAIResponsesAdapter({ apiKey: 'k' }), req({ seed: 42 })).seed).toBeUndefined();
  });

  it('xai sends seed on BOTH chat and responses', () => {
    expect(body(new XAIAdapter({ apiKey: 'k' }), req({ seed: 42 })).seed).toBe(42);
    expect(body(new XAIResponsesAdapter({ apiKey: 'k' }), req({ seed: 42 })).seed).toBe(42);
  });

  it('google sends seed on generateContent and interactions', () => {
    const g = body(new GoogleAdapter({ apiKey: 'k' }), req({ seed: 42 }));
    expect((g.generationConfig as Record<string, unknown>).seed).toBe(42);
    const i = body(new GoogleInteractionsAdapter({ apiKey: 'k' }), req({ seed: 42 }));
    expect((i.generation_config as Record<string, unknown>).seed).toBe(42);
  });

  it('anthropic NEVER sends seed (live: 400 "Extra inputs are not permitted")', () => {
    expect(body(new AnthropicAdapter({ apiKey: 'k' }), req({ seed: 42 })).seed).toBeUndefined();
  });

  it('openrouter chat sends seed', () => {
    expect(body(new OpenRouterAdapter({ apiKey: 'k' }), req({ seed: 42 })).seed).toBe(42);
  });
});
