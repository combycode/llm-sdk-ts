/** A tool that returns an image sends an IMAGE, on every backend.
 *
 *  `AgentTool.execute` has always promised `string | ContentPart[]`, and the
 *  loop has always carried the array into `ToolResultPart.content`, whose type
 *  says `string | ContentPart[]`. Every adapter then called `JSON.stringify` on
 *  it. So the documented way to return an image worked, in the sense that the
 *  request succeeded: the model received a wall of base64 as prose, paid for as
 *  prose, and could not see the picture. Nothing failed; it just did not work.
 *
 *  Each API has somewhere to put this and they disagree about where, so the test
 *  is per-adapter rather than shared:
 *
 *    Anthropic         blocks inside `tool_result.content`
 *    OpenAI Responses  items inside `function_call_output.output`
 *    Google generate   `functionResponse.parts[].inlineData`
 *    OpenAI Completions  nowhere — a tool message is text, so it follows in its own user message
 *
 *  The one invariant across all four: a STRING result must build exactly the
 *  body it built before this existed.
 */

import { describe, expect, it } from 'bun:test';
import { OpenAIAdapter } from '../../../src/llm/providers/openai/completions';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { GoogleInteractionsAdapter } from '../../../src/llm/providers/google/interactions';
import { splitToolResult, hasToolResultMedia } from '../../../src/llm/providers/_shared/tool-result';
import type { ContentPart, Message } from '../../../src/llm/types/messages';
import type { NormalizedRequest } from '../../../src/llm/types/request';

/** A 1x1 PNG, small enough to read in a failure message. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const CHART: ContentPart[] = [
  { type: 'text', text: 'revenue by quarter' },
  { type: 'image', source: { type: 'base64', mimeType: 'image/png', data: PNG } },
];

function conversation(result: string | ContentPart[]): Message[] {
  return [
    { role: 'user', content: 'chart the revenue' },
    {
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'call_1', name: 'chart', arguments: {} }],
    },
    { role: 'tool', content: [{ type: 'tool_result', id: 'call_1', content: result }] },
  ];
}

// ─────────────────────────────────────────────────────────── the split itself

describe('splitToolResult', () => {
  it('leaves a string alone', () => {
    expect(splitToolResult('done')).toEqual({ text: 'done', media: [] });
  });

  it('separates the text half from the media half', () => {
    const { text, media } = splitToolResult(CHART);
    expect(text).toBe('revenue by quarter');
    expect(media).toHaveLength(1);
    expect(media[0]?.type).toBe('image');
  });

  it('joins several text parts, keeping their order', () => {
    expect(
      splitToolResult([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]).text,
    ).toBe('first\nsecond');
  });

  it('serialises a part that is neither rather than dropping it', () => {
    // A tool returning something unexpected should reach the model looking odd,
    // not vanish on the way.
    const { text, media } = splitToolResult([
      { type: 'tool_call', id: 'x', name: 'inner', arguments: { a: 1 } },
    ]);
    expect(text).toContain('inner');
    expect(media).toHaveLength(0);
  });

  it('answers whether anything has to travel as media', () => {
    expect(hasToolResultMedia('done')).toBe(false);
    expect(hasToolResultMedia([{ type: 'text', text: 'done' }])).toBe(false);
    expect(hasToolResultMedia(CHART)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────── Anthropic Messages

describe('Anthropic sends it as blocks inside the tool_result', () => {
  const adapter = new AnthropicAdapter({ apiKey: 'k' });
  const body = (result: string | ContentPart[]) =>
    adapter.buildRequest({
      model: 'claude-haiku-4.5',
      messages: conversation(result),
    } as NormalizedRequest).body as { messages: { role: string; content: unknown[] }[] };

  const toolResult = (result: string | ContentPart[]) => {
    const msgs = body(result).messages;
    const user = msgs.filter((m) => m.role === 'user');
    const blocks = user.flatMap((m) => m.content as Record<string, unknown>[]);
    return blocks.find((b) => b.type === 'tool_result') as Record<string, unknown>;
  };

  it('keeps a string result a string', () => {
    expect(toolResult('done').content).toBe('done');
  });

  it('carries the image as an image block, not as base64 prose', () => {
    const content = toolResult(CHART).content as Record<string, unknown>[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'revenue by quarter' });
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG },
    });
  });

  it('needs no extra message to do it', () => {
    // The whole point of the native slot: history stays one turn per turn.
    expect(body(CHART).messages).toHaveLength(body('done').messages.length);
  });
});

// ────────────────────────────────────────────────────────── OpenAI Responses

describe('OpenAI Responses sends it inside function_call_output.output', () => {
  const adapter = new OpenAIResponsesAdapter({ apiKey: 'k' });
  const items = (result: string | ContentPart[]) =>
    (
      adapter.buildRequest({
        model: 'gpt-5.4-nano',
        messages: conversation(result),
      } as NormalizedRequest).body as { input: Record<string, unknown>[] }
    ).input;

  const output = (result: string | ContentPart[]) =>
    items(result).find((i) => i.type === 'function_call_output')?.output;

  it('keeps a string result a string', () => {
    expect(output('done')).toBe('done');
  });

  it('carries the image as an input_image item', () => {
    const out = output(CHART) as Record<string, unknown>[];
    expect(out).toEqual([
      { type: 'input_text', text: 'revenue by quarter' },
      { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
    ]);
  });

  it('needs no extra input item to do it', () => {
    expect(items(CHART)).toHaveLength(items('done').length);
  });
});

// ─────────────────────────────────────────────────── Google generateContent

describe('Google puts it in functionResponse.parts', () => {
  const adapter = new GoogleAdapter({ apiKey: 'k' });
  const contents = (result: string | ContentPart[]) =>
    (
      adapter.buildRequest({
        model: 'gemini-3-flash',
        messages: conversation(result),
      } as NormalizedRequest).body as { contents: { parts: Record<string, unknown>[] }[] }
    ).contents;

  const fnResponse = (result: string | ContentPart[]) =>
    contents(result)
      .flatMap((c) => c.parts)
      .map((p) => p.functionResponse)
      .find((f) => f) as Record<string, unknown>;

  it('keeps a string result under response.result', () => {
    expect(fnResponse('done').response).toEqual({ result: 'done' });
  });

  it('puts the text in response and the image in parts', () => {
    // `response` is a JSON object, so media cannot live there — and a content
    // part array used to be sent AS that object, which is not an object.
    const fr = fnResponse(CHART);
    expect(fr.response).toEqual({ result: 'revenue by quarter' });
    expect(fr.parts).toEqual([{ inlineData: { mimeType: 'image/png', data: PNG } }]);
  });

  it('says so when a source cannot be inlined, rather than dropping it', () => {
    // `fileData` in a function response is documented Vertex-only, so a URL
    // source has nowhere to go here. Silence would lose the tool's answer.
    const fr = fnResponse([
      { type: 'text', text: 'see attached' },
      { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } },
    ]);
    expect(fr.parts).toBeUndefined();
    expect((fr.response as { result: string }).result).toContain('image omitted');
  });
});

// ───────────────────────────────────────────────────────── OpenAI Completions

describe('chat-completions has no slot, so the media follows the tool message', () => {
  const adapter = new OpenAIAdapter({ apiKey: 'k' });
  const messages = (result: string | ContentPart[]) =>
    (
      adapter.buildRequest({
        model: 'gpt-5.4-nano',
        messages: conversation(result),
      } as NormalizedRequest).body as { messages: Record<string, unknown>[] }
    ).messages;

  it('keeps a string result a string, in one tool message', () => {
    const msgs = messages('done');
    const tool = msgs.filter((m) => m.role === 'tool');
    expect(tool).toHaveLength(1);
    expect(tool[0]?.content).toBe('done');
  });

  it('sends the text in the tool message and the image in a user message after it', () => {
    const msgs = messages(CHART);
    const tool = msgs.findIndex((m) => m.role === 'tool');
    expect(msgs[tool]?.content).toBe('revenue by quarter');
    const after = msgs[tool + 1] as { role: string; content: Record<string, unknown>[] };
    expect(after.role).toBe('user');
    expect(after.content[0]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${PNG}`, detail: 'auto' },
    });
  });

  it('answers every call BEFORE the follow-up, so none is left dangling', () => {
    // This API rejects a request where a tool call has no answer. The media
    // message therefore goes after the LAST tool message, not after each one.
    const msgs = (
      adapter.buildRequest({
        model: 'gpt-5.4-nano',
        messages: [
          { role: 'user', content: 'two charts' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_call', id: 'call_1', name: 'chart', arguments: {} },
              { type: 'tool_call', id: 'call_2', name: 'chart', arguments: {} },
            ],
          },
          {
            role: 'tool',
            content: [
              { type: 'tool_result', id: 'call_1', content: CHART },
              { type: 'tool_result', id: 'call_2', content: CHART },
            ],
          },
        ],
      } as NormalizedRequest).body as { messages: Record<string, unknown>[] }
    ).messages;

    const roles = msgs.map((m) => m.role);
    expect(roles.slice(-3)).toEqual(['tool', 'tool', 'user']);
    const trailing = msgs[msgs.length - 1] as { content: unknown[] };
    expect(trailing.content).toHaveLength(2);
  });
});

// ──────────────────────────────────────────────────────── Google Interactions

describe('Google Interactions does the same, for the same reason', () => {
  const adapter = new GoogleInteractionsAdapter({ apiKey: 'k' });
  const input = (result: string | ContentPart[]) =>
    (
      adapter.buildRequest({
        model: 'gemini-3-flash',
        messages: conversation(result),
      } as NormalizedRequest).body as { input: Record<string, unknown>[] }
    ).input;

  it('keeps a string result in the result field', () => {
    const fr = input('done').find((i) => i.type === 'function_result');
    expect(fr?.result).toBe('done');
  });

  it('sends the text as the result and the image as a user_input after it', () => {
    const items = input(CHART);
    const at = items.findIndex((i) => i.type === 'function_result');
    expect(items[at]?.result).toBe('revenue by quarter');
    const after = items[at + 1] as { type: string; content: Record<string, unknown>[] };
    expect(after.type).toBe('user_input');
    expect(after.content[0]).toEqual({ type: 'image', mime_type: 'image/png', data: PNG });
  });
});
