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

// ─── what of an MCP tool definition reaches the model ────────────────────────
//
// A provider's function-tool schema has three slots, so annotations/icons/_meta
// are host-facing and correctly never sent. `outputSchema` is the exception: the
// model CAN be told the shape it will get back (OpenAI Responses `output_schema`),
// and for a long time only hand-written tools could say so.

describe('mcpToolToAgentTool definition', () => {
  const base = { name: 'echo', inputSchema: { type: 'object' as const, properties: {} } };
  const client = null as unknown as McpClient; // never called; only the definition is read

  it('forwards outputSchema so the model can reason over structured output', () => {
    const outputSchema = { type: 'object' as const, properties: { ok: { type: 'boolean' } } };
    const t = mcpToolToAgentTool(client, { ...base, outputSchema }, 'stub');
    expect((t.definition as { outputSchema?: unknown }).outputSchema).toEqual(outputSchema);
  });

  it('omits outputSchema entirely when the server publishes none', () => {
    const t = mcpToolToAgentTool(client, base, 'stub');
    expect('outputSchema' in t.definition).toBe(false);
  });

  it('never leaks host-facing metadata into what the model sees', () => {
    const t = mcpToolToAgentTool(
      client,
      {
        ...base,
        annotations: { readOnlyHint: true, destructiveHint: false },
        icons: [{ src: 'https://example.com/i.png', mimeType: 'image/png' }],
        execution: { taskSupport: 'optional' },
        _meta: { 'io.example/trace': 'abc' },
      },
      'stub',
    );
    // No provider field could carry these, and inventing one would be a silent
    // change to the prompt the model sees.
    expect(Object.keys(t.definition).sort()).toEqual(['description', 'name', 'parameters', 'type']);
  });
});

// ─── declaring an output schema is a promise about the RESULT ────────────────
//
// Forwarding `outputSchema` to the model is only half the contract. OpenAI
// Responses then rejects the turn — "expected a JSON string because the function
// declares output_schema" — if the result comes back as prose. Forwarding it
// without changing the result broke every MCP tool that publishes one, against a
// real server, on a provider the unit tests never reach.

describe('mcpToolToAgentTool result shape', () => {
  const withSchema = {
    name: 'structured',
    inputSchema: { type: 'object' as const, properties: {} },
    outputSchema: { type: 'object' as const, properties: { answer: { type: 'string' } } },
  };
  const stubClient = (res: unknown) => ({ callTool: async () => res }) as unknown as McpClient;
  const ctx = { trace: undefined } as never;

  it('returns structuredContent as a JSON string when the tool declares an output schema', async () => {
    const t = mcpToolToAgentTool(stubClient({ content: [{ type: 'text', text: 'prose' }], structuredContent: { answer: 'x' } }), withSchema, 'ns');
    const out = await t.execute({}, ctx);
    expect(out).toBe('{"answer":"x"}');
    expect(() => JSON.parse(out as string)).not.toThrow();
  });

  it('falls back to content when the server sends no structuredContent', async () => {
    const t = mcpToolToAgentTool(stubClient({ content: [{ type: 'text', text: 'prose' }] }), withSchema, 'ns');
    expect(await t.execute({}, ctx)).toBe('prose');
  });

  it('leaves an error result as readable text rather than dressing it as data', async () => {
    const t = mcpToolToAgentTool(
      stubClient({ content: [{ type: 'text', text: 'boom' }], structuredContent: { answer: 'x' }, isError: true }),
      withSchema,
      'ns',
    );
    expect(await t.execute({}, ctx)).toContain('boom');
  });

  it('is unchanged for a tool with no output schema', async () => {
    const t = mcpToolToAgentTool(
      stubClient({ content: [{ type: 'text', text: 'prose' }], structuredContent: { answer: 'x' } }),
      { name: 'plain', inputSchema: { type: 'object' as const, properties: {} } },
      'ns',
    );
    expect(await t.execute({}, ctx)).toBe('prose');
  });
});
