import { describe, expect, it } from 'bun:test';
import { isFunctionTool } from '../../../../src/llm/types/tools';
import type { McpClient } from '../../../../src/plugins/mcp/client';
import { mcpContentToResult, mcpToolToAgentTool } from '../../../../src/plugins/mcp/tools';
import type { McpCallResult, McpToolDef } from '../../../../src/plugins/mcp/types';

describe('mcpContentToResult', () => {
  it('text-only content collapses to a string', () => {
    const r: McpCallResult = { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] };
    expect(mcpContentToResult(r)).toBe('hello world');
  });

  it('isError prefixes the text', () => {
    const r: McpCallResult = { content: [{ type: 'text', text: 'bad input' }], isError: true };
    expect(mcpContentToResult(r)).toBe('Tool error: bad input');
  });

  it('media content becomes ContentPart[] with base64 sources', () => {
    const r: McpCallResult = {
      content: [
        { type: 'text', text: 'see:' },
        { type: 'image', data: 'AAA', mimeType: 'image/png' },
      ],
    };
    const out = mcpContentToResult(r);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([
      { type: 'text', text: 'see:' },
      { type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'AAA' } },
    ]);
  });

  it('embedded text resources flatten into text', () => {
    const r: McpCallResult = { content: [{ type: 'resource', resource: { uri: 'x://1', text: 'doc body' } }] };
    expect(mcpContentToResult(r)).toBe('doc body');
  });
});

describe('mcpToolToAgentTool', () => {
  const def: McpToolDef = {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: { type: 'object', properties: { a: { type: 'number' } } },
  };

  it('namespaces the tool name but calls the server with the raw name', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const fakeClient = {
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { content: [{ type: 'text', text: '3' }] } as McpCallResult;
      },
    } as unknown as McpClient;

    const tool = mcpToolToAgentTool(fakeClient, def, 'calc');
    expect(isFunctionTool(tool.definition)).toBe(true);
    if (isFunctionTool(tool.definition)) {
      expect(tool.definition.name).toBe('calc__add');
      expect(tool.definition.parameters).toEqual(def.inputSchema);
    }

    const ctx = { step: 0, callId: 'c', signal: new AbortController().signal, metrics: new Map() };
    const result = await tool.execute({ a: 1, b: 2 }, ctx);
    expect(result).toBe('3');
    expect(calls).toEqual([{ name: 'add', args: { a: 1, b: 2 } }]);
  });

  it('threads ctx.trace into callTool when present', async () => {
    const calls: Array<{ name: string; args: unknown; trace: unknown }> = [];
    const fakeClient = {
      callTool: async (name: string, args: Record<string, unknown>, trace: unknown) => {
        calls.push({ name, args, trace });
        return { content: [{ type: 'text', text: 'ok' }] } as McpCallResult;
      },
    } as unknown as McpClient;

    const tool = mcpToolToAgentTool(fakeClient, def, 'ns');
    const trace = { sessionId: 'sess-x', requestId: 'req-x', callId: 'call-x' };
    const ctx = { step: 0, callId: 'call-x', signal: new AbortController().signal, metrics: new Map(), trace };
    await tool.execute({}, ctx);

    expect(calls.length).toBe(1);
    expect(calls[0].trace).toEqual(trace);
  });

  it('passes undefined trace to callTool when ctx.trace is absent', async () => {
    const calls: Array<{ trace: unknown }> = [];
    const fakeClient = {
      callTool: async (_name: string, _args: Record<string, unknown>, trace: unknown) => {
        calls.push({ trace });
        return { content: [] } as McpCallResult;
      },
    } as unknown as McpClient;

    const tool = mcpToolToAgentTool(fakeClient, def, 'ns');
    const ctx = { step: 0, callId: 'c', signal: new AbortController().signal, metrics: new Map() };
    await tool.execute({}, ctx);

    expect(calls.length).toBe(1);
    expect(calls[0].trace).toBeUndefined();
  });

  it('validateOutput surfaces an outputSchema mismatch as an error result', async () => {
    const tool: McpToolDef = {
      name: 'q',
      description: 'q',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { sum: { type: 'number' } }, required: ['sum'] },
    };
    const client = {
      callTool: async () => ({ content: [{ type: 'text', text: 'x' }], structuredContent: { sum: 'not-a-number' } }) as McpCallResult,
    } as unknown as McpClient;
    const ctx = { step: 0, callId: 'c', signal: new AbortController().signal, metrics: new Map() };

    const off = await mcpToolToAgentTool(client, tool, 'ns').execute({}, ctx);
    expect(off).toBe('x'); // default: no validation, content passes through

    const on = await mcpToolToAgentTool(client, tool, 'ns', { validateOutput: true }).execute({}, ctx);
    expect(typeof on).toBe('string');
    expect(on).toContain('schema validation');
  });
});
