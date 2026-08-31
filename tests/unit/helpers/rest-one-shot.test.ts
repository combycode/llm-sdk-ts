/** complete() — audio auto-routing, attachment merging and structured parsing.
 *  (The happy path / budget guard live in one-shot.test.ts.)
 *
 *  Behaviour pinned here:
 *   - OpenAI's Responses API rejects input audio, so an OpenAI request whose
 *     input carries an audio part is re-routed to Chat Completions. The
 *     detection must look inside BOTH shapes of input (ContentPart[] and
 *     Message[]), and must not fire for a string prompt or for a non-OpenAI
 *     provider. An explicit `client.api` pins the API and wins over the
 *     re-route — the caller asked for it.
 *   - `attachments` are merged into the prompt by prompt shape:
 *       · ContentPart[]  → attachments prepended to the parts;
 *       · Message[]      → attachments prepended INSIDE the first user
 *         message (a string body becomes a text part after them), leaving the
 *         other messages untouched;
 *       · Message[] with no user message → a new trailing user message.
 *     Attachments must never become their own leading message in the Message[]
 *     case, or the model sees the picture before the system prompt applies.
 *   - `structured.schema` populates `parsed` from the reply text.
 *   - A bare model with no provider still fails with the createLLM message.
 *
 *  No network: engine.fetch is a stub that answers by URL. */

import { describe, expect, it } from 'bun:test';
import { complete } from '../../../src/helpers/one-shot';
import { HookBus } from '../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../src/catalog/catalog';
import type { EngineHandle } from '../../../src/helpers/engine';
import type { EngineFetch, HttpResponse } from '../../../src/network/types';
import type { ContentPart, Message } from '../../../src/llm/types/messages';

// ─── Canned provider bodies ───────────────────────────────────────────────────

function anthropicBody(text = 'hi'): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function openaiChatBody(text = 'hi'): Record<string, unknown> {
  return {
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-5-nano',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function openaiResponsesBody(text = 'hi'): Record<string, unknown> {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 1,
    model: 'gpt-5-nano',
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

// ─── Engine stub ──────────────────────────────────────────────────────────────

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function makeEngine(text = 'hi'): EngineHandle & { captured: Captured[] } {
  const captured: Captured[] = [];
  const fetch: EngineFetch = async (req): Promise<HttpResponse> => {
    const body = (req.body as Record<string, unknown>) ?? {};
    captured.push({ url: req.url, body });
    if (req.url.includes('anthropic')) return { status: 200, headers: {}, body: anthropicBody(text) };
    if (req.url.includes('/chat/completions'))
      return { status: 200, headers: {}, body: openaiChatBody(text) };
    return { status: 200, headers: {}, body: openaiResponsesBody(text) };
  };
  return {
    apiKeys: { anthropic: 'test-key', openai: 'test-key' },
    catalog: new ModelCatalog(),
    hooks: new HookBus(),
    fetch,
    fetchStream: async function* () {},
    sessionId: 'sess_test',
    destroy: () => {},
    captured,
  } as unknown as EngineHandle & { captured: Captured[] };
}

const AUDIO_PART: ContentPart = {
  type: 'audio',
  source: { type: 'base64', mimeType: 'audio/wav', data: 'QUJD' },
} as ContentPart;

const IMAGE_ATTACHMENT: ContentPart = {
  type: 'image',
  source: { type: 'url', url: 'https://example.invalid/pic.png' },
} as ContentPart;

// ─── OpenAI audio auto-routing ────────────────────────────────────────────────

describe('complete() — OpenAI audio input is routed to chat completions', () => {
  it('re-routes when the ContentPart[] prompt carries an audio part', async () => {
    const engine = makeEngine();
    await complete({ engine, model: 'openai/gpt-5-nano', prompt: [AUDIO_PART] });
    expect(engine.captured[0].url).toContain('/chat/completions');
  });

  it('re-routes when a Message[] prompt carries an audio part', async () => {
    const engine = makeEngine();
    const prompt: Message[] = [{ role: 'user', content: [AUDIO_PART] }];
    await complete({ engine, model: 'openai/gpt-5-nano', prompt });
    expect(engine.captured[0].url).toContain('/chat/completions');
  });

  it('stays on the Responses API when no part is audio', async () => {
    const engine = makeEngine();
    await complete({
      engine,
      model: 'openai/gpt-5-nano',
      prompt: [{ type: 'text', text: 'hello' } as ContentPart],
    });
    expect(engine.captured[0].url).toContain('/responses');
    expect(engine.captured[0].url).not.toContain('/chat/completions');
  });

  it('stays on the Responses API for a Message[] prompt with no audio', async () => {
    const engine = makeEngine();
    const prompt: Message[] = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [{ type: 'text', text: 'hello' } as ContentPart] },
    ];
    await complete({ engine, model: 'openai/gpt-5-nano', prompt });
    expect(engine.captured[0].url).toContain('/responses');
  });

  it('stays on the Responses API for a plain string prompt', async () => {
    const engine = makeEngine();
    await complete({ engine, model: 'openai/gpt-5-nano', prompt: 'hello' });
    expect(engine.captured[0].url).toContain('/responses');
  });

  it('does not re-route audio for a non-OpenAI provider', async () => {
    const engine = makeEngine();
    await complete({ engine, model: 'anthropic/claude-haiku-4-5', prompt: 'hello' });
    expect(engine.captured[0].url).toContain('anthropic');
  });

  it('an explicit client.api pins the API even with audio present', async () => {
    const engine = makeEngine();
    await complete({
      engine,
      model: 'openai/gpt-5-nano',
      prompt: [AUDIO_PART],
      client: { api: 'responses' },
    });
    expect(engine.captured[0].url).toContain('/responses');
  });
});

// ─── Model / provider resolution ──────────────────────────────────────────────

describe('complete() — model resolution', () => {
  it('rejects a bare model with no provider, naming createLLM', async () => {
    const engine = makeEngine();
    await expect(complete({ engine, model: 'gpt-5-nano', prompt: 'hi' })).rejects.toThrow(
      /createLLM: bare model "gpt-5-nano" requires a provider/,
    );
  });
});

// ─── Attachments ──────────────────────────────────────────────────────────────

/** The messages the provider actually received (Anthropic wire shape). */
function sentMessages(engine: { captured: Captured[] }): Array<{ role: string; content: unknown }> {
  return engine.captured[0].body.messages as Array<{ role: string; content: unknown }>;
}

describe('complete() — attachments merged by prompt shape', () => {
  it('prepends attachments to a ContentPart[] prompt', async () => {
    const engine = makeEngine();
    await complete({
      engine,
      model: 'anthropic/claude-haiku-4-5',
      prompt: [{ type: 'text', text: 'describe' } as ContentPart],
      attachments: [IMAGE_ATTACHMENT],
    });
    const content = sentMessages(engine)[0].content as Array<{ type: string }>;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('image');
    expect(content[1].type).toBe('text');
  });

  it('merges into the first user message of a Message[] prompt, keeping order', async () => {
    const engine = makeEngine();
    const prompt: Message[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: 'second' },
    ];
    await complete({
      engine,
      model: 'anthropic/claude-haiku-4-5',
      prompt,
      attachments: [IMAGE_ATTACHMENT],
    });
    const messages = sentMessages(engine);
    expect(messages).toHaveLength(3);
    const first = messages[0].content as Array<{ type: string; text?: string }>;
    expect(first[0].type).toBe('image');
    expect(first[1]).toMatchObject({ type: 'text', text: 'first' });
    // The later user message is left alone.
    expect(messages[2].content).toEqual([{ type: 'text', text: 'second' }]);
  });

  it('merges ahead of the existing parts when the first user message is already parts', async () => {
    const engine = makeEngine();
    const prompt: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' } as ContentPart, { type: 'text', text: 'b' } as ContentPart] },
    ];
    await complete({
      engine,
      model: 'anthropic/claude-haiku-4-5',
      prompt,
      attachments: [IMAGE_ATTACHMENT],
    });
    const content = sentMessages(engine)[0].content as Array<{ type: string; text?: string }>;
    expect(content.map((p) => p.type)).toEqual(['image', 'text', 'text']);
    expect(content[1].text).toBe('a');
  });

  it('does not mutate the caller’s messages array', async () => {
    const engine = makeEngine();
    const prompt: Message[] = [{ role: 'user', content: 'first' }];
    await complete({
      engine,
      model: 'anthropic/claude-haiku-4-5',
      prompt,
      attachments: [IMAGE_ATTACHMENT],
    });
    expect(prompt).toEqual([{ role: 'user', content: 'first' }]);
  });

  it('appends a new user message when the Message[] prompt has no user turn', async () => {
    const engine = makeEngine();
    const prompt: Message[] = [{ role: 'assistant', content: 'I went first' }];
    await complete({
      engine,
      model: 'anthropic/claude-haiku-4-5',
      prompt,
      attachments: [IMAGE_ATTACHMENT],
    });
    const messages = sentMessages(engine);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe('user');
    expect((messages[1].content as Array<{ type: string }>)[0].type).toBe('image');
  });

  it('leaves the prompt untouched when attachments is an empty array', async () => {
    const engine = makeEngine();
    await complete({
      engine,
      model: 'anthropic/claude-haiku-4-5',
      prompt: 'plain',
      attachments: [],
    });
    expect(sentMessages(engine)[0].content).toEqual([{ type: 'text', text: 'plain' }]);
  });
});

// ─── Structured output ────────────────────────────────────────────────────────

describe('complete() — structured output', () => {
  it('parses the reply into `parsed` when a schema is given', async () => {
    const engine = makeEngine('{"city":"Oslo","temp":12}');
    const res = await complete<{ city: string; temp: number }>({
      engine,
      model: 'anthropic/claude-haiku-4-5',
      prompt: 'weather',
      structured: { schema: { type: 'object', properties: { city: { type: 'string' } } } },
    });
    expect(res.parsed).toEqual({ city: 'Oslo', temp: 12 });
    expect(res.text).toBe('{"city":"Oslo","temp":12}');
  });

  it('leaves `parsed` undefined when no schema is given', async () => {
    const engine = makeEngine('{"city":"Oslo"}');
    const res = await complete({ engine, model: 'anthropic/claude-haiku-4-5', prompt: 'weather' });
    expect(res.parsed).toBeUndefined();
  });
});
