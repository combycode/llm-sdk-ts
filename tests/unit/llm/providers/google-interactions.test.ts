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

  // REVERSED 2026-07-27: google 2.13 removed `cached_content` from the Interactions
  // request model and the endpoint now 400s "Unknown parameter 'cached_content'"
  // (live-probed). The passthrough moved to the generateContent adapter, which still
  // accepts it. This test locks the removal so a stale SDK reference can't re-add it.
  it('never emits cached_content (removed from the Interactions model in google 2.13)', () => {
    const r = a.buildRequest({
      ...baseReq,
      providerOptions: { cachedContent: 'projects/p/locations/l/cachedContents/c' },
    });
    expect(r.body.cached_content).toBeUndefined();
  });

  it('does NOT forward safety_settings / labels (Enterprise/Vertex-only; Gemini API 400s)', () => {
    const r = a.buildRequest({
      ...baseReq,
      providerOptions: {
        safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' }],
        labels: { team: 'search' },
      },
    });
    expect(r.body.safety_settings).toBeUndefined();
    expect(r.body.labels).toBeUndefined();
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

  it('does NOT emit presence/frequency penalties (Interactions API 400s on them)', () => {
    const r = a.buildRequest({ ...baseReq, presencePenalty: 0.3, frequencyPenalty: 0.6 });
    // generation_config may be omitted entirely when nothing else is set.
    const gc = (r.body.generation_config as Record<string, unknown> | undefined) ?? {};
    expect(gc.presence_penalty).toBeUndefined();
    expect(gc.frequency_penalty).toBeUndefined();
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

  it('thinking effort → generation_config.thinking_level (flat, lowercase)', () => {
    const r = a.buildRequest({ ...baseReq, thinking: { mode: 'auto', effort: 'medium' } });
    const gc = r.body.generation_config as Record<string, unknown>;
    // Interactions takes thinking_level DIRECTLY (not wrapped) and lowercase; the
    // wrapped/uppercase form 400s ("Unknown parameter 'thinking_config'" / bad value).
    expect(gc.thinking_level).toBe('medium');
    expect(gc.thinking_config).toBeUndefined();
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

  it('status:queued (non-terminal) reports pending, not a clean stop', () => {
    const raw = { id: 'int_4b', outputs: [], status: 'queued' };
    expect(a.parseResponse(raw, 0).finishReason).toBe('pending');
  });

  it('status:in_progress (non-terminal) reports pending', () => {
    const raw = { id: 'int_4c', outputs: [], status: 'in_progress' };
    expect(a.parseResponse(raw, 0).finishReason).toBe('pending');
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

describe('GoogleInteractionsAdapter — stream (2.10 step-machine wire)', () => {
  const a = new GoogleInteractionsAdapter({ apiKey: 'k' });
  const sse = (o: unknown): SSEEvent => ({ data: JSON.stringify(o) });

  it('step.delta text → text event', () => {
    expect(a.parseStreamEvent(sse({ event_type: 'step.delta', delta: { type: 'text', text: 'hi' } }))).toEqual([
      { type: 'text', text: 'hi' },
    ]);
  });

  it('step.delta thought_summary → thinking event', () => {
    expect(
      a.parseStreamEvent(sse({ event_type: 'step.delta', delta: { type: 'thought_summary', text: 'hmm' } })),
    ).toEqual([{ type: 'thinking', text: 'hmm' }]);
  });

  it('internal deltas (thought_signature) and lifecycle events yield nothing', () => {
    expect(a.parseStreamEvent(sse({ event_type: 'step.delta', delta: { type: 'thought_signature', signature: 'x' } }))).toEqual([]);
    expect(a.parseStreamEvent(sse({ event_type: 'interaction.created', interaction: { id: 'i' } }))).toEqual([]);
    expect(a.parseStreamEvent(sse({ event_type: 'interaction.status_update', status: 'in_progress' }))).toEqual([]);
    expect(a.parseStreamEvent(sse({ event_type: 'interaction.status_update', status: 'queued' }))).toEqual([]);
  });

  it('queued status never closes the stream with a done', () => {
    expect(
      a.parseStreamEvent(sse({ event_type: 'interaction.completed', interaction: { status: 'queued' } })),
    ).toEqual([]);
  });

  it('createStreamParser correlates a function call: step.start → arguments_delta → step.stop', () => {
    const parse = a.createStreamParser();
    // A text step first (its step.stop must NOT emit a tool_call_end).
    expect(parse(sse({ event_type: 'step.start', step: { type: 'model_output' } }))).toEqual([]);
    expect(parse(sse({ event_type: 'step.delta', delta: { type: 'text', text: 'ok' } }))).toEqual([{ type: 'text', text: 'ok' }]);
    expect(parse(sse({ event_type: 'step.stop', index: 0 }))).toEqual([]);
    // Then a function-call step: id from step.start, args streamed id-less.
    expect(parse(sse({ event_type: 'step.start', step: { type: 'function_call', id: 'fc1', name: 'get_weather', arguments: {} } }))).toEqual([
      { type: 'tool_call_start', id: 'fc1', name: 'get_weather' },
    ]);
    expect(parse(sse({ event_type: 'step.delta', delta: { type: 'arguments_delta', arguments: '{"city":"Paris"}' } }))).toEqual([
      { type: 'tool_call_delta', id: 'fc1', arguments: '{"city":"Paris"}' },
    ]);
    expect(parse(sse({ event_type: 'step.stop', index: 1 }))).toEqual([{ type: 'tool_call_end', id: 'fc1' }]);
    // completed after a tool call → tool_use finish reason.
    expect(parse(sse({ event_type: 'interaction.completed', interaction: { status: 'completed', usage: { total_input_tokens: 5, total_output_tokens: 3 } } }))).toEqual([
      { type: 'usage', usage: expect.objectContaining({ inputTokens: 5, outputTokens: 3 }) },
      { type: 'done', finishReason: 'tool_use' },
    ]);
  });

  it('interaction.completed (no tools) → usage from interaction.usage + done stop', () => {
    const events = a.parseStreamEvent(
      sse({ event_type: 'interaction.completed', interaction: { status: 'completed', usage: { total_input_tokens: 8, total_output_tokens: 2 } } }),
    );
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('usage');
    expect(events[1]).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('interaction.failed → done error', () => {
    expect(a.parseStreamEvent(sse({ event_type: 'interaction.failed', interaction: { status: 'failed' } }))).toEqual([
      { type: 'done', finishReason: 'error' },
    ]);
  });
});
