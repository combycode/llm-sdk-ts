/** dispatch() — the seam between an OAI-shaped request and an AgentLoop.
 *
 *  Four behaviours live here and nowhere else:
 *    - a caller-supplied AgentLoop is REUSED verbatim (the loader owns system
 *      prompt / tools / history; dispatch must not rebuild or override it)
 *    - client-declared tools are exposed to the model but throw if executed
 *    - an internal tool with the same name WINS over a client-declared one
 *    - the provider's own response id is captured off `onCompletion`, and only
 *      for the target model — a concurrent call on another model must not leak
 *      its id into this response. */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { ConversationHistory } from '../../../src/agent/history';
import type { AgentTool } from '../../../src/agent/types';
import { HookBus } from '../../../src/bus/hook-bus';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ExecuteOptions } from '../../../src/llm/types/options';
import { dispatch } from '../../../src/server/dispatch';
import { ModelRouter } from '../../../src/server/router';

const usage = {
  inputTokens: 7,
  outputTokens: 4,
  totalTokens: 11,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

/** A client that answers with `text`, records the options it was handed, and
 *  optionally emits `onCompletion` the way a real client does. */
function makeMockClient(opts: {
  text?: string;
  hooks?: HookBus;
  model?: string;
  emitCompletionId?: string;
  emitCompletionModel?: string;
}): LLMClient & { seen: ExecuteOptions[] } {
  const seen: ExecuteOptions[] = [];
  const hooks = opts.hooks ?? new HookBus();
  const text = opts.text ?? 'ok';
  return {
    id: 'client-mock',
    provider: 'mock',
    model: opts.model ?? 'mock-model',
    hooks,
    api: 'completions',
    mode: 'foreground',
    batchable: false,
    seen,
    async complete(_input: unknown, options: ExecuteOptions = {}): Promise<CompletionResponse> {
      seen.push(options);
      const response = {
        id: opts.emitCompletionId ?? 'r1',
        model: opts.model ?? 'mock-model',
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage,
        text,
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      } as unknown as CompletionResponse;
      if (opts.emitCompletionId !== undefined) {
        await hooks.emit('onCompletion', {
          provider: 'mock',
          model: opts.emitCompletionModel ?? opts.model ?? 'mock-model',
          response,
          request: { estimatedInputTokens: 1, inputChars: 1, messageCount: 1, hasTools: false },
          ctx: {} as never,
        });
      }
      return response;
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient & { seen: ExecuteOptions[] };
}

const target = (entry: Parameters<ModelRouter['register']>[0]) =>
  new ModelRouter({ entries: [entry] }).resolve(entry.model);

const tool = (name: string, result: string): AgentTool => ({
  definition: { name, description: name, parameters: {} },
  execute: async () => result,
});

describe('dispatch — plain path', () => {
  it('returns the assistant text and the provider token counts', async () => {
    const hooks = new HookBus();
    const history = new ConversationHistory();
    const res = await dispatch({
      target: target({ model: 'fast', client: makeMockClient({ text: 'hello', hooks }) }),
      history,
      userText: 'hi',
      hooks,
    });
    expect(res.text).toBe('hello');
    expect(res.inputTokens).toBe(7);
    expect(res.outputTokens).toBe(4);
    // The history it was given is the one that got the turn appended.
    expect(history.length).toBe(2);
  });

  it('forwards systemPrompt / maxOutputTokens / temperature into the loop', async () => {
    const hooks = new HookBus();
    const client = makeMockClient({ hooks });
    await dispatch({
      target: target({ model: 'fast', client }),
      history: new ConversationHistory(),
      userText: 'hi',
      systemPrompt: 'be terse',
      maxOutputTokens: 128,
      temperature: 0.25,
      hooks,
    });
    expect(client.seen[0].maxTokens).toBe(128);
    expect(client.seen[0].temperature).toBe(0.25);
    expect(client.seen[0].system).toContain('be terse');
  });
});

describe('dispatch — provider response id capture', () => {
  it('captures response.id only when the entry declares supportsPreviousResponseId', async () => {
    const hooks = new HookBus();
    const client = makeMockClient({ hooks, emitCompletionId: 'resp_provider_1' });

    const off = await dispatch({
      target: target({ model: 'mock-model', client }),
      history: new ConversationHistory(),
      userText: 'hi',
      hooks,
    });
    expect(off.providerResponseId).toBeNull();

    const on = await dispatch({
      target: target({
        model: 'mock-model',
        client,
        capabilities: { supportsPreviousResponseId: true },
      }),
      history: new ConversationHistory(),
      userText: 'hi',
      hooks,
    });
    expect(on.providerResponseId).toBe('resp_provider_1');
  });

  it('ignores a completion emitted for a DIFFERENT model on the same bus', async () => {
    const hooks = new HookBus();
    // The client is registered as `mock-model` but reports `other-model` on the
    // hook — a shared bus with two clients on it. The id must not be adopted.
    const client = makeMockClient({
      hooks,
      emitCompletionId: 'resp_wrong_model',
      emitCompletionModel: 'other-model',
    });
    const res = await dispatch({
      target: target({
        model: 'mock-model',
        client,
        capabilities: { supportsPreviousResponseId: true },
      }),
      history: new ConversationHistory(),
      userText: 'hi',
      hooks,
    });
    expect(res.providerResponseId).toBeNull();
  });

  it('ignores an empty response id', async () => {
    const hooks = new HookBus();
    const client = makeMockClient({ hooks, emitCompletionId: '' });
    const res = await dispatch({
      target: target({
        model: 'mock-model',
        client,
        capabilities: { supportsPreviousResponseId: true },
      }),
      history: new ConversationHistory(),
      userText: 'hi',
      hooks,
    });
    expect(res.providerResponseId).toBeNull();
  });

  it('unsubscribes after the run — a later completion cannot mutate a past result', async () => {
    const hooks = new HookBus();
    const client = makeMockClient({ hooks, emitCompletionId: 'resp_1' });
    const t = target({
      model: 'mock-model',
      client,
      capabilities: { supportsPreviousResponseId: true },
    });
    await dispatch({ target: t, history: new ConversationHistory(), userText: 'hi', hooks });
    // The capture subscription is gone. A leaked one would keep firing on every
    // later run that shares this bus — the earlier test proves it was there while
    // the call was in flight, this one proves it does not outlive the call.
    expect(hooks.has('onCompletion')).toBe(false);
    await dispatch({ target: t, history: new ConversationHistory(), userText: 'hi', hooks });
    expect(hooks.has('onCompletion')).toBe(false);
  });
});

/** A client that calls `toolName` on its first turn and answers on the second. */
function makeToolCallingClient(hooks: HookBus, toolName: string): LLMClient {
  let call = 0;
  return {
    id: 'c',
    provider: 'mock',
    model: 'm',
    hooks,
    api: 'completions',
    mode: 'foreground',
    batchable: false,
    async complete() {
      call++;
      if (call === 1) {
        const tc = { type: 'tool_call', id: 'c1', name: toolName, arguments: {} };
        return {
          id: 'r1',
          model: 'm',
          content: [tc],
          finishReason: 'tool_use',
          usage,
          text: '',
          toolCalls: [tc],
          thinking: null,
          media: [],
          latencyMs: 1,
          raw: null,
        } as unknown as CompletionResponse;
      }
      return {
        id: 'r2',
        model: 'm',
        content: [{ type: 'text', text: 'sunny' }],
        finishReason: 'stop',
        usage,
        text: 'sunny',
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      } as unknown as CompletionResponse;
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
}

/** The text of the first tool_result written back into the history. */
const firstToolResult = (h: ConversationHistory): string =>
  (h.byRole('tool')[0].message.content as Array<{ content: string }>)[0].content;

describe('dispatch — tools', () => {
  it('client-declared tools reach the model but throw when the model calls one', async () => {
    const hooks = new HookBus();
    const client = makeToolCallingClient(hooks, 'get_weather');
    const history = new ConversationHistory();
    const res = await dispatch({
      target: target({ model: 'm', client }),
      history,
      userText: 'weather?',
      externalTools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } },
        },
      ],
      hooks,
    });
    expect(res.text).toBe('sunny');
    // The tool_result the model got back says the server will not run it.
    expect(firstToolResult(history)).toContain("client-defined tools aren't executed");
  });

  it('drops client tools entirely when the entry sets allowExternalTools: false', async () => {
    const hooks = new HookBus();
    const client = makeMockClient({ hooks, model: 'm' });
    await dispatch({
      target: target({ model: 'm', client, allowExternalTools: false }),
      history: new ConversationHistory(),
      userText: 'hi',
      externalTools: [
        { type: 'function', function: { name: 'get_weather', parameters: {} } },
      ],
      hooks,
    });
    expect(client.seen[0].tools ?? []).toHaveLength(0);
  });

  it('an internal tool WINS over a client tool of the same name — and still EXECUTES', async () => {
    const hooks = new HookBus();
    const client = makeToolCallingClient(hooks, 'get_weather');
    const history = new ConversationHistory();
    await dispatch({
      target: target({
        model: 'm',
        client,
        internalTools: [tool('get_weather', 'internal-result')],
      }),
      history,
      userText: 'hi',
      externalTools: [
        { type: 'function', function: { name: 'get_weather', parameters: {} } },
        { type: 'function', function: { name: 'other', parameters: {} } },
      ],
      hooks,
    });
    // Dropping the collision check would let the client's throw-on-execute stub
    // shadow the server tool — the model would get an error instead of an answer.
    expect(firstToolResult(history)).toBe('internal-result');
  });

  it('a non-colliding client tool is still merged in alongside the internal ones', async () => {
    const hooks = new HookBus();
    const client = makeMockClient({ hooks, model: 'm' });
    await dispatch({
      target: target({
        model: 'm',
        client,
        internalTools: [tool('get_weather', 'internal-result')],
      }),
      history: new ConversationHistory(),
      userText: 'hi',
      externalTools: [
        { type: 'function', function: { name: 'get_weather', parameters: {} } },
        { type: 'function', function: { name: 'other', parameters: {} } },
      ],
      hooks,
    });
    const names = (client.seen[0].tools ?? []).map((t) => (t as { name?: string }).name);
    expect(names).toEqual(['get_weather', 'other']);
  });

  it('skips non-function entries in the client tool list', async () => {
    const hooks = new HookBus();
    const client = makeMockClient({ hooks, model: 'm' });
    await dispatch({
      target: target({ model: 'm', client }),
      history: new ConversationHistory(),
      userText: 'hi',
      externalTools: [
        { type: 'not_a_function', function: { name: 'x', parameters: {} } } as never,
        { type: 'function', function: { name: 'ok', parameters: {} } },
      ],
      hooks,
    });
    const names = (client.seen[0].tools ?? []).map((t) => (t as { name?: string }).name);
    expect(names).toEqual(['ok']);
  });

  it('an empty client tool list adds nothing', async () => {
    const hooks = new HookBus();
    const client = makeMockClient({ hooks, model: 'm' });
    await dispatch({
      target: target({ model: 'm', client }),
      history: new ConversationHistory(),
      userText: 'hi',
      externalTools: [],
      hooks,
    });
    expect(client.seen[0].tools ?? []).toHaveLength(0);
  });
});

describe('dispatch — caller-supplied AgentLoop', () => {
  it('reuses the given loop and does NOT overwrite its system prompt or tools', async () => {
    const hooks = new HookBus();
    const client = makeMockClient({ hooks, model: 'm' });
    const loaderHistory = new ConversationHistory();
    const loop = new AgentLoop({
      client,
      hooks,
      system: 'loader-owned system',
      history: loaderHistory,
      tools: [tool('loader_tool', 'x')],
    });

    const dispatchHistory = new ConversationHistory();
    await dispatch({
      target: target({ model: 'm', client }),
      history: dispatchHistory,
      userText: 'hi',
      systemPrompt: 'server-owned system',
      hooks,
      agentLoop: loop,
    });

    // The loader's system prompt survived, and the loader's history got the turn —
    // the history dispatch was handed is untouched.
    expect(loop.system).toBe('loader-owned system');
    expect(client.seen[0].system).toContain('loader-owned system');
    expect(client.seen[0].system).not.toContain('server-owned system');
    expect(loaderHistory.length).toBe(2);
    expect(dispatchHistory.length).toBe(0);
    expect(loop.toolNames()).toEqual(['loader_tool']);
  });
});
