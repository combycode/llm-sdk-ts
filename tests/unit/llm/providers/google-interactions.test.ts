/** GoogleInteractionsAdapter unit tests. */

import { describe, expect, it } from 'bun:test';
import { GoogleInteractionsAdapter } from '../../../../src/llm/providers/google/interactions';
import type { NormalizedRequest } from '../../../../src/llm/types/request';
import type { SSEEvent } from '../../../../src/network/types';

const baseReq: NormalizedRequest = {
  model: 'gemini-2.5-pro',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('GoogleInteractionsAdapter — static config', () => {
  it('completionPath /v1beta/interactions', () => {
    expect(new GoogleInteractionsAdapter({ apiKey: 'k' }).completionPath()).toBe(
      '/v1beta/interactions',
    );
  });

  it('auth headers shape', () => {
    expect(new GoogleInteractionsAdapter({ apiKey: 'AIza-x' }).authHeaders()).toEqual({
      'x-goog-api-key': 'AIza-x',
      'content-type': 'application/json',
    });
  });
});

describe('GoogleInteractionsAdapter — buildRequest basics', () => {
  const a = new GoogleInteractionsAdapter({ apiKey: 'k' });

  it('uses input array; prepends models/ prefix', () => {
    const r = a.buildRequest(baseReq);
    expect(r.body.model).toBe('models/gemini-2.5-pro');
    expect(r.body.input).toEqual([{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('keeps "models/" prefix when already present', () => {
    const r = a.buildRequest({ ...baseReq, model: 'models/gemini-2.5-flash' });
    expect(r.body.model).toBe('models/gemini-2.5-flash');
  });

  it('system → system_instruction', () => {
    const r = a.buildRequest({ ...baseReq, system: 'You are helpful.' });
    expect(r.body.system_instruction).toBe('You are helpful.');
  });

  it('omits generation_config when no params set', () => {
    const r = a.buildRequest(baseReq);
    expect(r.body.generation_config).toBeUndefined();
  });

  it('generation_config with all params (renames to snake_case)', () => {
    const r = a.buildRequest({
      ...baseReq,
      maxTokens: 1024,
      temperature: 0.5,
      topP: 0.9,
      stop: ['END'],
    });
    expect(r.body.generation_config).toEqual({
      max_output_tokens: 1024,
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ['END'],
    });
  });
});

describe('GoogleInteractionsAdapter — content parts', () => {
  const a = new GoogleInteractionsAdapter({ apiKey: 'k' });

  it('image base64 → image with mime_type/data fields', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    });
    expect(r.body.input).toEqual([
      {
        type: 'user_input',
        content: [{ type: 'image', mime_type: 'image/png', data: 'AAAA' }],
      },
    ]);
  });

  it('image url → image with uri', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://x.test/y.png' } }],
        },
      ],
    });
    expect(r.body.input).toEqual([
      { type: 'user_input', content: [{ type: 'image', uri: 'https://x.test/y.png' }] },
    ]);
  });

  it('assistant text + tool_call → model_output with content items', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'sure' },
            { type: 'tool_call', id: 'c1', name: 'lookup', arguments: { q: 'x' } },
          ],
        },
      ],
    });
    expect(r.body.input).toEqual([
      {
        type: 'model_output',
        content: [
          { type: 'text', text: 'sure' },
          { type: 'function_call', id: 'c1', name: 'lookup', arguments: { q: 'x' } },
        ],
      },
    ]);
  });
});

describe('GoogleInteractionsAdapter — stateful chaining', () => {
  const a = new GoogleInteractionsAdapter({ apiKey: 'k' });

  it('no previousResponseId → full input, no previous_interaction_id', () => {
    const r = a.buildRequest(baseReq);
    expect(r.body.previous_interaction_id).toBeUndefined();
  });

  it('previousResponseId → previous_interaction_id + only the new (already-trimmed) turn', () => {
    // The server-state brain sets previousResponseId and trims req.messages to
    // the new turn; the adapter just maps it to previous_interaction_id.
    const r = a.buildRequest({
      ...baseReq,
      previousResponseId: 'int_abc',
      messages: [{ role: 'user', content: 'and now?' }],
    });
    expect(r.body.previous_interaction_id).toBe('int_abc');
    expect(r.body.input).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'and now?' }] },
    ]);
  });
});

describe('GoogleInteractionsAdapter — tools, thinking, structured', () => {
  const a = new GoogleInteractionsAdapter({ apiKey: 'k' });

  it('function tools mapped flat', () => {
    const r = a.buildRequest({
      ...baseReq,
      tools: [{ name: 'fn', description: 'd', parameters: {} }],
    });
    expect(r.body.tools).toEqual([
      { type: 'function', name: 'fn', description: 'd', parameters: {} },
    ]);
  });

  it('thinking effort → thinking_config.thinking_level', () => {
    const r = a.buildRequest({ ...baseReq, thinking: { mode: 'auto', effort: 'medium' } });
    expect((r.body.generation_config as Record<string, unknown>).thinking_config).toEqual({
      thinking_level: 'MEDIUM',
    });
  });

  it('structured → polymorphic text response_format', () => {
    const r = a.buildRequest({ ...baseReq, structured: { schema: { type: 'object' } } });
    expect(r.body.response_format).toEqual({
      type: 'text',
      mime_type: 'application/json',
      schema: { type: 'object' },
    });
  });
});

describe('GoogleInteractionsAdapter — parseResponse', () => {
  const a = new GoogleInteractionsAdapter({ apiKey: 'k' });

  it('text output', () => {
    const raw = {
      id: 'int_1',
      outputs: [{ type: 'text', text: 'hello' }],
      usage: { total_input_tokens: 5, total_output_tokens: 3, total_tokens: 8 },
    };
    const res = a.parseResponse(raw, 50);
    expect(res.id).toBe('int_1');
    expect(res.text).toBe('hello');
    expect(res.usage.totalTokens).toBe(8);
  });

  it('function_call output', () => {
    const raw = {
      id: 'int_2',
      outputs: [{ type: 'function_call', id: 'c1', name: 'lookup', arguments: { q: 'x' } }],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.finishReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'lookup', arguments: { q: 'x' } },
    ]);
  });

  it('image output → image_output media', () => {
    const raw = {
      id: 'int_3',
      outputs: [{ type: 'image', mime_type: 'image/png', data: 'B64' }],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.media.length).toBe(1);
    expect(res.media[0]).toMatchObject({
      type: 'image_output',
      mimeType: 'image/png',
      _data: 'B64',
    });
  });

  it('status:failed → error finishReason when no tool calls', () => {
    const raw = { id: 'int_4', outputs: [], status: 'failed' };
    expect(a.parseResponse(raw, 0).finishReason).toBe('error');
  });

  it('cached and thought tokens surface in usage', () => {
    const raw = {
      id: 'int_5',
      outputs: [],
      usage: {
        total_input_tokens: 100,
        total_output_tokens: 50,
        total_cached_tokens: 80,
        total_thought_tokens: 30,
      },
    };
    const u = a.parseResponse(raw, 0).usage;
    expect(u.cachedTokens).toBe(80);
    expect(u.reasoningTokens).toBe(30);
  });
});

describe('GoogleInteractionsAdapter — parseStreamEvent', () => {
  const a = new GoogleInteractionsAdapter({ apiKey: 'k' });

  it('content.delta text', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({ event_type: 'content.delta', delta: { type: 'text', text: 'hi' } }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('content.delta function_call → start + delta + end', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        event_type: 'content.delta',
        delta: { type: 'function_call', id: 'c1', name: 'lookup', arguments: { q: 'x' } },
      }),
    };
    const events = a.parseStreamEvent(evt);
    expect(events).toEqual([
      { type: 'tool_call_start', id: 'c1', name: 'lookup' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"q":"x"}' },
      { type: 'tool_call_end', id: 'c1' },
    ]);
  });

  it('interaction.complete success → usage + done', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        event_type: 'interaction.complete',
        interaction: {
          status: 'completed',
          usage: { total_input_tokens: 5, total_output_tokens: 3 },
        },
      }),
    };
    const events = a.parseStreamEvent(evt);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('usage');
    expect(events[1]).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('interaction.complete failed → done error', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        event_type: 'interaction.complete',
        interaction: { status: 'failed' },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'done', finishReason: 'error' }]);
  });
});
