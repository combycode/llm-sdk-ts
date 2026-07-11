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

  it('service_tier: maps to xAI default|priority and omits values xAI rejects', () => {
    const a = new XAIResponsesAdapter({ apiKey: 'k' });
    const tier = (serviceTier?: string) =>
      a.buildRequest({ ...baseReq, serviceTier } as NormalizedRequest).body.service_tier;
    expect(tier('priority')).toBe('priority');
    expect(tier('standard')).toBe('default');
    // auto/flex/scale have no xAI equivalent → omitted (the inherited OpenAI map would 400).
    expect(tier('flex')).toBeUndefined();
    expect(tier('auto')).toBeUndefined();
    expect(tier('scale')).toBeUndefined();
    expect(tier(undefined)).toBeUndefined();
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

  it('inherits code-execution file producer from the OpenAI Responses adapter', () => {
    const a = new XAIResponsesAdapter({ apiKey: 'k' });
    const raw = {
      id: 'r',
      model: 'm',
      output: [{ type: 'code_interpreter_call', outputs: [{ type: 'image', url: 'https://x/i.png' }] }],
    };
    expect(a.parseResponse(raw, 0).files).toEqual([
      { url: 'https://x/i.png', source: 'code_execution' },
    ]);
  });

  it('requests include:code_interpreter_call.outputs when code_interpreter is used', () => {
    const a = new XAIResponsesAdapter({ apiKey: 'k' });
    const r = a.buildRequest({ ...baseReq, tools: [{ type: 'code_interpreter' }] });
    expect(r.body.include).toEqual(['code_interpreter_call.outputs']);
  });

  it('does NOT add include when no code_interpreter tool', () => {
    const a = new XAIResponsesAdapter({ apiKey: 'k' });
    const r = a.buildRequest({ ...baseReq, tools: [{ type: 'web_search' }] });
    expect(r.body.include).toBeUndefined();
  });

  it('extracts inline code-execution files from the logs JSON envelope', () => {
    const a = new XAIResponsesAdapter({ apiKey: 'k' });
    const logs = JSON.stringify({
      stdout: 'Plot saved\n',
      exit_code: 0,
      output_files: [
        { file_name: 'plot.png', mime_type: 'image/png', size: 4, data: [1, 2, 3, 4] },
      ],
    });
    const raw = {
      id: 'r',
      model: 'm',
      output: [{ type: 'code_interpreter_call', outputs: [{ type: 'logs', logs }] }],
    };
    const files = a.parseResponse(raw, 0).files;
    expect(files).toHaveLength(1);
    expect(files?.[0].name).toBe('plot.png');
    expect(files?.[0].mimeType).toBe('image/png');
    expect(files?.[0].source).toBe('code_execution');
    // Inline bytes → base64 → FileOutput.data (retrieved via the inline path).
    expect(typeof files?.[0].data).toBe('string');
  });

  it('ignores plain-text logs that are not the JSON envelope', () => {
    const a = new XAIResponsesAdapter({ apiKey: 'k' });
    const raw = {
      id: 'r',
      model: 'm',
      output: [{ type: 'code_interpreter_call', outputs: [{ type: 'logs', logs: 'hello stdout' }] }],
    };
    expect(a.parseResponse(raw, 0).files).toBeUndefined();
  });
});
