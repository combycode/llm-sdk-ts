/** Content-block mapping and tool namespacing.
 *
 *  `tools.test.ts` covers the common text/image/validateOutput paths; this file pins the block
 *  kinds and the namespacing rule that a port is most likely to get wrong — audio, the two
 *  resource forms, unknown blocks, prompt→Message[], and the fact that the namespace comes from
 *  the CALLER, so two servers exposing the same tool name stay distinct. */

import { describe, expect, it } from 'bun:test';
import { isFunctionTool } from '../../../../src/llm/types/tools';
import type { McpClient } from '../../../../src/plugins/mcp/client';
import { mcpContentToResult, mcpPromptToMessages, mcpToolToAgentTool } from '../../../../src/plugins/mcp/tools';
import type { McpCallResult, McpGetPromptResult, McpToolDef } from '../../../../src/plugins/mcp/types';

const ctx = () => ({ step: 0, callId: 'c', signal: new AbortController().signal, metrics: new Map() });

describe('mcpContentToResult: block kinds', () => {
  it('maps an audio block to a base64 audio part and switches the result to parts', async () => {
    const out = mcpContentToResult({
      content: [
        { type: 'text', text: 'listen:' },
        { type: 'audio', data: 'WVla', mimeType: 'audio/mpeg' },
      ],
    });
    expect(out).toEqual([
      { type: 'text', text: 'listen:' },
      { type: 'audio', source: { type: 'base64', mimeType: 'audio/mpeg', data: 'WVla' } },
    ]);
  });

  it('renders a resource with no inline text as a URI reference, not as nothing', () => {
    // Dropping it would hand the model an empty tool result and no hint that a resource exists.
    expect(mcpContentToResult({ content: [{ type: 'resource', resource: { uri: 'file:///a.txt' } }] })).toBe(
      '[resource file:///a.txt]',
    );
  });

  it('prefers the inline text of a resource over its URI', () => {
    expect(
      mcpContentToResult({ content: [{ type: 'resource', resource: { uri: 'file:///a.txt', text: 'body' } }] }),
    ).toBe('body');
  });

  it('renders a resource_link as a URI reference', () => {
    expect(mcpContentToResult({ content: [{ type: 'resource_link', uri: 'https://x/doc' }] })).toBe(
      '[resource https://x/doc]',
    );
  });

  it('skips a block kind it does not understand instead of emitting a broken part', () => {
    // An unknown block reaching the provider as `undefined` is a 400; skipping keeps the rest of
    // the result usable.
    expect(
      mcpContentToResult({
        content: [
          { type: 'text', text: 'a' },
          { type: 'future_block', payload: 1 } as never,
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('ab');
  });

  it('an empty resource (no uri, no text) contributes nothing', () => {
    expect(mcpContentToResult({ content: [{ type: 'resource', resource: {} } as never] })).toBe('');
  });

  it('missing content is an empty string, not a crash', () => {
    expect(mcpContentToResult({} as McpCallResult)).toBe('');
  });

  it('isError still prefixes when the text came from a resource', () => {
    expect(
      mcpContentToResult({ content: [{ type: 'resource', resource: { uri: 'x://1' } }], isError: true }),
    ).toBe('Tool error: [resource x://1]');
  });
});

describe('mcpPromptToMessages', () => {
  it('maps each prompt message to a Message, keeping its role and flattening text', () => {
    const result: McpGetPromptResult = {
      messages: [
        { role: 'user', content: { type: 'text', text: 'summarise this' } },
        { role: 'assistant', content: { type: 'text', text: 'sure' } },
      ],
    };
    expect(mcpPromptToMessages(result)).toEqual([
      { role: 'user', content: 'summarise this' },
      { role: 'assistant', content: 'sure' },
    ]);
  });

  it('wraps a media block in a one-element parts array', () => {
    // A non-text part cannot be a bare string; wrapping is what makes the message droppable
    // straight into a request.
    const result: McpGetPromptResult = {
      messages: [{ role: 'user', content: { type: 'image', data: 'QUJD', mimeType: 'image/png' } }],
    };
    expect(mcpPromptToMessages(result)).toEqual([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'QUJD' } }] },
    ]);
  });

  it('turns an unmappable block into empty content rather than undefined', () => {
    const result: McpGetPromptResult = {
      messages: [{ role: 'user', content: { type: 'mystery' } as never }],
    };
    expect(mcpPromptToMessages(result)).toEqual([{ role: 'user', content: '' }]);
  });
});

describe('mcpToolToAgentTool: namespacing', () => {
  const def = (name: string): McpToolDef => ({ name, inputSchema: { type: 'object', properties: {} } });

  it('keeps two servers exposing the same tool name distinct, and routes each to its own server', async () => {
    // The namespace is a PARAMETER, not a constant: hardcoding it makes the second server's tools
    // overwrite the first's in the model-visible tool list, and every call goes to one server.
    const hitA: string[] = [];
    const hitB: string[] = [];
    const clientA = { callTool: async (n: string) => { hitA.push(n); return { content: [{ type: 'text', text: 'A' }] } as McpCallResult; } } as unknown as McpClient;
    const clientB = { callTool: async (n: string) => { hitB.push(n); return { content: [{ type: 'text', text: 'B' }] } as McpCallResult; } } as unknown as McpClient;

    const a = mcpToolToAgentTool(clientA, def('search'), 'docs');
    const b = mcpToolToAgentTool(clientB, def('search'), 'web');

    const nameA = isFunctionTool(a.definition) ? a.definition.name : '';
    const nameB = isFunctionTool(b.definition) ? b.definition.name : '';
    expect(nameA).toBe('docs__search');
    expect(nameB).toBe('web__search');
    expect(nameA).not.toBe(nameB);

    expect(await a.execute({}, ctx())).toBe('A');
    expect(await b.execute({}, ctx())).toBe('B');
    // Each server saw only its own call, under the UN-namespaced name it published.
    expect(hitA).toEqual(['search']);
    expect(hitB).toEqual(['search']);
  });

  it('falls back title → name when the tool has no description', () => {
    const client = {} as unknown as McpClient;
    const withTitle = mcpToolToAgentTool(client, { name: 'x', title: 'Nice X', inputSchema: {} }, 'ns');
    const bare = mcpToolToAgentTool(client, { name: 'x', inputSchema: {} }, 'ns');
    expect(isFunctionTool(withTitle.definition) && withTitle.definition.description).toBe('Nice X');
    expect(isFunctionTool(bare.definition) && bare.definition.description).toBe('x');
  });

  it('substitutes an empty object schema when the tool publishes none', () => {
    const tool = mcpToolToAgentTool({} as unknown as McpClient, { name: 'x' } as McpToolDef, 'ns');
    expect(isFunctionTool(tool.definition) && tool.definition.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('marks the tool lazy only when asked', () => {
    const client = {} as unknown as McpClient;
    expect(mcpToolToAgentTool(client, def('x'), 'ns').lazy).toBeUndefined();
    expect(mcpToolToAgentTool(client, def('x'), 'ns', { lazy: true }).lazy).toBe(true);
  });
});

describe('mcpToolToAgentTool: outputSchema is a promise, not a hint', () => {
  const withSchema: McpToolDef = {
    name: 'sum',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] },
  };
  const client = (res: McpCallResult) => ({ callTool: async () => res }) as unknown as McpClient;

  it('does NOT declare outputSchema unless validateOutput is on', () => {
    // Declaring it makes the provider require a JSON result; forwarding it unconditionally
    // reshapes every existing MCP tool result from prose into structured data.
    const off = mcpToolToAgentTool(client({ content: [] }), withSchema, 'ns').definition;
    const on = mcpToolToAgentTool(client({ content: [] }), withSchema, 'ns', { validateOutput: true }).definition;
    expect(isFunctionTool(off) && 'outputSchema' in off).toBe(false);
    expect(isFunctionTool(on) && on.outputSchema).toEqual(withSchema.outputSchema);
  });

  it('returns the structuredContent as JSON when it validates', async () => {
    const res: McpCallResult = { content: [{ type: 'text', text: 'prose' }], structuredContent: { total: 3 } };
    const tool = mcpToolToAgentTool(client(res), withSchema, 'ns', { validateOutput: true });
    expect(await tool.execute({}, ctx())).toBe(JSON.stringify({ total: 3 }));
  });

  it('falls back to the content when the tool reported an error, even with structuredContent', async () => {
    // An error result is prose the model needs to read; serialising the structured payload instead
    // would hide the failure message.
    const res: McpCallResult = { content: [{ type: 'text', text: 'it broke' }], structuredContent: { total: 0 }, isError: true };
    const tool = mcpToolToAgentTool(client(res), withSchema, 'ns', { validateOutput: true });
    expect(await tool.execute({}, ctx())).toBe('Tool error: it broke');
  });

  it('returns the content unchanged when validateOutput is on but the tool sent no structuredContent', async () => {
    const res: McpCallResult = { content: [{ type: 'text', text: 'just prose' }] };
    const tool = mcpToolToAgentTool(client(res), withSchema, 'ns', { validateOutput: true });
    expect(await tool.execute({}, ctx())).toBe('just prose');
  });
});
