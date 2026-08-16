/** OpenAIAdapter (Chat Completions) unit tests. */

import { describe, expect, it } from 'bun:test';
import { OpenAIAdapter } from '../../../../src/llm/providers/openai/completions';
import type { NormalizedRequest } from '../../../../src/llm/types/request';
import type { StreamEvent } from '../../../../src/llm/types/stream';
import type { SSEEvent } from '../../../../src/network/types';

const baseReq: NormalizedRequest = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('OpenAIAdapter — static config', () => {
  it('sets bearer auth and content-type', () => {
    const a = new OpenAIAdapter({ apiKey: 'sk-xxx' });
    expect(a.authHeaders()).toEqual({
      authorization: 'Bearer sk-xxx',
      'content-type': 'application/json',
    });
  });

  it('default baseURL', () => {
    expect(new OpenAIAdapter({ apiKey: 'k' }).baseURL()).toBe('https://api.openai.com');
  });

  it('custom baseURL', () => {
    expect(new OpenAIAdapter({ apiKey: 'k', baseURL: 'https://custom' }).baseURL()).toBe(
      'https://custom',
    );
  });

  it('completionPath /v1/chat/completions', () => {
    expect(new OpenAIAdapter({ apiKey: 'k' }).completionPath()).toBe('/v1/chat/completions');
  });

  it('name openai', () => {
    expect(new OpenAIAdapter({ apiKey: 'k' }).name).toBe('openai');
  });
});

describe('OpenAIAdapter — audio input (gpt-audio)', () => {
  const audioReq: NormalizedRequest = {
    model: 'gpt-audio',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'audio', source: { type: 'base64', mimeType: 'audio/wav', data: 'QUJD' } },
          { type: 'text', text: 'Transcribe this.' },
        ],
      },
    ],
  };

  it('maps an audio part to input_audio with wav format', () => {
    const r = new OpenAIAdapter({ apiKey: 'k' }).buildRequest(audioReq);
    const content = (r.body.messages as Array<{ content: Array<{ type: string }> }>)[0].content;
    const audio = content.find((p) => p.type === 'input_audio') as unknown as {
      input_audio: { data: string; format: string };
    };
    expect(audio.input_audio).toEqual({ data: 'QUJD', format: 'wav' });
  });

  it('enables modalities + audio output when audio input is present', () => {
    const r = new OpenAIAdapter({ apiKey: 'k' }).buildRequest(audioReq);
    expect(r.body.modalities).toEqual(['text', 'audio']);
    expect(r.body.audio).toEqual({ voice: 'alloy', format: 'wav' });
  });

  it('orders the text part BEFORE input_audio (gpt-audio requirement)', () => {
    const r = new OpenAIAdapter({ apiKey: 'k' }).buildRequest(audioReq);
    const content = (r.body.messages as Array<{ content: Array<{ type: string }> }>)[0].content;
    expect(content.map((p) => p.type)).toEqual(['text', 'input_audio']);
  });

  it('reads the spoken reply from message.audio.transcript', () => {
    const a = new OpenAIAdapter({ apiKey: 'k' });
    const res = a.parseResponse(
      { id: 'x', model: 'gpt-audio', choices: [{ message: { audio: { transcript: 'Hello' } } }] },
      10,
    );
    expect(res.text).toBe('Hello');
  });

  it('surfaces spoken audio as an audio_output media part (not discarded)', () => {
    const a = new OpenAIAdapter({ apiKey: 'k' });
    const res = a.parseResponse(
      {
        id: 'x',
        model: 'gpt-audio',
        choices: [
          { message: { audio: { transcript: 'Hi', data: 'QUJD', format: 'mp3', id: 'au_1' } } },
        ],
      },
      10,
    );
    expect(res.text).toBe('Hi');
    const part = res.media.find((m) => m.type === 'audio_output');
    expect(part?.mimeType).toBe('audio/mp3');
    expect(part?._data).toBe('QUJD');
  });

  it('resolves a voice alias + format from req.audio', () => {
    const r = new OpenAIAdapter({ apiKey: 'k' }).buildRequest({
      ...audioReq,
      audio: { voice: 'warm', format: 'mp3' },
    });
    expect(r.body.audio).toEqual({ voice: 'coral', format: 'mp3' });
  });

  it('does not set modalities for a plain text request', () => {
    const r = new OpenAIAdapter({ apiKey: 'k' }).buildRequest(baseReq);
    expect(r.body.modalities).toBeUndefined();
    expect(r.body.audio).toBeUndefined();
  });

  it('maps a document part to a chat file part (pdf; used by openrouter)', () => {
    const r = new OpenAIAdapter({ apiKey: 'k' }).buildRequest({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', mimeType: 'application/pdf', data: 'JVBER' },
            },
            { type: 'text', text: 'summarize' },
          ],
        },
      ],
    });
    const content = (r.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
      .content;
    expect(content).toContainEqual({
      type: 'file',
      file: { filename: 'file.pdf', file_data: 'data:application/pdf;base64,JVBER' },
    });
  });
});

describe('OpenAIAdapter — buildRequest basics', () => {
  const a = new OpenAIAdapter({ apiKey: 'k' });

  it('emits model + messages + max_completion_tokens', () => {
    const r = a.buildRequest(baseReq);
    expect(r.body.model).toBe('gpt-4o-mini');
    expect(r.body.max_completion_tokens).toBe(4096);
    expect(r.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('prepends system message as role:system', () => {
    const r = a.buildRequest({ ...baseReq, system: 'You are helpful.' });
    expect(r.body.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('passes through max_tokens, temperature, top_p, stop', () => {
    const r = a.buildRequest({
      ...baseReq,
      maxTokens: 500,
      temperature: 0.7,
      topP: 0.95,
      stop: ['END'],
    });
    expect(r.body.max_completion_tokens).toBe(500);
    expect(r.body.temperature).toBe(0.7);
    expect(r.body.top_p).toBe(0.95);
    expect(r.body.stop).toEqual(['END']);
  });

  it('maps presence/frequency penalties (shared by xAI-completions + OpenRouter via inheritance)', () => {
    const r = a.buildRequest({ ...baseReq, presencePenalty: 0.5, frequencyPenalty: -0.3 });
    expect(r.body.presence_penalty).toBe(0.5);
    expect(r.body.frequency_penalty).toBe(-0.3);
  });

  it('omits penalties when not set', () => {
    const r = a.buildRequest(baseReq);
    expect(r.body.presence_penalty).toBeUndefined();
    expect(r.body.frequency_penalty).toBeUndefined();
  });
});

describe('OpenAIAdapter — tools', () => {
  const a = new OpenAIAdapter({ apiKey: 'k' });

  it('maps function tools to nested type:function shape', () => {
    const r = a.buildRequest({
      ...baseReq,
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object' },
          strict: true,
        },
      ],
    });
    expect(r.body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          // Strict also requires `additionalProperties: false`; sending `strict: true`
          // without it is rejected, so asking for strict now conforms the schema too.
          parameters: { type: 'object', additionalProperties: false },
          strict: true,
        },
      },
    ]);
  });

  it('skips builtin tools', () => {
    const r = a.buildRequest({
      ...baseReq,
      tools: [{ type: 'web_search' }, { name: 'fn', description: 'd', parameters: {} }],
    });
    expect((r.body.tools as unknown[]).length).toBe(1);
  });

  it('toolChoice string passes through', () => {
    expect(a.buildRequest({ ...baseReq, toolChoice: 'auto' }).body.tool_choice).toBe('auto');
    expect(a.buildRequest({ ...baseReq, toolChoice: 'none' }).body.tool_choice).toBe('none');
    expect(a.buildRequest({ ...baseReq, toolChoice: 'required' }).body.tool_choice).toBe(
      'required',
    );
  });

  it('named toolChoice → nested function', () => {
    const r = a.buildRequest({ ...baseReq, toolChoice: { name: 'foo' } });
    expect(r.body.tool_choice).toEqual({ type: 'function', function: { name: 'foo' } });
  });
});

describe('OpenAIAdapter — thinking and structured', () => {
  const a = new OpenAIAdapter({ apiKey: 'k' });

  it('thinking auto adds reasoning effort', () => {
    expect(a.buildRequest({ ...baseReq, thinking: { mode: 'auto' } }).body.reasoning).toEqual({
      effort: 'medium',
    });
  });

  it('thinking effort overrides default', () => {
    expect(
      a.buildRequest({ ...baseReq, thinking: { mode: 'auto', effort: 'high' } }).body.reasoning,
    ).toEqual({ effort: 'high' });
  });

  it('thinking off omits reasoning', () => {
    expect(
      a.buildRequest({ ...baseReq, thinking: { mode: 'off' } }).body.reasoning,
    ).toBeUndefined();
  });

  it('structured output → response_format json_schema', () => {
    const r = a.buildRequest({
      ...baseReq,
      structured: { schema: { type: 'object' }, name: 'foo' },
    });
    expect(r.body.response_format).toEqual({
      type: 'json_schema',
      // Strict is withheld here: `{ type: 'object' }` declares no `properties`, which
      // strict refuses ("object schema missing properties"), so the schema goes out as
      // given. Verified live — forcing strict on this shape returns 400, while strict
      // off returns the JSON object asked for.
      json_schema: { name: 'foo', schema: { type: 'object' }, strict: false },
    });
  });

  it('structured strict false honored', () => {
    const r = a.buildRequest({
      ...baseReq,
      structured: { schema: {}, strict: false },
    });
    expect(
      ((r.body.response_format as Record<string, unknown>).json_schema as Record<string, unknown>)
        .strict,
    ).toBe(false);
  });
});

describe('OpenAIAdapter — assistant tool_call message', () => {
  const a = new OpenAIAdapter({ apiKey: 'k' });

  it('serializes assistant tool_call as tool_calls array with stringified args', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling' },
            { type: 'tool_call', id: 'c1', name: 'lookup', arguments: { q: 'x' } },
          ],
        },
      ],
    });
    expect(r.body.messages).toEqual([
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
        ],
      },
    ]);
  });

  it('tool role becomes role:tool with tool_call_id', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'tool',
          content: [{ type: 'tool_result', id: 'c1', content: 'res' }],
        },
      ],
    });
    expect(r.body.messages).toEqual([{ role: 'tool', tool_call_id: 'c1', content: 'res' }]);
  });

  it('image_url part with base64 builds data: URL', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', mimeType: 'image/png', data: 'AAAA' },
              detail: 'high',
            },
          ],
        },
      ],
    });
    const msg = (r.body.messages as Array<Record<string, unknown>>)[0];
    expect(msg.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } },
    ]);
  });
});

describe('OpenAIAdapter — enableStreaming', () => {
  it('sets stream + stream_options.include_usage', () => {
    const a = new OpenAIAdapter({ apiKey: 'k' });
    const pr = a.buildRequest(baseReq);
    a.enableStreaming(pr, baseReq);
    const body = pr.body as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe('OpenAIAdapter — parseResponse', () => {
  const a = new OpenAIAdapter({ apiKey: 'k' });

  it('text-only completion', () => {
    const raw = {
      id: 'cmpl-1',
      model: 'gpt-4o-mini',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };
    const res = a.parseResponse(raw, 100);
    expect(res.text).toBe('hi');
    expect(res.finishReason).toBe('stop');
    expect(res.usage.inputTokens).toBe(5);
    expect(res.usage.outputTokens).toBe(3);
    expect(res.usage.totalTokens).toBe(8);
    expect(res.thinking).toBeNull();
  });

  it('tool_calls finish_reason → tool_use; arguments JSON-parsed', () => {
    const raw = {
      id: 'r',
      model: 'm',
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                function: { name: 'lookup', arguments: '{"q":"x"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.finishReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([
      { type: 'tool_call', id: 'call_1', name: 'lookup', arguments: { q: 'x' } },
    ]);
  });

  it('length finish_reason', () => {
    const raw = {
      id: 'r',
      model: 'm',
      choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
    };
    expect(a.parseResponse(raw, 0).finishReason).toBe('length');
  });

  it('content_filter finish_reason', () => {
    const raw = {
      id: 'r',
      model: 'm',
      choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
    };
    expect(a.parseResponse(raw, 0).finishReason).toBe('content_filter');
  });

  it('reasoning_content surfaced as thinking (deepseek/xai compat)', () => {
    const raw = {
      id: 'r',
      model: 'm',
      choices: [
        {
          message: { content: 'answer', reasoning_content: 'thoughts' },
          finish_reason: 'stop',
        },
      ],
    };
    expect(a.parseResponse(raw, 0).thinking).toBe('thoughts');
  });

  it('cached_tokens and reasoning_tokens parsed', () => {
    const raw = {
      id: 'r',
      model: 'm',
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 25 },
        completion_tokens_details: { reasoning_tokens: 20 },
      },
    };
    const u = a.parseResponse(raw, 0).usage;
    expect(u.cachedTokens).toBe(80);
    expect(u.cacheWriteTokens).toBe(25);
    expect(u.reasoningTokens).toBe(20);
  });
});

describe('OpenAIAdapter — parseStreamEvent', () => {
  const a = new OpenAIAdapter({ apiKey: 'k' });

  it('text delta emits text event', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'text', text: 'hi' }]);
  });

  // Upstream (openai-agents 0.13.5) fixed a bug where a trailing usage-LESS chunk from a
  // gateway/LiteLLM clobbered the accumulated usage. We never had it: a `usage` event is
  // emitted ONLY when the chunk actually carries usage, so the client's
  // `usage = event.usage` can never be handed an empty one. Locked here so it stays n/a.
  it('a usage-less chunk after the usage chunk emits no usage event', () => {
    const emitted = a.parseStreamEvent({
      data: JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'usage' });

    // trailing chunks carrying no usage must not emit a usage event at all
    expect(a.parseStreamEvent({ data: JSON.stringify({ choices: [] }) })).toEqual([]);
    expect(
      a
        .parseStreamEvent({ data: JSON.stringify({ choices: [{ delta: { content: 'x' } }] }) })
        .filter((e) => e.type === 'usage'),
    ).toEqual([]);
  });

  it('reasoning_content delta emits thinking event', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        choices: [{ delta: { reasoning_content: 'thinking...' } }],
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'thinking', text: 'thinking...' }]);
  });

  it('tool_call with name emits tool_call_start; with arguments emits tool_call_delta', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { id: 'c1', function: { name: 'lookup' } },
                { id: 'c1', function: { arguments: '{"q":' } },
              ],
            },
          },
        ],
      }),
    };
    const events = a.parseStreamEvent(evt);
    expect(events).toEqual([
      { type: 'tool_call_start', id: 'c1', name: 'lookup' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"q":' },
    ]);
  });

  const chunk = (toolCalls: unknown[]): SSEEvent => ({
    data: JSON.stringify({ choices: [{ delta: { tool_calls: toolCalls } }] }),
  });
  const idOf = (evts: StreamEvent[], pred: (e: Record<string, unknown>) => boolean) =>
    (evts.find((e) => pred(e as unknown as Record<string, unknown>)) as { id: string }).id;

  it('createStreamParser: real id is kept across chunks (arg fragment omits it), correlated by index', () => {
    const parse = a.createStreamParser();
    const c1 = parse(chunk([{ index: 0, id: 'call_real', function: { name: 'lookup' } }]));
    const c2 = parse(chunk([{ index: 0, function: { arguments: '{"q":1}' } }]));
    expect(c1).toEqual([{ type: 'tool_call_start', id: 'call_real', name: 'lookup' }]);
    expect(c2).toEqual([{ type: 'tool_call_delta', id: 'call_real', arguments: '{"q":1}' }]);
  });

  it('createStreamParser: id-less parallel calls get distinct synthesized ids (no collision)', () => {
    const parse = a.createStreamParser();
    // Two parallel calls, BOTH without ids (OpenAI-compatible backend), interleaved.
    const starts = parse(
      chunk([
        { index: 0, function: { name: 'foo' } },
        { index: 1, function: { name: 'bar' } },
      ]),
    );
    const deltas = parse(
      chunk([
        { index: 0, function: { arguments: '{"a":1}' } },
        { index: 1, function: { arguments: '{"b":2}' } },
      ]),
    );
    const id0 = idOf(starts, (e) => e.name === 'foo');
    const id1 = idOf(starts, (e) => e.name === 'bar');
    expect(id0).toMatch(/^call_/);
    expect(id1).toMatch(/^call_/);
    expect(id0).not.toBe(id1); // the bug was both colliding on ''
    // arg fragments carry the SAME synthesized id as their index's start
    expect(idOf(deltas, (e) => e.arguments === '{"a":1}')).toBe(id0);
    expect(idOf(deltas, (e) => e.arguments === '{"b":2}')).toBe(id1);
  });

  it('finish_reason tool_calls → done with tool_use', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'done', finishReason: 'tool_use' }]);
  });

  it('finish_reason content_filter → done with content_filter (not collapsed to stop)', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'done', finishReason: 'content_filter' }]);
  });

  it('usage-only chunk (include_usage)', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    };
    const events = a.parseStreamEvent(evt);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('usage');
  });

  it('empty delta → empty array', () => {
    const evt: SSEEvent = { data: JSON.stringify({ choices: [{ delta: {} }] }) };
    expect(a.parseStreamEvent(evt)).toEqual([]);
  });
});
