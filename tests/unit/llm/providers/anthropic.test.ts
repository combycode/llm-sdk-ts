/** AnthropicAdapter unit tests — buildRequest shape, parseResponse,
 *  parseStreamEvent, auth/baseURL/path. */

import { describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '../../../../src/llm/providers/anthropic/messages';
import type { NormalizedRequest } from '../../../../src/llm/types/request';
import type { SSEEvent } from '../../../../src/network/types';

const baseReq: NormalizedRequest = {
  model: 'claude-3-5-sonnet-latest',
  messages: [{ role: 'user', content: 'hello' }],
};

describe('AnthropicAdapter — static config', () => {
  it('returns auth headers with x-api-key + version + content-type', () => {
    const a = new AnthropicAdapter({ apiKey: 'sk-ant-xyz' });
    const h = a.authHeaders();
    expect(h['x-api-key']).toBe('sk-ant-xyz');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['content-type']).toBe('application/json');
  });

  it('uses default baseURL when none given', () => {
    expect(new AnthropicAdapter({ apiKey: 'k' }).baseURL()).toBe('https://api.anthropic.com');
  });

  it('uses custom baseURL when provided', () => {
    expect(new AnthropicAdapter({ apiKey: 'k', baseURL: 'https://custom.test' }).baseURL()).toBe(
      'https://custom.test',
    );
  });

  it('completionPath is /v1/messages', () => {
    expect(new AnthropicAdapter({ apiKey: 'k' }).completionPath()).toBe('/v1/messages');
  });

  it('name is anthropic', () => {
    expect(new AnthropicAdapter({ apiKey: 'k' }).name).toBe('anthropic');
  });
});

describe('AnthropicAdapter — buildRequest basics', () => {
  const a = new AnthropicAdapter({ apiKey: 'k' });

  it('emits model + max_tokens + messages', () => {
    const r = a.buildRequest(baseReq);
    expect(r.body.model).toBe('claude-3-5-sonnet-latest');
    expect(r.body.max_tokens).toBe(4096);
    expect(r.body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  });

  it('uses provided maxTokens', () => {
    const r = a.buildRequest({ ...baseReq, maxTokens: 100 });
    expect(r.body.max_tokens).toBe(100);
  });

  it('passes through temperature and top_p (renamed)', () => {
    const r = a.buildRequest({ ...baseReq, temperature: 0.5, topP: 0.9 });
    expect(r.body.temperature).toBe(0.5);
    expect(r.body.top_p).toBe(0.9);
  });

  it('passes stop as stop_sequences', () => {
    const r = a.buildRequest({ ...baseReq, stop: ['\n\n', 'END'] });
    expect(r.body.stop_sequences).toEqual(['\n\n', 'END']);
  });

  it('omits empty headers when no file refs present', () => {
    const r = a.buildRequest(baseReq);
    expect(r.headers).toEqual({});
  });
});

describe('AnthropicAdapter — system message handling', () => {
  const a = new AnthropicAdapter({ apiKey: 'k' });

  it('plain system as string when no cache', () => {
    const r = a.buildRequest({ ...baseReq, system: 'You are helpful.' });
    expect(r.body.system).toBe('You are helpful.');
  });

  it('system as cache block when cache="auto"', () => {
    const r = a.buildRequest({ ...baseReq, system: 'You are helpful.', cache: 'auto' });
    expect(r.body.system).toEqual([
      { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('system as cache block when cache.system=true', () => {
    const r = a.buildRequest({ ...baseReq, system: 'sys', cache: { system: true } });
    expect(r.body.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('system NOT cached when cache="off"', () => {
    const r = a.buildRequest({ ...baseReq, system: 'sys', cache: 'off' });
    expect(r.body.system).toBe('sys');
  });

  it('omits system when not provided', () => {
    const r = a.buildRequest(baseReq);
    expect(r.body.system).toBeUndefined();
  });
});

describe('AnthropicAdapter — document sources', () => {
  const a = new AnthropicAdapter({ apiKey: 'k' });
  const doc = (mimeType: string, data: string) =>
    a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'user',
          content: [{ type: 'document', source: { type: 'base64', mimeType, data } }],
        },
      ],
    });

  it('text/plain document → a `text` source with decoded text', () => {
    // 'YmFuYW5h' is base64 for 'banana'
    const r = doc('text/plain', 'YmFuYW5h');
    const block = (r.body.messages as Array<{ content: Array<{ source: unknown }> }>)[0].content[0];
    expect(block.source).toEqual({ type: 'text', media_type: 'text/plain', data: 'banana' });
  });

  it('application/pdf document → a base64 source (unchanged)', () => {
    const r = doc('application/pdf', 'JVBER');
    const block = (r.body.messages as Array<{ content: Array<{ source: unknown }> }>)[0].content[0];
    expect(block.source).toEqual({ type: 'base64', media_type: 'application/pdf', data: 'JVBER' });
  });
});

describe('AnthropicAdapter — tools', () => {
  const a = new AnthropicAdapter({ apiKey: 'k' });

  it('maps function tools to anthropic tool shape', () => {
    const r = a.buildRequest({
      ...baseReq,
      tools: [
        {
          name: 'get_weather',
          description: 'Get the weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    });
    expect(r.body.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Get the weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
  });

  it('maps the web_search builtin, skips other builtins', () => {
    const r = a.buildRequest({
      ...baseReq,
      tools: [
        { type: 'web_search' },
        { name: 'fn', description: 'd', parameters: {} },
        { type: 'image_generation' }, // unsupported builtin → skipped
      ],
    });
    const tools = r.body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools).toContainEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
    expect(tools.some((t) => t.name === 'fn' && !t.type)).toBe(true);
  });

  it('maps the code_interpreter builtin to anthropic hosted code_execution', () => {
    const r = a.buildRequest({ ...baseReq, tools: [{ type: 'code_interpreter' }] });
    const tools = r.body.tools as Array<Record<string, unknown>>;
    expect(tools).toContainEqual({ type: 'code_execution_20260521', name: 'code_execution' });
  });

  it('attaches cache_control to last function tool when cache.tools=true', () => {
    const r = a.buildRequest({
      ...baseReq,
      cache: { tools: true },
      tools: [
        { name: 'a', description: 'd', parameters: {} },
        { name: 'b', description: 'd', parameters: {} },
      ],
    });
    const tools = r.body.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('emits strict:true when tool.strict', () => {
    const r = a.buildRequest({
      ...baseReq,
      tools: [{ name: 't', description: 'd', parameters: {}, strict: true }],
    });
    expect((r.body.tools as Array<Record<string, unknown>>)[0].strict).toBe(true);
  });
});

describe('AnthropicAdapter — toolChoice', () => {
  const a = new AnthropicAdapter({ apiKey: 'k' });

  it('auto', () => {
    expect(a.buildRequest({ ...baseReq, toolChoice: 'auto' }).body.tool_choice).toEqual({
      type: 'auto',
    });
  });

  it('none', () => {
    expect(a.buildRequest({ ...baseReq, toolChoice: 'none' }).body.tool_choice).toEqual({
      type: 'none',
    });
  });

  it('required maps to "any"', () => {
    expect(a.buildRequest({ ...baseReq, toolChoice: 'required' }).body.tool_choice).toEqual({
      type: 'any',
    });
  });

  it('named tool choice', () => {
    expect(a.buildRequest({ ...baseReq, toolChoice: { name: 'foo' } }).body.tool_choice).toEqual({
      type: 'tool',
      name: 'foo',
    });
  });
});

describe('AnthropicAdapter — thinking', () => {
  const a = new AnthropicAdapter({ apiKey: 'k' });

  it('mode=auto enables thinking with a default budget', () => {
    const r = a.buildRequest({ ...baseReq, thinking: { mode: 'auto' } });
    expect(r.body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('effort maps to budget_tokens and lifts max_tokens above it', () => {
    const r = a.buildRequest({
      ...baseReq,
      thinking: { mode: 'auto', effort: 'high' },
      maxTokens: 512,
    });
    expect(r.body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(r.body.max_tokens).toBe(8192 + 1024); // lifted above the budget
  });

  it('mode=off omits thinking', () => {
    const r = a.buildRequest({ ...baseReq, thinking: { mode: 'off' } });
    expect(r.body.thinking).toBeUndefined();
  });
});

describe('AnthropicAdapter — structured output', () => {
  const a = new AnthropicAdapter({ apiKey: 'k' });

  it('adds output_config.format', () => {
    const r = a.buildRequest({
      ...baseReq,
      structured: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    });
    // additionalProperties:false is injected on object schemas (required by Anthropic).
    expect(r.body.output_config).toEqual({
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' } },
        },
      },
    });
  });

  it('thinking (budget) and structured (output_config) coexist independently', () => {
    const r = a.buildRequest({
      ...baseReq,
      thinking: { mode: 'auto', effort: 'low' },
      structured: { schema: { type: 'object' } },
    });
    // Thinking → budget_tokens; structured → output_config.format (additionalProperties injected).
    expect(r.body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(r.body.output_config).toEqual({
      format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false } },
    });
  });
});

describe('AnthropicAdapter — content parts', () => {
  const a = new AnthropicAdapter({ apiKey: 'k' });

  it('text part', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    const msg = (r.body.messages as Array<Record<string, unknown>>)[0];
    expect(msg.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('image base64', () => {
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
    const msg = (r.body.messages as Array<Record<string, unknown>>)[0];
    expect(msg.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('image url', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://x.test/y.png' } }],
        },
      ],
    });
    const msg = (r.body.messages as Array<Record<string, unknown>>)[0];
    expect(msg.content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://x.test/y.png' } },
    ]);
  });

  it('document with file ref → triggers beta header', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'file', fileId: 'file_abc' }, citations: true },
          ],
        },
      ],
    });
    expect(r.headers).toEqual({ 'anthropic-beta': 'files-api-2025-04-14' });
    const msg = (r.body.messages as Array<Record<string, unknown>>)[0];
    expect(msg.content).toEqual([
      {
        type: 'document',
        source: { type: 'file', file_id: 'file_abc' },
        citations: { enabled: true },
      },
    ]);
  });

  it('tool_call → tool_use', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'call_1', name: 'get', arguments: { x: 1 } }],
        },
      ],
    });
    const msg = (r.body.messages as Array<Record<string, unknown>>)[0];
    expect(msg.role).toBe('assistant');
    expect(msg.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'get', input: { x: 1 } }]);
  });

  it('tool_result with object content stringified', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'tool',
          content: [{ type: 'tool_result', id: 'call_1', content: 'temperature 70' }],
        },
      ],
    });
    const msg = (r.body.messages as Array<Record<string, unknown>>)[0];
    // tool role normalized to user
    expect(msg.role).toBe('user');
    expect(msg.content).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: 'temperature 70' },
    ]);
  });

  it('msg.cache=true attaches cache_control to last part', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
          cache: true,
        },
      ],
    });
    const msg = (r.body.messages as Array<Record<string, unknown>>)[0];
    const parts = msg.content as Array<Record<string, unknown>>;
    expect(parts[0].cache_control).toBeUndefined();
    expect(parts[1].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('AnthropicAdapter — enableStreaming', () => {
  const a = new AnthropicAdapter({ apiKey: 'k' });

  it('sets stream:true on body', () => {
    const pr = a.buildRequest(baseReq);
    a.enableStreaming(pr, baseReq);
    expect((pr.body as Record<string, unknown>).stream).toBe(true);
  });
});

describe('AnthropicAdapter — parseResponse', () => {
  const a = new AnthropicAdapter({ apiKey: 'k' });

  it('text-only response', () => {
    const raw = {
      id: 'msg_1',
      model: 'claude-3-5-sonnet-latest',
      content: [{ type: 'text', text: 'hello world' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const res = a.parseResponse(raw, 123);
    expect(res.id).toBe('msg_1');
    expect(res.model).toBe('claude-3-5-sonnet-latest');
    expect(res.text).toBe('hello world');
    expect(res.content).toEqual([{ type: 'text', text: 'hello world' }]);
    expect(res.finishReason).toBe('stop');
    expect(res.toolCalls).toEqual([]);
    expect(res.thinking).toBeNull();
    expect(res.latencyMs).toBe(123);
    expect(res.usage.inputTokens).toBe(10);
    expect(res.usage.outputTokens).toBe(5);
    expect(res.usage.totalTokens).toBe(15);
  });

  it('thinking + text', () => {
    const raw = {
      id: 'msg_2',
      model: 'm',
      content: [
        { type: 'thinking', thinking: 'let me think' },
        { type: 'text', text: 'answer' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    const res = a.parseResponse(raw, 0);
    expect(res.thinking).toBe('let me think');
    expect(res.text).toBe('answer');
  });

  it('tool_use → tool_call entry + toolCalls list', () => {
    const raw = {
      id: 'msg_3',
      model: 'm',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'x' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const res = a.parseResponse(raw, 0);
    expect(res.finishReason).toBe('tool_use');
    expect(res.content).toEqual([
      { type: 'tool_call', id: 'tu_1', name: 'lookup', arguments: { q: 'x' } },
    ]);
    expect(res.toolCalls).toEqual([
      { type: 'tool_call', id: 'tu_1', name: 'lookup', arguments: { q: 'x' } },
    ]);
  });

  it('max_tokens stop_reason → finishReason "length"', () => {
    const raw = {
      id: 'm',
      model: 'm',
      content: [{ type: 'text', text: 't' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    expect(a.parseResponse(raw, 0).finishReason).toBe('length');
  });

  it('parses cache_read and cache_creation tokens', () => {
    const raw = {
      id: 'm',
      model: 'm',
      content: [],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      },
    };
    const u = a.parseResponse(raw, 0).usage;
    expect(u.cachedTokens).toBe(80);
    expect(u.cacheWriteTokens).toBe(20);
  });

  it('handles missing usage gracefully', () => {
    const raw = {
      id: 'm',
      model: 'm',
      content: [{ type: 'text', text: 'x' }],
      stop_reason: 'end_turn',
    };
    const u = a.parseResponse(raw, 0).usage;
    expect(u.inputTokens).toBe(0);
    expect(u.outputTokens).toBe(0);
  });
});

describe('AnthropicAdapter — parseStreamEvent', () => {
  const a = new AnthropicAdapter({ apiKey: 'k' });

  it('ignores ping events', () => {
    expect(a.parseStreamEvent({ event: 'ping', data: '{}' } as SSEEvent)).toEqual([]);
  });

  it('text_delta → text event', () => {
    const evt: SSEEvent = {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hi' },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('thinking_delta → thinking event', () => {
    const evt: SSEEvent = {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'hmm' },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'thinking', text: 'hmm' }]);
  });

  it('input_json_delta → tool_call_delta event', () => {
    const evt: SSEEvent = {
      event: 'content_block_delta',
      data: JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"q"' },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([
      { type: 'tool_call_delta', id: '', arguments: '{"q"' },
    ]);
  });

  it('content_block_start with tool_use → tool_call_start', () => {
    const evt: SSEEvent = {
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tu_1', name: 'lookup' },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([
      { type: 'tool_call_start', id: 'tu_1', name: 'lookup' },
    ]);
  });

  it('message_delta with stop_reason → done event', () => {
    const evt: SSEEvent = {
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'done', finishReason: 'stop' }]);
  });

  it('message_delta tool_use stop → done with tool_use', () => {
    const evt: SSEEvent = {
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'done', finishReason: 'tool_use' }]);
  });

  it('message_delta with usage and stop emits usage + done', () => {
    const evt: SSEEvent = {
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
    };
    const events = a.parseStreamEvent(evt);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('usage');
    expect(events[1]).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('message_start with usage emits usage event', () => {
    const evt: SSEEvent = {
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: { id: 'm', usage: { input_tokens: 3, output_tokens: 0 } },
      }),
    };
    const events = a.parseStreamEvent(evt);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('usage');
  });

  it('unknown event type → empty array', () => {
    const evt: SSEEvent = { event: 'foo', data: JSON.stringify({ type: 'foo' }) };
    expect(a.parseStreamEvent(evt)).toEqual([]);
  });
});
