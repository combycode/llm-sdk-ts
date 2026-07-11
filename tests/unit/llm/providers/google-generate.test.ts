/** GoogleAdapter (generateContent) unit tests. */

import { describe, expect, it } from 'bun:test';
import { GoogleAdapter } from '../../../../src/llm/providers/google/generate';
import type { NormalizedRequest } from '../../../../src/llm/types/request';
import type { SSEEvent } from '../../../../src/network/types';

const baseReq: NormalizedRequest = {
  model: 'gemini-2.5-pro',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('GoogleAdapter — static config', () => {
  it('returns x-goog-api-key + content-type', () => {
    const a = new GoogleAdapter({ apiKey: 'AIza-xxx' });
    expect(a.authHeaders()).toEqual({
      'x-goog-api-key': 'AIza-xxx',
      'content-type': 'application/json',
    });
  });

  it('default baseURL', () => {
    expect(new GoogleAdapter({ apiKey: 'k' }).baseURL()).toBe(
      'https://generativelanguage.googleapis.com',
    );
  });

  it('completionPath empty (set per request)', () => {
    expect(new GoogleAdapter({ apiKey: 'k' }).completionPath()).toBe('');
  });

  it('name google', () => {
    expect(new GoogleAdapter({ apiKey: 'k' }).name).toBe('google');
  });
});

describe('GoogleAdapter — web_search builtin', () => {
  const a = new GoogleAdapter({ apiKey: 'k' });

  it('maps the web_search builtin to a googleSearch tool', () => {
    const r = a.buildRequest({ ...baseReq, tools: [{ type: 'web_search' }] });
    expect(r.body.tools).toContainEqual({ googleSearch: {} });
  });

  it('maps the code_interpreter builtin to a codeExecution tool', () => {
    const r = a.buildRequest({ ...baseReq, tools: [{ type: 'code_interpreter' }] });
    expect(r.body.tools).toContainEqual({ codeExecution: {} });
  });

  it('maps the web_fetch builtin to a urlContext tool', () => {
    const r = a.buildRequest({ ...baseReq, tools: [{ type: 'web_fetch' }] });
    expect(r.body.tools).toContainEqual({ urlContext: {} });
  });

  it('sets responseModalities AUDIO when outputModalities includes audio', () => {
    const r = a.buildRequest({ ...baseReq, outputModalities: ['audio'], audio: { voice: 'warm' } });
    const gc = r.body.generationConfig as {
      responseModalities: string[];
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
    };
    expect(gc.responseModalities).toEqual(['AUDIO']);
    expect(gc.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Aoede');
  });
});

describe('GoogleAdapter — buildRequest basics', () => {
  const a = new GoogleAdapter({ apiKey: 'k' });

  it('emits contents + generationConfig and dynamic path', () => {
    const r = a.buildRequest(baseReq);
    expect(r.path).toBe('/v1beta/models/gemini-2.5-pro:generateContent');
    expect(r.body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(r.body.generationConfig).toEqual({});
  });

  it('keeps "models/" prefix when already present', () => {
    const r = a.buildRequest({ ...baseReq, model: 'models/gemini-2.5-flash' });
    expect(r.path).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
  });

  it('skips role:system messages (handled via systemInstruction)', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect((r.body.contents as unknown[]).length).toBe(1);
  });

  it('system → systemInstruction.parts', () => {
    const r = a.buildRequest({ ...baseReq, system: 'You are helpful.' });
    expect(r.body.systemInstruction).toEqual({
      parts: [{ text: 'You are helpful.' }],
    });
  });

  it('renames assistant → model role', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [{ role: 'assistant', content: 'a' }],
    });
    expect((r.body.contents as Array<Record<string, unknown>>)[0].role).toBe('model');
  });

  it('maxTokens, temperature, topP, stop go into generationConfig with renames', () => {
    const r = a.buildRequest({
      ...baseReq,
      maxTokens: 1024,
      temperature: 0.5,
      topP: 0.9,
      stop: ['END'],
    });
    expect(r.body.generationConfig).toEqual({
      maxOutputTokens: 1024,
      temperature: 0.5,
      topP: 0.9,
      stopSequences: ['END'],
    });
  });
});

describe('GoogleAdapter — content parts', () => {
  const a = new GoogleAdapter({ apiKey: 'k' });

  it('image base64 → inlineData', () => {
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
    const parts = (r.body.contents as Array<{ parts: unknown[] }>)[0].parts;
    expect(parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }]);
  });

  it('document url → fileData passthrough', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'user',
          content: [{ type: 'document', source: { type: 'url', url: 'https://x.test/y.pdf' } }],
        },
      ],
    });
    const parts = (r.body.contents as Array<{ parts: unknown[] }>)[0].parts;
    expect(parts).toEqual([
      { fileData: { fileUri: 'https://x.test/y.pdf', mimeType: 'application/octet-stream' } },
    ]);
  });

  it('tool_call → functionCall part with id+args', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'c1', name: 'lookup', arguments: { q: 'x' } }],
        },
      ],
    });
    const parts = (r.body.contents as Array<{ parts: unknown[] }>)[0].parts;
    expect(parts).toEqual([{ functionCall: { name: 'lookup', args: { q: 'x' }, id: 'c1' } }]);
  });

  it('tool_call _meta.thoughtSignature is preserved on functionCall part', () => {
    const r = a.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: 'c1',
              name: 'lookup',
              arguments: {},
              _meta: { thoughtSignature: 'sig-xyz' },
            },
          ],
        },
      ],
    });
    const parts = (r.body.contents as Array<{ parts: unknown[] }>)[0].parts as Array<
      Record<string, unknown>
    >;
    expect(parts[0].thoughtSignature).toBe('sig-xyz');
  });

  it('tool_result wired via functionResponse with name from tracked tool_call', () => {
    const a2 = new GoogleAdapter({ apiKey: 'k' });
    const r = a2.buildRequest({
      ...baseReq,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'c1', name: 'lookup', arguments: { q: 'x' } }],
        },
        {
          role: 'tool',
          content: [{ type: 'tool_result', id: 'c1', content: 'temp 70' }],
        },
      ],
    });
    const toolMsg = (r.body.contents as Array<{ parts: unknown[] }>)[1];
    expect(toolMsg.parts).toEqual([
      { functionResponse: { name: 'lookup', id: 'c1', response: { result: 'temp 70' } } },
    ]);
  });
});

describe('GoogleAdapter — tools and toolChoice', () => {
  const a = new GoogleAdapter({ apiKey: 'k' });

  it('function tools wrapped in functionDeclarations', () => {
    const r = a.buildRequest({
      ...baseReq,
      tools: [{ name: 'fn', description: 'd', parameters: {} }],
    });
    expect(r.body.tools).toEqual([
      { functionDeclarations: [{ name: 'fn', description: 'd', parameters: {} }] },
    ]);
  });

  it('toolChoice maps to functionCallingConfig modes', () => {
    expect(
      a.buildRequest({ ...baseReq, toolChoice: 'auto' }).body.toolConfig as Record<string, unknown>,
    ).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(
      a.buildRequest({ ...baseReq, toolChoice: 'none' }).body.toolConfig as Record<string, unknown>,
    ).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    expect(
      a.buildRequest({ ...baseReq, toolChoice: 'required' }).body.toolConfig as Record<
        string,
        unknown
      >,
    ).toEqual({ functionCallingConfig: { mode: 'ANY' } });
  });
});

describe('GoogleAdapter — thinking, structured, providerOptions', () => {
  const a = new GoogleAdapter({ apiKey: 'k' });

  it('thinking → thinkingConfig.thinkingLevel mapping', () => {
    const r = a.buildRequest({ ...baseReq, thinking: { mode: 'auto', effort: 'low' } });
    expect((r.body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({
      thinkingLevel: 'LOW',
    });
  });

  it('thinking off omits thinkingConfig', () => {
    const r = a.buildRequest({ ...baseReq, thinking: { mode: 'off' } });
    expect((r.body.generationConfig as Record<string, unknown>).thinkingConfig).toBeUndefined();
  });

  it('structured output → responseMimeType + responseJsonSchema', () => {
    const r = a.buildRequest({
      ...baseReq,
      structured: { schema: { type: 'object' } },
    });
    expect(r.body.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object' },
    });
  });

  it('providerOptions.responseModalities pass through', () => {
    const r = a.buildRequest({
      ...baseReq,
      providerOptions: { responseModalities: ['IMAGE', 'TEXT'] },
    });
    expect((r.body.generationConfig as Record<string, unknown>).responseModalities).toEqual([
      'IMAGE',
      'TEXT',
    ]);
  });
});

describe('GoogleAdapter — enableStreaming', () => {
  it('rewrites path to streamGenerateContent', () => {
    const a = new GoogleAdapter({ apiKey: 'k' });
    const pr = a.buildRequest(baseReq);
    a.enableStreaming(pr, baseReq);
    expect(pr.path).toBe('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
  });
});

describe('GoogleAdapter — parseResponse', () => {
  const a = new GoogleAdapter({ apiKey: 'k' });

  it('text response with usage', () => {
    const raw = {
      candidates: [
        {
          content: { parts: [{ text: 'hi' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 3,
        totalTokenCount: 8,
      },
    };
    const res = a.parseResponse(raw, 100);
    expect(res.text).toBe('hi');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toMatchObject({ inputTokens: 5, outputTokens: 3, totalTokens: 8 });
  });

  it('thought parts surfaced as thinking', () => {
    const raw = {
      candidates: [
        {
          content: {
            parts: [{ text: 'reasoning', thought: true }, { text: 'answer' }],
          },
          finishReason: 'STOP',
        },
      ],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.thinking).toBe('reasoning');
    expect(res.text).toBe('answer');
  });

  it('code-execution inlineData → response.files (not media)', () => {
    const raw = {
      candidates: [
        {
          content: {
            parts: [
              { executableCode: { language: 'PYTHON', code: 'print(1)' } },
              { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '1' } },
              { inlineData: { mimeType: 'image/png', data: 'CHARTB64' } },
              { text: 'here is your chart' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.files).toEqual([
      { data: 'CHARTB64', mimeType: 'image/png', source: 'code_execution' },
    ]);
    expect(res.media).toHaveLength(0); // not double-counted as media
    expect(res.text).toBe('here is your chart');
    // Builtin-tool trail carries the code + its output.
    expect(res.builtinToolCalls).toEqual([
      { tool: 'code_interpreter', code: 'print(1)', output: '1' },
    ]);
  });

  it('grounding metadata → web_search builtinToolCall with the query', () => {
    const raw = {
      candidates: [
        {
          content: { parts: [{ text: 'Canberra.' }] },
          finishReason: 'STOP',
          groundingMetadata: { webSearchQueries: ['capital of Australia'] },
        },
      ],
    };
    expect(a.parseResponse(raw, 0).builtinToolCalls).toEqual([
      { tool: 'web_search', query: 'capital of Australia' },
    ]);
  });

  it('urlContextMetadata → web_fetch builtinToolCall per retrieved URL', () => {
    const raw = {
      candidates: [
        {
          content: { parts: [{ text: 'summary' }] },
          finishReason: 'STOP',
          urlContextMetadata: {
            urlMetadata: [
              { retrievedUrl: 'https://a.dev/1', urlRetrievalStatus: 'URL_RETRIEVAL_STATUS_SUCCESS' },
              { retrievedUrl: 'https://a.dev/2' },
            ],
          },
        },
      ],
    };
    expect(a.parseResponse(raw, 0).builtinToolCalls).toEqual([
      { tool: 'web_fetch', url: 'https://a.dev/1' },
      { tool: 'web_fetch', url: 'https://a.dev/2' },
    ]);
  });

  it('inlineData WITHOUT code-execution stays media (unchanged)', () => {
    const raw = {
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'IMGB64' } }] }, finishReason: 'STOP' },
      ],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.media).toHaveLength(1);
    expect(res.files).toBeUndefined();
  });

  it('functionCall → tool_call with finishReason tool_use', () => {
    const raw = {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { id: 'c1', name: 'lookup', args: { q: 'x' } } }],
          },
          finishReason: 'STOP',
        },
      ],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.finishReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'lookup', arguments: { q: 'x' } },
    ]);
  });

  it('SAFETY finish → content_filter; MAX_TOKENS → length', () => {
    expect(
      a.parseResponse({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }, 0)
        .finishReason,
    ).toBe('content_filter');
    expect(
      a.parseResponse(
        { candidates: [{ content: { parts: [{ text: 't' }] }, finishReason: 'MAX_TOKENS' }] },
        0,
      ).finishReason,
    ).toBe('length');
  });

  it('inline image → image_output media', () => {
    const raw = {
      candidates: [
        {
          content: {
            parts: [{ inlineData: { mimeType: 'image/png', data: 'BASE64' } }],
          },
          finishReason: 'STOP',
        },
      ],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.media.length).toBe(1);
    expect(res.media[0]).toMatchObject({
      type: 'image_output',
      mimeType: 'image/png',
      _data: 'BASE64',
    });
  });

  it('cachedContentTokenCount + thoughtsTokenCount surface in usage', () => {
    const raw = {
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 80,
        thoughtsTokenCount: 30,
      },
    };
    const u = a.parseResponse(raw, 0).usage;
    expect(u.cachedTokens).toBe(80);
    expect(u.reasoningTokens).toBe(30);
  });
});

describe('GoogleAdapter — parseStreamEvent', () => {
  const a = new GoogleAdapter({ apiKey: 'k' });

  it('text part → text event', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('thought + text → thinking event', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'reasoning', thought: true }] } }],
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'thinking', text: 'reasoning' }]);
  });

  it('inlineData → media start/chunk/end triple', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'B64' } }] } },
        ],
      }),
    };
    const events = a.parseStreamEvent(evt);
    expect(events.length).toBe(3);
    expect(events[0]).toEqual({ type: 'media_start', mediaType: 'image', mimeType: 'image/png' });
    expect(events[1]).toEqual({ type: 'media_chunk', data: 'B64' });
    expect(events[2]).toEqual({ type: 'media_end' });
  });

  it('functionCall → start + delta + end', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { id: 'c1', name: 'lookup', args: { q: 'x' } } }],
            },
          },
        ],
      }),
    };
    const events = a.parseStreamEvent(evt);
    expect(events).toEqual([
      { type: 'tool_call_start', id: 'c1', name: 'lookup' },
      { type: 'tool_call_delta', id: '', arguments: '{"q":"x"}' },
      { type: 'tool_call_end', id: '' },
    ]);
  });

  it('finishReason MAX_TOKENS → done length', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'done', finishReason: 'length' }]);
  });

  it('usage-only chunk without candidates', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
      }),
    };
    expect(a.parseStreamEvent(evt)[0].type).toBe('usage');
  });
});

describe('GoogleAdapter — createStreamParser (stateful code-exec latch)', () => {
  const a = new GoogleAdapter({ apiKey: 'k' });
  const sse = (obj: unknown): SSEEvent => ({ data: JSON.stringify(obj) });
  const inlineDataEvent = sse({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'CHART' } }] } }],
  });

  it('without any code-exec marker, inlineData stays media', () => {
    const parse = a.createStreamParser();
    const events = parse(inlineDataEvent);
    expect(events.map((e) => e.type)).toEqual(['media_start', 'media_chunk', 'media_end']);
  });

  it('latches across events: a prior code-exec marker routes a LATER inlineData to a file', () => {
    const parse = a.createStreamParser();
    // Event 1: the executableCode marker arrives (no file yet).
    parse(sse({ candidates: [{ content: { parts: [{ executableCode: { code: 'print(1)' } }] } }] }));
    // Event 2 (separate SSE frame): the produced chart blob → file, not media.
    expect(parse(inlineDataEvent)).toEqual([
      { type: 'file', file: { data: 'CHART', mimeType: 'image/png', source: 'code_execution' } },
    ]);
  });

  it('marker and inlineData in the SAME event → file (pre-scan order-independent)', () => {
    const parse = a.createStreamParser();
    const evt = sse({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: 'image/png', data: 'CHART' } },
              { codeExecutionResult: { outcome: 'OK' } },
            ],
          },
        },
      ],
    });
    expect(parse(evt)).toContainEqual({
      type: 'file',
      file: { data: 'CHART', mimeType: 'image/png', source: 'code_execution' },
    });
  });

  it('parser instances are isolated — one stream latching does not affect another', () => {
    const p1 = a.createStreamParser();
    const p2 = a.createStreamParser();
    p1(sse({ candidates: [{ content: { parts: [{ executableCode: { code: 'x' } }] } }] }));
    // p2 never saw a marker → its inlineData is still media.
    expect(p2(inlineDataEvent).map((e) => e.type)).toEqual([
      'media_start',
      'media_chunk',
      'media_end',
    ]);
  });
});
