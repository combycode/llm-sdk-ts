/** delegate() unit tests.
 *  delegate wraps an AgentLoop as an AgentTool. Tests verify:
 *   - produced tool has correct name/description/params shape
 *   - execute() forwards the task to the inner agent and returns its text
 *   - when the inner agent's LLM errors, AgentLoop handles it internally
 *     (returning an empty-text response), so delegate returns the empty string
 *  No network — mock LLMClient used. */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { delegate } from '../../../src/helpers/delegate';
import { HookBus } from '../../../src/bus/hook-bus';
import { isFunctionTool } from '../../../src/llm/types/tools';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ToolExecutionContext } from '../../../src/agent/types';
import type { Message } from '../../../src/llm/types/messages';
import type { ExecuteOptions } from '../../../src/llm/types/options';

const NOOP_CTX = {} as ToolExecutionContext;

// ─── Mock client that returns a canned text response ─────────────────────────

function mockClient(replyText: string): LLMClient {
  return {
    id: 'mock-client',
    provider: 'mock' as const,
    model: 'mock-model',
    system: undefined,
    hooks: new HookBus(),
    api: 'completions' as const,
    mode: 'foreground' as const,
    batchable: false,
    async complete(): Promise<CompletionResponse> {
      return {
        id: 'resp-1',
        model: 'mock-model',
        content: [{ type: 'text', text: replyText }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        text: replyText,
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      };
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
}

/** Client that throws on complete — AgentLoop catches this and returns a
 *  response with finishReason:'error', so delegate returns empty string. */
function mockErrorClient(msg: string): LLMClient {
  return {
    id: 'err-client',
    provider: 'mock' as const,
    model: 'mock-model',
    system: undefined,
    hooks: new HookBus(),
    api: 'completions' as const,
    mode: 'foreground' as const,
    batchable: false,
    async complete(): Promise<CompletionResponse> {
      throw new Error(msg);
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
}

// ─── Tool shape ───────────────────────────────────────────────────────────────

describe('delegate — tool shape', () => {
  it('produces a tool with the supplied name and description', () => {
    const agent = new AgentLoop({ client: mockClient('ok'), hooks: new HookBus() });
    const tool = delegate('sub_agent', 'A helpful sub-agent', agent);
    // defineTool always produces a FunctionTool definition
    expect(isFunctionTool(tool.definition)).toBe(true);
    if (isFunctionTool(tool.definition)) {
      expect(tool.definition.name).toBe('sub_agent');
      expect(tool.definition.description).toBe('A helpful sub-agent');
    }
  });

  it('tool parameters schema has a required string "task" field', () => {
    const agent = new AgentLoop({ client: mockClient('ok'), hooks: new HookBus() });
    const tool = delegate('worker', 'Does work', agent);
    expect(isFunctionTool(tool.definition)).toBe(true);
    if (isFunctionTool(tool.definition)) {
      expect((tool.definition.parameters as Record<string, unknown>).type).toBe('object');
      const props = (tool.definition.parameters as Record<string, unknown>).properties as Record<string, unknown>;
      expect(props.task).toEqual({ type: 'string' });
      const required = (tool.definition.parameters as Record<string, unknown>).required as string[];
      expect(required).toContain('task');
    }
  });

  it('has an execute function', () => {
    const agent = new AgentLoop({ client: mockClient('reply'), hooks: new HookBus() });
    const tool = delegate('t', 'd', agent);
    expect(typeof tool.execute).toBe('function');
  });
});

// ─── execute round-trip ───────────────────────────────────────────────────────

describe('delegate — execute round-trip', () => {
  it('returns the inner agent reply text', async () => {
    const agent = new AgentLoop({ client: mockClient('This is the answer.'), hooks: new HookBus() });
    const tool = delegate('helper', 'Helps', agent);
    const result = await tool.execute({ task: 'What is 2+2?' }, NOOP_CTX);
    expect(result).toBe('This is the answer.');
  });

  it('passes the task string to the inner agent', async () => {
    const seen: string[] = [];
    const captureClient: LLMClient = {
      id: 'c',
      provider: 'mock' as const,
      model: 'mock-model',
      system: undefined,
      hooks: new HookBus(),
      api: 'completions' as const,
      mode: 'foreground' as const,
      batchable: false,
      async complete(input: Message[], _options: ExecuteOptions): Promise<CompletionResponse> {
        // Capture the text from the last user message
        const last = input.at(-1);
        if (last && typeof last.content === 'string') seen.push(last.content);
        return {
          id: 'r',
          model: 'mock-model',
          content: [{ type: 'text', text: 'ok' }],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          text: 'ok',
          toolCalls: [],
          thinking: null,
          media: [],
          latencyMs: 1,
          raw: null,
        };
      },
      async *stream() {},
      destroy() {},
    } as unknown as LLMClient;

    const agent = new AgentLoop({ client: captureClient, hooks: new HookBus() });
    const tool = delegate('worker', 'desc', agent);
    await tool.execute({ task: 'my specific task' }, NOOP_CTX);
    // The last user message content should contain the task string
    const joined = seen.join(' ');
    expect(joined).toContain('my specific task');
  });

  it('when inner agent LLM errors, AgentLoop swallows it and returns empty text', async () => {
    // AgentLoop.complete() catches LLM errors internally (finishReason:'error'),
    // so delegate() returns the (empty) text rather than throwing.
    const agent = new AgentLoop({ client: mockErrorClient('inner failure'), hooks: new HookBus() });
    const tool = delegate('flaky', 'Throws', agent);
    const result = await tool.execute({ task: 'do something' }, NOOP_CTX);
    // AgentLoop returns empty string on error (no lastResponse.text)
    expect(typeof result).toBe('string');
    expect(result).toBe('');
  });
});
