/** Verify that onMcpToolCall fires with trace.sessionId/requestId matching the
 *  AgentLoop run when an MCP tool is invoked through the loop. Uses a stubbed
 *  McpClient (MockTransport) wired as an AgentTool via mcpToolToAgentTool. */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../../src/agent/loop';
import { HookBus } from '../../../../src/bus/hook-bus';
import { McpClient } from '../../../../src/plugins/mcp/client';
import { mcpToolToAgentTool } from '../../../../src/plugins/mcp/tools';
import type { McpToolCallContext } from '../../../../src/bus/hook-map';
import type { IncomingMcpHandlers, McpTransport } from '../../../../src/plugins/mcp/transport';
import type { LLMClient } from '../../../../src/llm/client';
import type { CompletionResponse } from '../../../../src/llm/types/response';
import type { ContentPart } from '../../../../src/llm/types/messages';

// ─── MockTransport (same shape as client.test.ts) ───────────────────────────

class MockTransport implements McpTransport {
  handlers: IncomingMcpHandlers = {};
  constructor(private readonly handler: (method: string, params: unknown) => unknown) {}
  async start() {}
  setHandlers(h: IncomingMcpHandlers) { this.handlers = h; }
  setProtocolVersion() {}
  listen() {}
  async request(method: string, params?: unknown) { return this.handler(method, params); }
  async notify() {}
  async close() {}
}

// ─── Minimal mock LLM client ─────────────────────────────────────────────────

const MOCK_USAGE = {
  inputTokens: 1, outputTokens: 1, totalTokens: 2,
  cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
};

function makeSequentialClient(
  responses: Array<Partial<CompletionResponse> & { content: ContentPart[] }>,
): LLMClient {
  const queue = [...responses];
  return {
    id: 'mock', provider: 'mock' as const, model: 'mock-model',
    system: undefined, hooks: new HookBus(), api: 'completions' as const,
    mode: 'foreground' as const, batchable: false,
    async complete(): Promise<CompletionResponse> {
      const next = queue.shift() ?? { content: [{ type: 'text' as const, text: 'done' }], finishReason: 'stop' as const };
      const textParts = (next.content ?? []).filter(
        (p): p is { type: 'text'; text: string } => p.type === 'text',
      );
      return {
        id: `r-${Math.random()}`, model: 'mock-model',
        content: next.content ?? [], finishReason: next.finishReason ?? 'stop',
        usage: next.usage ?? MOCK_USAGE, text: textParts.map((p) => p.text).join(''),
        toolCalls: (next.toolCalls ?? []) as import('../../../../src/llm/types/messages').ToolCallPart[],
        thinking: null, media: [], latencyMs: 1, raw: null,
      };
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MCP tool trace threading through AgentLoop', () => {
  it('onMcpToolCall fires with trace matching the loop run when invoked via AgentLoop', async () => {
    const transport = new MockTransport((method) => {
      if (method === 'initialize') {
        return { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } };
      }
      if (method === 'tools/call') {
        return { content: [{ type: 'text', text: 'mcp-result' }] };
      }
      return {};
    });

    const hooks = new HookBus();
    const mcpToolCalls: McpToolCallContext[] = [];
    hooks.on('onMcpToolCall', (ctx) => { mcpToolCalls.push({ ...ctx }); });

    const mcpClient = new McpClient(transport, { hooks, server: 'stub-server' });
    await mcpClient.connect();

    const toolDef = { name: 'echo', inputSchema: { type: 'object' as const, properties: {} } };
    const agentTool = mcpToolToAgentTool(mcpClient, toolDef, 'stub');

    const tc: ContentPart = {
      type: 'tool_call', id: 'tc-1', name: 'stub__echo', arguments: {},
    } as unknown as ContentPart;
    const llmClient = makeSequentialClient([
      {
        content: [tc],
        finishReason: 'tool_use',
        toolCalls: [tc as import('../../../../src/llm/types/messages').ToolCallPart],
        usage: MOCK_USAGE,
      },
      {
        content: [{ type: 'text', text: 'final' }],
        finishReason: 'stop',
        usage: MOCK_USAGE,
      },
    ]);

    const loop = new AgentLoop({ client: llmClient, tools: [agentTool], hooks });
    await loop.complete('call the echo tool');

    expect(mcpToolCalls.length).toBe(1);
    expect(mcpToolCalls[0].tool).toBe('echo');
    expect(mcpToolCalls[0].server).toBe('stub-server');
    expect(mcpToolCalls[0].trace).toBeDefined();
    // sessionId = agentId = loop.id
    expect(mcpToolCalls[0].trace!.sessionId).toBe(loop.id);
    // requestId = runId for this .complete() invocation — a non-empty UUID string
    expect(typeof mcpToolCalls[0].trace!.requestId).toBe('string');
    expect(mcpToolCalls[0].trace!.requestId!.length).toBeGreaterThan(0);
  });
});
