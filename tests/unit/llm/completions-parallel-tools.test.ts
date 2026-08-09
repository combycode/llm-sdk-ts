/** Parallel tool results on the chat-completions surface.
 *
 *  The loop answers a round of parallel calls with ONE tool message holding a
 *  `tool_result` part per call. This API wants a SEPARATE `{role:'tool'}` message per
 *  `tool_call_id`. Only the first was emitted, so every call after the first went
 *  unanswered and the provider rejected the whole request:
 *
 *    "No tool output found for function call call_4Y3Unc5CWugrDKlRV7Gkm3E8."
 *
 *  Parallel tools were therefore broken on every chat-completions backend. Found by
 *  running the examples corpus (openrouter cell of scenario 07); present in 1.7.0 too. */

import { describe, expect, it } from 'bun:test';
import { OpenAIAdapter } from '../../../src/llm/providers/openai/completions';
import type { Message } from '../../../src/llm/types/messages';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const adapter = new OpenAIAdapter({ apiKey: 'k' });

function messagesOf(messages: Message[]): Record<string, unknown>[] {
  const req = { model: 'gpt-5.4-nano', messages } as NormalizedRequest;
  return (adapter.buildRequest(req).body as { messages: Record<string, unknown>[] }).messages;
}

const assistantWithTwoCalls: Message = {
  role: 'assistant',
  content: [
    { type: 'tool_call', id: 'call_paris', name: 'get_weather', arguments: { city: 'Paris' } },
    { type: 'tool_call', id: 'call_tokyo', name: 'get_weather', arguments: { city: 'Tokyo' } },
  ],
};

describe('chat-completions parallel tool results', () => {
  it('emits one tool message per tool_call_id', () => {
    const out = messagesOf([
      { role: 'user', content: 'weather in Paris and Tokyo?' },
      assistantWithTwoCalls,
      {
        role: 'tool',
        content: [
          { type: 'tool_result', id: 'call_paris', content: 'sunny' },
          { type: 'tool_result', id: 'call_tokyo', content: 'rainy' },
        ],
      },
    ]);

    const toolMsgs = out.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['call_paris', 'call_tokyo']);
    expect(toolMsgs.map((m) => m.content)).toEqual(['sunny', 'rainy']);
  });

  it('answers EVERY call the assistant made — none left dangling', () => {
    const out = messagesOf([
      { role: 'user', content: 'q' },
      assistantWithTwoCalls,
      {
        role: 'tool',
        content: [
          { type: 'tool_result', id: 'call_paris', content: 'sunny' },
          { type: 'tool_result', id: 'call_tokyo', content: 'rainy' },
        ],
      },
    ]);

    // This is the invariant the provider enforces: every id in the assistant's
    // tool_calls must appear as a tool_call_id afterwards.
    const assistant = out.find((m) => Array.isArray(m.tool_calls)) as {
      tool_calls: { id: string }[];
    };
    const answered = new Set(out.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    for (const call of assistant.tool_calls) expect(answered.has(call.id)).toBe(true);
  });

  it('still emits a single message for a single result', () => {
    const out = messagesOf([
      { role: 'tool', content: [{ type: 'tool_result', id: 'call_1', content: 'ok' }] },
    ]);
    expect(out).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }]);
  });

  it('serialises structured tool result content', () => {
    const out = messagesOf([
      {
        role: 'tool',
        content: [
          { type: 'tool_result', id: 'call_1', content: [{ type: 'text', text: 'a' }] },
          { type: 'tool_result', id: 'call_2', content: 'b' },
        ],
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe(JSON.stringify([{ type: 'text', text: 'a' }]));
    expect(out[1].content).toBe('b');
  });

  it('leaves non-tool messages alone', () => {
    const out = messagesOf([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('falls through for a tool message carrying no tool_result', () => {
    // Degenerate but real: a tool turn with plain text. It must still produce exactly
    // one message rather than vanishing.
    const out = messagesOf([{ role: 'tool', content: 'plain text' }]);
    expect(out).toHaveLength(1);
  });
});
