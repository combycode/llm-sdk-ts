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

  it('does NOT send presence/frequency penalties (Responses API rejects them)', () => {
    const r = a.buildRequest({ ...baseReq, presencePenalty: 0.5, frequencyPenalty: 0.5 });
    expect(r.body.presence_penalty).toBeUndefined();
    expect(r.body.frequency_penalty).toBeUndefined();
  });

  it('providerOptions.moderationPolicy → moderation.policy (server-side block passthrough)', () => {
    const policy = { input: { mode: 'block' }, output: { mode: 'score' } };
    const r = a.buildRequest({ ...baseReq, providerOptions: { moderationPolicy: policy } });
    const mod = r.body.moderation as Record<string, unknown>;
    expect(mod.policy).toEqual(policy);
    expect(mod.model).toBeDefined();
    // No policy + no moderation → no moderation field at all.
    expect(a.buildRequest(baseReq).body.moderation).toBeUndefined();
  });

  it('providerOptions.promptCacheOptions → prompt_cache_options (explicit caching)', () => {
    const opts = { mode: 'explicit', ttl: '30m' };
    const r = a.buildRequest({ ...baseReq, providerOptions: { promptCacheOptions: opts } });
    expect(r.body.prompt_cache_options).toEqual(opts);
    expect(a.buildRequest(baseReq).body.prompt_cache_options).toBeUndefined();
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

  it('function tool: allowedCallers + outputSchema → allowed_callers + output_schema (programmatic)', () => {
    const r = a.buildRequest({
      ...baseReq,
      tools: [
        {
          name: 'fn',
          description: 'd',
          parameters: { type: 'object', properties: {} },
          allowedCallers: ['direct', 'programmatic'],
          outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
      ],
    });
    const tool = (r.body.tools as Array<Record<string, unknown>>)[0];
    expect(tool.allowed_callers).toEqual(['direct', 'programmatic']);
    expect(tool.output_schema).toEqual({ type: 'object', properties: { ok: { type: 'boolean' } } });
  });

  it('programmatic_tool_calling builtin passes through', () => {
    const r = a.buildRequest({ ...baseReq, tools: [{ type: 'programmatic_tool_calling' }] });
    expect(r.body.tools).toEqual([{ type: 'programmatic_tool_calling' }]);
  });

  it('builtin tool passes type+params', () => {
    const r = a.buildRequest({
      ...baseReq,
      tools: [{ type: 'web_search', params: { search_context_size: 'medium' } }],
    });
    expect(r.body.tools).toEqual([{ type: 'web_search', search_context_size: 'medium' }]);
  });

  it('mcp builtin forwards tunnel_id (Secure MCP Tunnel target)', () => {
    const r = a.buildRequest({
      ...baseReq,
      tools: [{ type: 'mcp', params: { server_label: 'local', tunnel_id: 'tnl_abc123' } }],
    });
    expect(r.body.tools).toEqual([{ type: 'mcp', server_label: 'local', tunnel_id: 'tnl_abc123' }]);
  });

  it('mcp builtin forwards server_url / connector_id targets too', () => {
    const url = a.buildRequest({
      ...baseReq,
      tools: [{ type: 'mcp', params: { server_label: 's', server_url: 'https://mcp.example/sse' } }],
    });
    expect((url.body.tools as Array<Record<string, unknown>>)[0].server_url).toBe(
      'https://mcp.example/sse',
    );
    const conn = a.buildRequest({
      ...baseReq,
      tools: [{ type: 'mcp', params: { server_label: 's', connector_id: 'connector_gmail' } }],
    });
    expect((conn.body.tools as Array<Record<string, unknown>>)[0].connector_id).toBe(
      'connector_gmail',
    );
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

  it('visibility summary → summary concise; hidden → summary omitted', () => {
    const s = a.buildRequest({ ...baseReq, thinking: { mode: 'auto', visibility: 'summary' } });
    expect((s.body.reasoning as Record<string, unknown>).summary).toBe('concise');
    const h = a.buildRequest({ ...baseReq, thinking: { mode: 'auto', visibility: 'hidden' } });
    expect((h.body.reasoning as Record<string, unknown>).summary).toBeUndefined();
  });

  it('providerOptions.reasoningMode → reasoning.mode (Responses-only)', () => {
    const r = a.buildRequest({
      ...baseReq,
      thinking: { mode: 'auto', effort: 'high' },
      providerOptions: { reasoningMode: 'pro' },
    });
    expect((r.body.reasoning as Record<string, unknown>).mode).toBe('pro');
  });

  it('thinking off omits reasoning', () => {
    const r = a.buildRequest({ ...baseReq, thinking: { mode: 'off' } });
    expect(r.body.reasoning).toBeUndefined();
  });

  it('thinking.context → reasoning.context (cross-turn persistence)', () => {
    const r = a.buildRequest({
      ...baseReq,
      thinking: { mode: 'auto', effort: 'high', context: 'all_turns' },
    });
    expect(r.body.reasoning).toEqual({ effort: 'high', summary: 'auto', context: 'all_turns' });
  });

  it('no context → reasoning.context omitted', () => {
    const r = a.buildRequest({ ...baseReq, thinking: { mode: 'on' } });
    expect((r.body.reasoning as Record<string, unknown>).context).toBeUndefined();
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

  it('code_interpreter image outputs + container-file citations → response.files', () => {
    const raw = {
      id: 'r',
      model: 'm',
      output: [
        {
          type: 'code_interpreter_call',
          outputs: [
            { type: 'logs', logs: 'stdout text' },
            { type: 'image', url: 'https://oai/img.png' },
          ],
        },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'see chart.csv',
              annotations: [
                { type: 'container_file_citation', container_id: 'c1', file_id: 'file_9', filename: 'chart.csv' },
                { type: 'url_citation', url: 'https://x' },
              ],
            },
          ],
        },
      ],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.files).toEqual([
      { url: 'https://oai/img.png', source: 'code_execution' },
      { id: 'file_9', name: 'chart.csv', ref: { containerId: 'c1' }, source: 'code_execution' },
    ]);
  });

  it('no code-execution → files omitted', () => {
    const raw = { id: 'r', model: 'm', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] };
    expect(a.parseResponse(raw, 0).files).toBeUndefined();
  });

  it('builtinToolCalls carry code + output (code_interpreter) and query (web_search)', () => {
    const raw = {
      id: 'r',
      model: 'm',
      output: [
        {
          type: 'code_interpreter_call',
          id: 'ci_1',
          code: 'print(1+1)',
          outputs: [{ type: 'logs', logs: '2\n' }],
        },
        { type: 'web_search_call', id: 'ws_1', action: { type: 'search', query: 'capital of Japan' } },
      ],
    };
    expect(a.parseResponse(raw, 0).builtinToolCalls).toEqual([
      { tool: 'code_interpreter', id: 'ci_1', code: 'print(1+1)', output: '2\n' },
      { tool: 'web_search', id: 'ws_1', query: 'capital of Japan' },
    ]);
  });

  it('web_search query falls back to action.queries[0]', () => {
    const raw = {
      id: 'r',
      model: 'm',
      output: [{ type: 'web_search_call', id: 'ws_1', action: { queries: ['q one', 'q two'] } }],
    };
    expect(a.parseResponse(raw, 0).builtinToolCalls).toEqual([
      { tool: 'web_search', id: 'ws_1', query: 'q one' },
    ]);
  });

  it('web_search prefers action.queries[] over the deprecated scalar action.query', () => {
    const raw = {
      id: 'r',
      model: 'm',
      output: [
        {
          type: 'web_search_call',
          id: 'ws_1',
          // OpenAI now sends both during deprecation; queries[] is authoritative.
          action: { type: 'search', query: 'old scalar', queries: ['new array query'] },
        },
      ],
    };
    expect(a.parseResponse(raw, 0).builtinToolCalls).toEqual([
      { tool: 'web_search', id: 'ws_1', query: 'new array query' },
    ]);
  });

  it('tolerates unknown output items (e.g. additional_tools) without throwing', () => {
    const raw = {
      id: 'r',
      model: 'm',
      output: [
        { type: 'additional_tools', tools: [{ type: 'function', name: 'x' }] }, // unknown → skipped
        { type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
      ],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.text).toBe('hi'); // known item still parsed; unknown one ignored
  });

  it('web_search open_page action → url (not query)', () => {
    const raw = {
      id: 'r',
      model: 'm',
      output: [
        { type: 'web_search_call', id: 'ws_s', action: { type: 'search', query: 'amadey' } },
        { type: 'web_search_call', id: 'ws_o', action: { type: 'open_page', url: 'https://x.dev/p' } },
      ],
    };
    expect(a.parseResponse(raw, 0).builtinToolCalls).toEqual([
      { tool: 'web_search', id: 'ws_s', query: 'amadey' },
      { tool: 'web_search', id: 'ws_o', url: 'https://x.dev/p' },
    ]);
  });

  // Dedup of OpenAI's plt.show() auto-display artifact (id-named + image + zero-span).
  const citation = (file_id: string, filename: string, start = 0, end = 0) => ({
    type: 'container_file_citation',
    container_id: 'c1',
    file_id,
    filename,
    start_index: start,
    end_index: end,
  });
  const msg = (annotations: unknown[]) => ({
    id: 'r',
    model: 'm',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 't', annotations }] }],
  });

  it('dedup: display+save drops the auto-display, keeps the saved image', () => {
    const raw = msg([
      citation('cfile_disp', 'cfile_disp.png', 0, 0), // plt.show() artifact
      citation('cfile_save', 'chart.png', 21, 48), // savefig
    ]);
    expect(a.parseResponse(raw, 0).files).toEqual([
      { id: 'cfile_save', name: 'chart.png', ref: { containerId: 'c1' }, source: 'code_execution' },
    ]);
  });

  it('dedup: display-only keeps the sole figure (no saved image sibling)', () => {
    const raw = msg([citation('cfile_xyz', 'cfile_xyz.png', 0, 0)]);
    expect(a.parseResponse(raw, 0).files).toEqual([
      { id: 'cfile_xyz', name: 'cfile_xyz.png', ref: { containerId: 'c1' }, source: 'code_execution' },
    ]);
  });

  it('dedup: multi-save drops only the display artifact, keeps distinct saves', () => {
    const raw = msg([
      citation('cfile_disp', 'cfile_disp.png', 0, 0),
      citation('cfile_csv', 'data.csv', 8, 34),
      citation('cfile_png', 'chart.png', 40, 67),
    ]);
    expect(a.parseResponse(raw, 0).files).toEqual([
      { id: 'cfile_csv', name: 'data.csv', ref: { containerId: 'c1' }, source: 'code_execution' },
      { id: 'cfile_png', name: 'chart.png', ref: { containerId: 'c1' }, source: 'code_execution' },
    ]);
  });

  it('dedup: display-png + save-csv keeps both (display is not a dup of a csv)', () => {
    const raw = msg([
      citation('cfile_img', 'cfile_img.png', 0, 0),
      citation('cfile_csv', 'data.csv', 24, 50),
    ]);
    expect(a.parseResponse(raw, 0).files).toEqual([
      { id: 'cfile_img', name: 'cfile_img.png', ref: { containerId: 'c1' }, source: 'code_execution' },
      { id: 'cfile_csv', name: 'data.csv', ref: { containerId: 'c1' }, source: 'code_execution' },
    ]);
  });

  it('status incomplete → finishReason length when no toolCalls', () => {
    const raw = { id: 'r', model: 'm', status: 'incomplete', output: [] };
    expect(a.parseResponse(raw, 0).finishReason).toBe('length');
  });

  it('status failed → finishReason error + surfaces error.code/message', () => {
    const raw = {
      id: 'r',
      model: 'm',
      status: 'failed',
      error: { code: 'data_residency_mismatch', message: 'Region mismatch.' },
      output: [],
    };
    const res = a.parseResponse(raw, 0);
    expect(res.finishReason).toBe('error');
    expect(res.error).toEqual({ code: 'data_residency_mismatch', message: 'Region mismatch.' });
  });

  it('status queued / in_progress → finishReason pending (non-terminal, background mode)', () => {
    for (const status of ['queued', 'in_progress']) {
      const raw = { id: 'r', model: 'm', status, output: [] };
      expect(a.parseResponse(raw, 0).finishReason).toBe('pending');
    }
  });

  it('status cancelled → finishReason error', () => {
    const raw = { id: 'r', model: 'm', status: 'cancelled', output: [] };
    expect(a.parseResponse(raw, 0).finishReason).toBe('error');
  });

  it('no error field → response.error stays absent', () => {
    const raw = { id: 'r', model: 'm', status: 'completed', output: [] };
    expect(a.parseResponse(raw, 0).error).toBeUndefined();
  });

  it('incomplete + content_filter reason → finishReason content_filter (not length)', () => {
    const raw = {
      id: 'r',
      model: 'm',
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [],
    };
    expect(a.parseResponse(raw, 0).finishReason).toBe('content_filter');
  });

  it('incomplete + max_output_tokens reason → finishReason length', () => {
    const raw = {
      id: 'r',
      model: 'm',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
    };
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
        input_tokens_details: { cached_tokens: 70, cache_write_tokens: 40 },
        output_tokens_details: { reasoning_tokens: 30 },
      },
    };
    const u = a.parseResponse(raw, 0).usage;
    expect(u.cachedTokens).toBe(70);
    expect(u.cacheWriteTokens).toBe(40);
    expect(u.reasoningTokens).toBe(30);
    expect(u.totalTokens).toBe(150);
  });
});

describe('OpenAIResponsesAdapter — parseStreamEvent', () => {
  const a = new OpenAIResponsesAdapter({ apiKey: 'k' });

  it('output_text.delta → text (no item_id → no itemId, unchanged shape)', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('output_text.delta forwards item_id → itemId', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({ type: 'response.output_text.delta', delta: 'hi', item_id: 'msg_1' }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([{ type: 'text', text: 'hi', itemId: 'msg_1' }]);
  });

  it('interleaved deltas keep their own itemId (the point of the field)', () => {
    const d = (delta: string, item_id: string): SSEEvent => ({
      data: JSON.stringify({ type: 'response.output_text.delta', delta, item_id }),
    });
    const got = [
      ...a.parseStreamEvent(d('a', 'msg_1')),
      ...a.parseStreamEvent(d('b', 'msg_2')),
      ...a.parseStreamEvent(d('c', 'msg_1')),
    ];
    expect(got).toEqual([
      { type: 'text', text: 'a', itemId: 'msg_1' },
      { type: 'text', text: 'b', itemId: 'msg_2' },
      { type: 'text', text: 'c', itemId: 'msg_1' },
    ]);
  });

  it('reasoning item → thinking carries its itemId', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'because' }] },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([
      { type: 'thinking', text: 'because', itemId: 'rs_1' },
    ]);
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

  it('output_item.done message with container_file_citation → file event', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'chart',
              annotations: [
                {
                  type: 'container_file_citation',
                  file_id: 'cfile_1',
                  filename: 'chart.png',
                  container_id: 'cntr_9',
                },
              ],
            },
          ],
        },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([
      {
        type: 'file',
        file: {
          id: 'cfile_1',
          name: 'chart.png',
          ref: { containerId: 'cntr_9' },
          source: 'code_execution',
        },
      },
    ]);
  });

  it('output_item.done code_interpreter_call image → file event by url', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'code_interpreter_call',
          outputs: [{ type: 'image', url: 'https://api.openai.com/x.png' }],
        },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([
      { type: 'file', file: { url: 'https://api.openai.com/x.png', source: 'code_execution' } },
      { type: 'builtin_tool_end', tool: 'code_interpreter' },
    ]);
  });

  it('output_item.added web_search_call → builtin_tool_start', () => {
    const evt: SSEEvent = {
      data: JSON.stringify({
        type: 'response.output_item.added',
        item: { type: 'web_search_call', id: 'ws_1' },
      }),
    };
    expect(a.parseStreamEvent(evt)).toEqual([
      { type: 'builtin_tool_start', tool: 'web_search', id: 'ws_1' },
    ]);
  });
});
