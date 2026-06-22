/** OpenAIResponsesAdapter unit tests — Responses API. */

import { describe, expect, it } from 'bun:test';
import { OpenAIResponsesAdapter } from '../../../../src/llm/providers/openai/responses';
import type { NormalizedRequest } from '../../../../src/llm/types/request';
import type { SSEEvent } from '../../../../src/network/types';

const baseReq: NormalizedRequest = {
  model: 'gpt-5',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('OpenAIResponsesAdapter — static config', () => {
  it('returns auth headers', () => {
    const a = new OpenAIResponsesAdapter({ apiKey: 'sk-xxx' });
    expect(a.authHeaders()).toEqual({
      authorization: 'Bearer sk-xxx',
      'content-type': 'application/json',
    });
  });

  it('completionPath /v1/responses', () => {
    expect(new OpenAIResponsesAdapter({ apiKey: 'k' }).completionPath()).toBe('/v1/responses');
  });

  it('name openai', () => {
    expect(new OpenAIResponsesAdapter({ apiKey: 'k' }).name).toBe('openai');
  });
});

describe('OpenAIResponsesAdapter — buildRequest basics', () => {
  const a = new OpenAIResponsesAdapter({ apiKey: 'k' });

  it('uses input array, NOT messages', () => {
    const r = a.buildRequest(baseReq);
    expect(r.body.input).toEqual([{ role: 'user', content: 'hi' }]);
    expect(r.body.messages).toBeUndefined();
  });

  it('system prompt → instructions', () => {
    const r = a.buildRequest({ ...baseReq, system: 'You are helpful.' });
    expect(r.body.instructions).toBe('You are helpful.');
  });

  it('previousResponseId → previous_response_id', () => {
    const r = a.buildRequest({ ...baseReq, previousResponseId: 'resp_123' });
    expect(r.body.previous_response_id).toBe('resp_123');
  });

  it('maxTokens → max_output_tokens', () => {
    const r = a.buildRequest({ ...baseReq, maxTokens: 1000 });
    expect(r.body.max_output_tokens).toBe(1000);
  });

  it('temperature and top_p passthrough', () => {
    const r = a.buildRequest({ ...baseReq, temperature: 0.4, topP: 0.8 });
    expect(r.body.temperature).toBe(0.4);
    expect(r.body.top_p).toBe(0.8);
  });
});

describe('OpenAIResponsesAdapter — buildInputItems variants', () => {
  const a = new OpenAIResponsesAdapter({ apiKey: 'k' });

  it('user content parts → input_text', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
    });
    expect(r.body.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'a' },
          { type: 'input_text', text: 'b' },
        ],
      },
    ]);
  });

  it('adds a container to the code_interpreter builtin', () => {
    const r = a.buildRequest({ ...baseReq, tools: [{ type: 'code_interpreter' }] });
    expect(r.body.tools).toEqual([{ type: 'code_interpreter', container: { type: 'auto' } }]);
  });

  it('document base64 → input_file WITH a filename (API requires it)', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', mimeType: 'text/plain', data: 'YmFu' } },
          ],
        },
      ],
    });
    expect(r.body.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_file', filename: 'file.txt', file_data: 'data:text/plain;base64,YmFu' },
        ],
      },
    ]);
  });

  it('image base64 → input_image with data URL', () => {
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
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
      },
    ]);
  });

  it('document provider_ref → input_file file_id', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'provider_ref', mimeType: 'application/pdf', refId: 'file_abc' },
            },
          ],
        },
      ],
    });
    expect(r.body.input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_file', file_id: 'file_abc' }],
      },
    ]);
  });

  it('assistant message + tool_call → message + function_call items', () => {
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
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'sure' }],
      },
      {
        type: 'function_call',
        id: 'fc_c1',
        call_id: 'c1',
        name: 'lookup',
        arguments: '{"q":"x"}',
      },
    ]);
  });

  it('tool_result → function_call_output', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'tool',
          content: [{ type: 'tool_result', id: 'c1', content: 'temp 70' }],
        },
      ],
    });
    expect(r.body.input).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: 'temp 70' },
    ]);
  });
});

describe('OpenAIResponsesAdapter — tools', () => {
  const a = new OpenAIResponsesAdapter({ apiKey: 'k' });

  it('function tool flat with strict default true; ensureAdditionalProperties applied', () => {
    const r = a.buildRequest({
      ...baseReq,
      tools: [
        {
          name: 'fn',
          description: 'd',
          parameters: { type: 'object', properties: { x: { type: 'string' } } },
        },
      ],
    });
    expect(r.body.tools).toEqual([
      {
        type: 'function',
        name: 'fn',
        description: 'd',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { x: { type: 'string' } },
        },
        strict: true,
      },
    ]);
  });

  it('builtin tool passes type+params', () => {
    const r = a.buildRequest({
      ...baseReq,
      tools: [{ type: 'web_search', params: { search_context_size: 'medium' } }],
    });
    expect(r.body.tools).toEqual([{ type: 'web_search', search_context_size: 'medium' }]);
  });

  it('toolChoice string passthrough', () => {
    expect(a.buildRequest({ ...baseReq, toolChoice: 'auto' }).body.tool_choice).toBe('auto');
  });

  it('named toolChoice → flat function', () => {
    const r = a.buildRequest({ ...baseReq, toolChoice: { name: 'foo' } });
    expect(r.body.tool_choice).toEqual({ type: 'function', name: 'foo' });
  });
});

describe('OpenAIResponsesAdapter — text format and reasoning', () => {
  const a = new OpenAIResponsesAdapter({ apiKey: 'k' });

  it('structured → text.format json_schema', () => {
    const r = a.buildRequest({
      ...baseReq,
      structured: { schema: { type: 'object' }, name: 'foo' },
    });
    // additionalProperties:false is injected (required by OpenAI strict json_schema).
    expect(r.body.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'foo',
        schema: { type: 'object', additionalProperties: false },
        strict: true,
      },
    });
  });

  it('thinking → reasoning effort + summary auto', () => {
    const r = a.buildRequest({ ...baseReq, thinking: { mode: 'auto', effort: 'low' } });
    expect(r.body.reasoning).toEqual({ effort: 'low', summary: 'auto' });
  });

  it('thinking off omits reasoning', () => {
    const r = a.buildRequest({ ...baseReq, thinking: { mode: 'off' } });
    expect(r.body.reasoning).toBeUndefined();
  });
});

describe('OpenAIResponsesAdapter — enableStreaming', () => {
  it('sets stream:true', () => {
    const a = new OpenAIResponsesAdapter({ apiKey: 'k' });
    const pr = a.buildRequest(baseReq);
    a.enableStreaming(pr);
    expect((pr.body as Record<string, unknown>).stream).toBe(true);
  });
});

describe('OpenAIResponsesAdapter — parseResponse', () => {
  const a = new OpenAIResponsesAdapter({ apiKey: 'k' });

  it('message + output_text', () => {
    const raw = {
      id: 'resp_1',
      model: 'gpt-5',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'hello' }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    const res = a.parseResponse(raw, 50);
    expect(res.id).toBe('resp_1');
    expect(res.text).toBe('hello');
    expect(res.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(res.finishReason).toBe('stop');
    expect(res.usage.inputTokens).toBe(5);
  });

  it('reasoning summary surfaced as thinking', () => {
    const raw = {
      id: 'r',
      model: 'm',
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'thinking...' }],
        },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'answer' }],
        },
      ],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.thinking).toBe('thinking...');
  });

  it('function_call → tool_call entries; finishReason tool_use', () => {
    const raw = {
      id: 'r',
      model: 'm',
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'c1',
          name: 'lookup',
          arguments: '{"q":"x"}',
        },
      ],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.finishReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'lookup', arguments: { q: 'x' } },
    ]);
  });

  it('image_generation_call → image_output media + content part', () => {
    const raw = {
      id: 'r',
      model: 'm',
      output: [
        {
          type: 'image_generation_call',
          result: 'BASE64DATA',
          output_format: 'png',
          revised_prompt: 'a cat',
        },
      ],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.media.length).toBe(1);
    expect(res.media[0]).toMatchObject({
      type: 'image_output',
      mimeType: 'image/png',
      revisedPrompt: 'a cat',
      _data: 'BASE64DATA',
    });
  });

  it('status incomplete → finishReason length when no toolCalls', () => {
    const raw = { id: 'r', model: 'm', status: 'incomplete', output: [] };
    expect(a.parseResponse(raw, 0).finishReason).toBe('length');
  });

  it('falls back to output_text convenience field', () => {
    const raw = { id: 'r', model: 'm', output: [], output_text: 'fallback' };
    const res = a.parseResponse(raw, 0);
    expect(res.text).toBe('fallback');
    expect(res.content).toEqual([{ type: 'text', text: 'fallback' }]);
  });

  it('parses cached and reasoning tokens', () => {
    const raw = {
      id: 'r',
      model: 'm',
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 70 },
        output_tokens_details: { reasoning_tokens: 30 },
      },
    };
    const u = a.parseResponse(raw, 0).usage;
    expect(u.cachedTokens).toBe(70);
    expect(u.reasoningTokens).toBe(30);
    expect(u.totalTokens).toBe(150);
  });
});

describe('OpenAIResponsesAdapter — parseStreamEvent', () => {
  const a = new OpenAIResponsesAdapter({ apiKey: 'k' });

  it('output_text.delta → text', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('function_call_arguments.delta → tool_call_delta', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        type: 'response.function_call_arguments.delta',
        call_id: 'c1',
        delta: '{"q"',
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([
      { type: 'tool_call_delta', id: 'c1', arguments: '{"q"' },
    ]);
  });

  it('output_item.added function_call → tool_call_start', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        type: 'response.output_item.added',
        item: { type: 'function_call', call_id: 'c1', name: 'lookup' },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([
      { type: 'tool_call_start', id: 'c1', name: 'lookup' },
    ]);
  });

  it('output_item.added image_generation_call → media_start', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        type: 'response.output_item.added',
        item: { type: 'image_generation_call' },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([
      { type: 'media_start', mediaType: 'image', mimeType: 'image/png' },
    ]);
  });

  it('image_generation_call.partial_image → media_chunk', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        type: 'response.image_generation_call.partial_image',
        partial_image: 'BASE64',
        partial_image_index: 1,
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'media_chunk', data: 'BASE64', progress: 1 }]);
  });

  it('output_item.done function_call → tool_call_end', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'c1' },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'tool_call_end', id: 'c1' }]);
  });

  it('output_item.done reasoning → thinking', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        type: 'response.output_item.done',
        item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thoughts' }] },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'thinking', text: 'thoughts' }]);
  });

  it('response.completed → usage + done', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    };
    const events = a.parseStreamEvent(evt);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('usage');
    expect(events[1]).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('response.completed status:incomplete → done length', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        type: 'response.completed',
        response: { status: 'incomplete' },
      }),
    };
    const events = a.parseStreamEvent(evt);
    expect(events).toEqual([{ type: 'done', finishReason: 'length' }]);
  });
});
