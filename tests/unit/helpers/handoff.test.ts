/** handoff() unit tests — no network, no keys.
 *
 *  Covers:
 *   - returns structured HandoffResult (text, usage, agentName)
 *   - forwards sub-agent usage to the parent via tool result JSON
 *   - applies inputFilter before passing to sub-agent
 *   - flows through onToolCallStart (same AgentTool seam as delegate) */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { handoff } from '../../../src/helpers/handoff';
import { HookBus } from '../../../src/bus/hook-bus';
import { isFunctionTool } from '../../../src/llm/types/tools';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { Usage } from '../../../src/llm/types/response';
import type { ToolExecutionContext } from '../../../src/agent/types';
import type { Message } from '../../../src/llm/types/messages';
import type { ExecuteOptions } from '../../../src/llm/types/options';
import type { HandoffResult } from '../../../src/helpers/handoff-types';
import type { ToolCallStartContext } from '../../../src/bus/hook-map';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOOP_CTX = {} as ToolExecutionContext;

const MOCK_USAGE: Usage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function mockSubAgent(replyText: string, usage: Usage = MOCK_USAGE): AgentLoop {
  const client: LLMClient = {
    id: 'sub-client',
    provider: 'mock' as const,
    model: 'mock-model',
    system: undefined,
    hooks: new HookBus(),
    api: 'completions' as const,
    mode: 'foreground' as const,
    batchable: false,
    async complete(): Promise<CompletionResponse> {
      return {
        id: 'sub-resp',
        model: 'mock-model',
        content: [{ type: 'text', text: replyText }],
        finishReason: 'stop',
        usage,
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

  return new AgentLoop({ client, hooks: new HookBus() });
}

/** Sub-agent that captures the input it received. */
function capturingSubAgent(): { agent: AgentLoop; received: string[] } {
  const received: string[] = [];
  const client: LLMClient = {
    id: 'cap-client',
    provider: 'mock' as const,
    model: 'mock-model',
    system: undefined,
    hooks: new HookBus(),
    api: 'completions' as const,
    mode: 'foreground' as const,
    batchable: false,
    async complete(msgs: Message[], _opts: ExecuteOptions): Promise<CompletionResponse> {
      const last = msgs.at(-1);
      if (last && typeof last.content === 'string') received.push(last.content);
      return {
        id: 'r',
        model: 'mock-model',
        content: [{ type: 'text', text: 'reply' }],
        finishReason: 'stop',
        usage: MOCK_USAGE,
        text: 'reply',
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

  return { agent: new AgentLoop({ client, hooks: new HookBus() }), received };
}

// ─── Tool shape ───────────────────────────────────────────────────────────────

describe('handoff — tool shape', () => {
  it('produces a FunctionTool with the supplied name and description', () => {
    const agent = mockSubAgent('ok');
    const tool = handoff('writer', 'Writes content', agent);
    expect(isFunctionTool(tool.definition)).toBe(true);
    if (isFunctionTool(tool.definition)) {
      expect(tool.definition.name).toBe('writer');
      expect(tool.definition.description).toBe('Writes content');
    }
  });

  it('tool parameters schema has a required "task" string field', () => {
    const agent = mockSubAgent('ok');
    const tool = handoff('worker', 'Does work', agent);
    expect(isFunctionTool(tool.definition)).toBe(true);
    if (isFunctionTool(tool.definition)) {
      const props = (tool.definition.parameters as Record<string, unknown>).properties as Record<string, unknown>;
      expect(props.task).toEqual({ type: 'string' });
      const required = (tool.definition.parameters as Record<string, unknown>).required as string[];
      expect(required).toContain('task');
    }
  });
});

// ─── HandoffResult structure ──────────────────────────────────────────────────

describe('handoff — HandoffResult', () => {
  it('returns JSON-serialised HandoffResult with text, usage, and agentName', async () => {
    const agent = mockSubAgent('The answer is 42.', MOCK_USAGE);
    const tool = handoff('oracle', 'Knows all', agent);
    const raw = await tool.execute({ task: 'What is the answer?' }, NOOP_CTX);
    expect(typeof raw).toBe('string');
    const result = JSON.parse(raw as string) as HandoffResult;
    expect(result.text).toBe('The answer is 42.');
    expect(result.agentName).toBe('oracle');
    expect(result.usage).not.toBeNull();
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it('agentName in result matches the name passed to handoff()', async () => {
    const agent = mockSubAgent('reply');
    const tool = handoff('specialist', 'desc', agent);
    const raw = await tool.execute({ task: 'task' }, NOOP_CTX);
    const result = JSON.parse(raw as string) as HandoffResult;
    expect(result.agentName).toBe('specialist');
  });

  it('usage is forwarded from the sub-agent run', async () => {
    const customUsage: Usage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const agent = mockSubAgent('answer', customUsage);
    const tool = handoff('sub', 'desc', agent);
    const raw = await tool.execute({ task: 't' }, NOOP_CTX);
    const result = JSON.parse(raw as string) as HandoffResult;
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
  });
});

// ─── inputFilter ──────────────────────────────────────────────────────────────

describe('handoff — inputFilter', () => {
  it('applies inputFilter before forwarding task to sub-agent', async () => {
    const { agent, received } = capturingSubAgent();
    const tool = handoff('filtered', 'desc', agent, {
      inputFilter: (t) => `PREPENDED: ${t}`,
    });
    await tool.execute({ task: 'original task' }, NOOP_CTX);
    expect(received.some((r) => r.includes('PREPENDED: original task'))).toBe(true);
  });

  it('without inputFilter forwards the task unchanged', async () => {
    const { agent, received } = capturingSubAgent();
    const tool = handoff('plain', 'desc', agent);
    await tool.execute({ task: 'raw task' }, NOOP_CTX);
    expect(received.some((r) => r.includes('raw task'))).toBe(true);
  });
});

// ─── onToolCallStart flow ─────────────────────────────────────────────────────

describe('handoff — flows through onToolCallStart', () => {
  it('onToolCallStart fires when handoff tool is called from a parent loop', async () => {
    const hooks = new HookBus();
    const toolCallStarts: ToolCallStartContext[] = [];
    hooks.on('onToolCallStart', (ctx) => {
      toolCallStarts.push(ctx);
    });

    // Sub-agent
    const subAgent = mockSubAgent('sub reply');

    // Parent client: first call triggers handoff tool, second ends the loop.
    const parentResponses: Array<Partial<CompletionResponse> & { content?: CompletionResponse['content'] }> = [
      {
        content: [{
          type: 'tool_call',
          id: 'hc1',
          name: 'sub',
          arguments: { task: 'do it' },
        }],
        finishReason: 'tool_use',
        toolCalls: [{
          type: 'tool_call',
          id: 'hc1',
          name: 'sub',
          arguments: { task: 'do it' },
        }],
      },
      {
        content: [{ type: 'text', text: 'final' }],
        finishReason: 'stop',
      },
    ];

    const parentClient: LLMClient = (() => {
      const queue = [...parentResponses];
      return {
        id: 'parent',
        provider: 'mock' as const,
        model: 'mock-model',
        system: undefined,
        hooks,
        api: 'completions' as const,
        mode: 'foreground' as const,
        batchable: false,
        async complete(): Promise<CompletionResponse> {
          const next = queue.shift()!;
          const content = next.content ?? [{ type: 'text', text: 'done' }];
          return {
            id: 'pr',
            model: 'mock-model',
            content,
            finishReason: next.finishReason ?? 'stop',
            usage: {
              inputTokens: 1, outputTokens: 1, totalTokens: 2,
              cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
            },
            text: content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(''),
            toolCalls: next.toolCalls ?? [],
            thinking: null,
            media: [],
            latencyMs: 1,
            raw: null,
          };
        },
        async *stream() {},
        destroy() {},
      } as unknown as LLMClient;
    })();

    const handoffTool = handoff('sub', 'sub-agent', subAgent);
    const parent = new AgentLoop({ client: parentClient, hooks, tools: [handoffTool] });
    const res = await parent.complete('run');

    expect(res.text).toBe('final');
    // onToolCallStart should have fired for the 'sub' tool call
    const handoffCall = toolCallStarts.find((c) => c.toolName === 'sub');
    expect(handoffCall).toBeDefined();
    expect(handoffCall?.callId).toBe('hc1');
  });

  it('onToolCallStart skip overrides the handoff (result is not called)', async () => {
    const hooks = new HookBus();
    hooks.on('onToolCallStart', (ctx) => {
      if (ctx.toolName === 'sub') {
        ctx.skip = true;
        ctx.overrideResult = JSON.stringify({ text: 'short-circuit', usage: null, agentName: 'sub' });
      }
    });

    const subAgent = mockSubAgent('should-not-reach');

    const parentResponses: Array<Partial<CompletionResponse> & { content?: CompletionResponse['content'] }> = [
      {
        content: [{ type: 'tool_call', id: 'c1', name: 'sub', arguments: { task: 'x' } }],
        finishReason: 'tool_use',
        toolCalls: [{ type: 'tool_call', id: 'c1', name: 'sub', arguments: { task: 'x' } }],
      },
      { content: [{ type: 'text', text: 'done' }] },
    ];
    const queue = [...parentResponses];
    const parentClient: LLMClient = {
      id: 'p',
      provider: 'mock' as const,
      model: 'mock-model',
      system: undefined,
      hooks,
      api: 'completions' as const,
      mode: 'foreground' as const,
      batchable: false,
      async complete(): Promise<CompletionResponse> {
        const next = queue.shift()!;
        const content = next.content ?? [{ type: 'text', text: 'ok' }];
        return {
          id: 'r', model: 'mock-model', content,
          finishReason: next.finishReason ?? 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          text: content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(''),
          toolCalls: next.toolCalls ?? [],
          thinking: null, media: [], latencyMs: 1, raw: null,
        };
      },
      async *stream() {},
      destroy() {},
    } as unknown as LLMClient;

    const tool = handoff('sub', 'desc', subAgent);
    const parent = new AgentLoop({ client: parentClient, hooks, tools: [tool] });

    // Sub-agent should never be invoked — hook skipped it.
    // We track by verifying the sub-agent's history stays empty.
    await parent.complete('go');
    expect(subAgent.history.length).toBe(0);
  });
});
