/** xAI adapter unit tests — focuses on overrides relative to OpenAI parents. */

import { describe, expect, it } from 'bun:test';
import { XAIAdapter } from '../../../../src/llm/providers/xai/completions';
import { XAIResponsesAdapter } from '../../../../src/llm/providers/xai/responses';
import type { NormalizedRequest } from '../../../../src/llm/types/request';
import type { SSEEvent } from '../../../../src/network/types';

const baseReq: NormalizedRequest = {
  model: 'grok-4.20',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('XAIAdapter (Chat Completions)', () => {
  it('default baseURL is api.x.ai', () => {
    expect(new XAIAdapter({ apiKey: 'k' }).baseURL()).toBe('https://api.x.ai');
  });

  it('custom baseURL honored', () => {
    expect(new XAIAdapter({ apiKey: 'k', baseURL: 'https://custom' }).baseURL()).toBe(
      'https://custom',
    );
  });

  it('name is xai', () => {
    expect(new XAIAdapter({ apiKey: 'k' }).name).toBe('xai');
  });

  it('renames max_completion_tokens → max_tokens', () => {
    const a = new XAIAdapter({ apiKey: 'k' });
    const r = a.buildRequest({ ...baseReq, maxTokens: 500 });
    expect(r.body.max_tokens).toBe(500);
    expect(r.body.max_completion_tokens).toBeUndefined();
  });

  it('strips reasoning param (xAI uses model variant for reasoning)', () => {
    const a = new XAIAdapter({ apiKey: 'k' });
    const r = a.buildRequest({ ...baseReq, thinking: { mode: 'auto', effort: 'high' } });
    expect(r.body.reasoning).toBeUndefined();
  });

  it('parseResponse surfaces reasoning_content as thinking', () => {
    const a = new XAIAdapter({ apiKey: 'k' });
    const raw = {
      id: 'r1',
      model: 'grok-4.20-reasoning',
      choices: [
        {
          message: { content: 'answer', reasoning_content: 'because...' },
          finish_reason: 'stop',
        },
      ],
    };
    expect(a.parseResponse(raw, 0).thinking).toBe('because...');
  });

  it('stream reasoning_content delta produces a thinking event first', () => {
    const a = new XAIAdapter({ apiKey: 'k' });
    const evt: SSEEvent = {
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: 'thinking' } }],
      }),
    };
    const events = a.parseStreamEvent(evt);
    expect(events[0]).toEqual({ type: 'thinking', text: 'thinking' });
  });

  it('inherits OpenAI completions auth header shape', () => {
    expect(new XAIAdapter({ apiKey: 'xai-xxx' }).authHeaders()).toEqual({
      authorization: 'Bearer xai-xxx',
      'content-type': 'application/json',
    });
  });

  it('inherits chat/completions path', () => {
    expect(new XAIAdapter({ apiKey: 'k' }).completionPath()).toBe('/v1/chat/completions');
  });
});

describe('XAIResponsesAdapter', () => {
  it('default baseURL is api.x.ai', () => {
    expect(new XAIResponsesAdapter({ apiKey: 'k' }).baseURL()).toBe('https://api.x.ai');
  });

  it('moves system prompt from instructions into input role:system', () => {
    const a = new XAIResponsesAdapter({ apiKey: 'k' });
    const r = a.buildRequest({ ...baseReq, system: 'You are Grok.' });
    const input = r.body.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({ role: 'system', content: 'You are Grok.' });
    expect(r.body.instructions).toBeUndefined();
  });

  it('strips reasoning param for non-multi-agent models', () => {
    const a = new XAIResponsesAdapter({ apiKey: 'k' });
    const r = a.buildRequest({
      ...baseReq,
      model: 'grok-4.20',
      thinking: { mode: 'auto', effort: 'high' },
    });
    expect(r.body.reasoning).toBeUndefined();
  });

  it('keeps reasoning param for multi-agent variant', () => {
    const a = new XAIResponsesAdapter({ apiKey: 'k' });
    const r = a.buildRequest({
      ...baseReq,
      model: 'grok-4.20-multi-agent',
      thinking: { mode: 'auto', effort: 'high' },
    });
    expect(r.body.reasoning).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('inherits Responses path', () => {
    expect(new XAIResponsesAdapter({ apiKey: 'k' }).completionPath()).toBe('/v1/responses');
  });

  it('name is xai', () => {
    expect(new XAIResponsesAdapter({ apiKey: 'k' }).name).toBe('xai');
  });
});
