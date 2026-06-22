/** OpenRouter adapter unit tests — focuses on overrides relative to OpenAI parents. */

import { describe, expect, it } from 'bun:test';
import { OpenRouterAdapter } from '../../../../src/llm/providers/openrouter/completions';
import { OpenRouterResponsesAdapter } from '../../../../src/llm/providers/openrouter/responses';
import type { NormalizedRequest } from '../../../../src/llm/types/request';

const baseReq: NormalizedRequest = {
  model: 'anthropic/claude-3.5-sonnet',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('OpenRouterAdapter (Chat Completions)', () => {
  it('default baseURL openrouter.ai', () => {
    expect(new OpenRouterAdapter({ apiKey: 'k' }).baseURL()).toBe('https://openrouter.ai');
  });

  it('custom baseURL honored', () => {
    expect(new OpenRouterAdapter({ apiKey: 'k', baseURL: 'https://x.test' }).baseURL()).toBe(
      'https://x.test',
    );
  });

  it('completionPath /api/v1/chat/completions', () => {
    expect(new OpenRouterAdapter({ apiKey: 'k' }).completionPath()).toBe(
      '/api/v1/chat/completions',
    );
  });

  it('name openrouter', () => {
    expect(new OpenRouterAdapter({ apiKey: 'k' }).name).toBe('openrouter');
  });

  it('renames max_completion_tokens → max_tokens', () => {
    const a = new OpenRouterAdapter({ apiKey: 'k' });
    const r = a.buildRequest({ ...baseReq, maxTokens: 200 });
    expect(r.body.max_tokens).toBe(200);
    expect(r.body.max_completion_tokens).toBeUndefined();
  });

  it('maps the web_search builtin to the `:online` model suffix', () => {
    const a = new OpenRouterAdapter({ apiKey: 'k' });
    const r = a.buildRequest({
      ...baseReq,
      model: 'openai/gpt-4o',
      tools: [{ type: 'web_search' }],
    });
    expect(r.body.model).toBe('openai/gpt-4o:online');
    expect(r.body.tools).toBeUndefined(); // empty tools array dropped
  });

  it('passes through providerOptions.openrouter (e.g. routing prefs)', () => {
    const a = new OpenRouterAdapter({ apiKey: 'k' });
    const r = a.buildRequest({
      ...baseReq,
      providerOptions: {
        openrouter: { provider: { allow_fallbacks: true, order: ['anthropic'] } },
      },
    });
    expect(r.body.provider).toEqual({ allow_fallbacks: true, order: ['anthropic'] });
  });

  it('inherits OpenAI auth headers', () => {
    expect(new OpenRouterAdapter({ apiKey: 'or-xxx' }).authHeaders()).toEqual({
      authorization: 'Bearer or-xxx',
      'content-type': 'application/json',
    });
  });
});

describe('OpenRouterResponsesAdapter', () => {
  it('default baseURL openrouter.ai', () => {
    expect(new OpenRouterResponsesAdapter({ apiKey: 'k' }).baseURL()).toBe('https://openrouter.ai');
  });

  it('completionPath /api/v1/responses', () => {
    expect(new OpenRouterResponsesAdapter({ apiKey: 'k' }).completionPath()).toBe(
      '/api/v1/responses',
    );
  });

  it('name openrouter', () => {
    expect(new OpenRouterResponsesAdapter({ apiKey: 'k' }).name).toBe('openrouter');
  });

  it('passes through providerOptions.openrouter', () => {
    const a = new OpenRouterResponsesAdapter({ apiKey: 'k' });
    const r = a.buildRequest({
      ...baseReq,
      providerOptions: { openrouter: { transforms: ['middle-out'] } },
    });
    expect((r.body as Record<string, unknown>).transforms).toEqual(['middle-out']);
  });

  it('still uses input array (inherits Responses input shape)', () => {
    const a = new OpenRouterResponsesAdapter({ apiKey: 'k' });
    const r = a.buildRequest(baseReq);
    expect(r.body.input).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
