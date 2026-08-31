/** MCP sampling: a server asks US to run a completion (`sampling/createMessage`), and this module
 *  translates between MCP's message shape and ours.
 *
 *  Everything here is pure mapping — the `complete` function is injected, so no provider is
 *  contacted. The mapping is the whole contract: a port that gets the image/audio source shape or
 *  the stopReason vocabulary wrong produces a handler that "works" until a server actually sends
 *  media or hits a token cap. */

import { describe, expect, it } from 'bun:test';
import { samplingHandlerWith, type McpCompleteFn } from '../../../../src/plugins/mcp/sampling';
import type { McpCreateMessageParams, McpCreateMessageResult } from '../../../../src/plugins/mcp/types';

type CompleteArgs = Parameters<McpCompleteFn>[0];

/** A `complete` that records its arguments and answers with a fixed result. */
function recordingComplete(
  result: { text: string; response: { model: string; finishReason: string } } = {
    text: 'the answer',
    response: { model: 'claude-x', finishReason: 'stop' },
  },
) {
  const calls: CompleteArgs[] = [];
  const complete: McpCompleteFn = async (args) => {
    calls.push(args);
    return result;
  };
  return { complete, calls };
}

const textParams = (over: Partial<McpCreateMessageParams> = {}): McpCreateMessageParams => ({
  messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
  maxTokens: 256,
  ...over,
});

describe('samplingHandlerWith: custom handler', () => {
  it('passes a function config straight through, untouched', async () => {
    // A caller who supplied their own handler must reach the model they chose, not ours.
    const custom = async (): Promise<McpCreateMessageResult> => ({
      role: 'assistant',
      content: { type: 'text', text: 'mine' },
      model: 'custom-model',
    });
    const { complete, calls } = recordingComplete();
    const handler = samplingHandlerWith(complete, custom);

    expect(handler).toBe(custom);
    expect(await handler(textParams())).toEqual({
      role: 'assistant',
      content: { type: 'text', text: 'mine' },
      model: 'custom-model',
    });
    expect(calls).toHaveLength(0); // our engine was never asked
  });
});

describe('samplingHandlerWith: auto-wired model', () => {
  it('forwards model, provider, engine and the sampling knobs to complete()', async () => {
    const engine = { marker: 'engine-handle' } as never;
    const { complete, calls } = recordingComplete();
    const handler = samplingHandlerWith(complete, { model: 'gpt-x', provider: 'openai', engine });

    await handler(textParams({ systemPrompt: 'be brief', maxTokens: 64, temperature: 0.2 }));

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('gpt-x');
    expect(calls[0].provider).toBe('openai');
    expect(calls[0].engine).toBe(engine);
    expect(calls[0].system).toBe('be brief');
    expect(calls[0].maxTokens).toBe(64);
    expect(calls[0].temperature).toBe(0.2);
  });

  it('answers in MCP shape: assistant role, text block, and the model actually used', async () => {
    // `model` is the model that ANSWERED, taken from the response — not the one requested. A server
    // reading it is being told what produced the text.
    const { complete } = recordingComplete({ text: 'the answer', response: { model: 'gpt-x-2026', finishReason: 'stop' } });
    const handler = samplingHandlerWith(complete, { model: 'gpt-x' });

    expect(await handler(textParams())).toEqual({
      role: 'assistant',
      content: { type: 'text', text: 'the answer' },
      model: 'gpt-x-2026',
      stopReason: 'endTurn',
    });
  });

  it("maps finishReason 'length' to MCP 'maxTokens' and 'stop' to 'endTurn'", async () => {
    const capped = samplingHandlerWith(
      recordingComplete({ text: 'cut off', response: { model: 'm', finishReason: 'length' } }).complete,
      { model: 'm' },
    );
    expect((await capped(textParams())).stopReason).toBe('maxTokens');

    const done = samplingHandlerWith(
      recordingComplete({ text: 'done', response: { model: 'm', finishReason: 'stop' } }).complete,
      { model: 'm' },
    );
    expect((await done(textParams())).stopReason).toBe('endTurn');
  });

  it('passes an unmapped finish reason through verbatim rather than inventing one', async () => {
    // MCP's stopReason is an open string. Coercing an unknown reason to 'endTurn' would tell the
    // server the turn finished normally when it did not.
    const handler = samplingHandlerWith(
      recordingComplete({ text: '', response: { model: 'm', finishReason: 'tool_use' } }).complete,
      { model: 'm' },
    );
    expect((await handler(textParams())).stopReason).toBe('tool_use');
  });
});

describe('samplingHandlerWith: message mapping', () => {
  it('keeps roles and flattens a text block to a plain string', async () => {
    const { complete, calls } = recordingComplete();
    await samplingHandlerWith(complete, { model: 'm' })({
      messages: [
        { role: 'user', content: { type: 'text', text: 'question' } },
        { role: 'assistant', content: { type: 'text', text: 'answer' } },
      ],
      maxTokens: 10,
    });
    expect(calls[0].prompt).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ]);
  });

  it('maps an image block to a base64 image part, preserving the mime type', async () => {
    const { complete, calls } = recordingComplete();
    await samplingHandlerWith(complete, { model: 'm' })({
      messages: [{ role: 'user', content: { type: 'image', data: 'QUJD', mimeType: 'image/png' } }],
      maxTokens: 10,
    });
    expect(calls[0].prompt).toEqual([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'QUJD' } }] },
    ]);
  });

  it('maps an audio block to a base64 audio part, preserving the mime type', async () => {
    const { complete, calls } = recordingComplete();
    await samplingHandlerWith(complete, { model: 'm' })({
      messages: [{ role: 'user', content: { type: 'audio', data: 'WVla', mimeType: 'audio/wav' } }],
      maxTokens: 10,
    });
    expect(calls[0].prompt).toEqual([
      { role: 'user', content: [{ type: 'audio', source: { type: 'base64', mimeType: 'audio/wav', data: 'WVla' } }] },
    ]);
  });

  it('degrades an unknown block type to empty content instead of forwarding garbage', async () => {
    // An unmapped block must not reach the provider as an undefined content field — that is a
    // 400 from every provider. Empty content at least keeps the turn well-formed.
    const { complete, calls } = recordingComplete();
    await samplingHandlerWith(complete, { model: 'm' })({
      messages: [{ role: 'user', content: { type: 'resource_link', uri: 'x://1' } as never }],
      maxTokens: 10,
    });
    expect(calls[0].prompt).toEqual([{ role: 'user', content: '' }]);
  });

  it('leaves optional knobs undefined when the server did not send them', async () => {
    const { complete, calls } = recordingComplete();
    await samplingHandlerWith(complete, { model: 'm' })(textParams());
    expect(calls[0].system).toBeUndefined();
    expect(calls[0].temperature).toBeUndefined();
    expect(calls[0].provider).toBeUndefined();
    expect(calls[0].engine).toBeUndefined();
  });
});
