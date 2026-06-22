/** Adapt MCP results into our shapes: tool-call results -> AgentTool results,
 *  and prompt results -> Message[]. */

import type { AgentTool } from '../../agent/types';
import type { ContentPart, Message } from '../../llm/types/messages';
import { validateJsonSchema } from '../../util/json-schema';
import type { McpClient } from './client';
import type { McpCallResult, McpContentBlock, McpGetPromptResult, McpToolDef } from './types';

export interface McpToolAdapterOptions {
  /** Validate `structuredContent` against the tool's `outputSchema`; on mismatch
   *  the tool returns an error string instead of the content. Default false. */
  validateOutput?: boolean;
}

/** Map one MCP content block to a ContentPart (null for unknown types). */
function blockToPart(b: McpContentBlock): ContentPart | null {
  if (b.type === 'text') return { type: 'text', text: (b as { text: string }).text };
  if (b.type === 'image') {
    const im = b as { data: string; mimeType: string };
    return { type: 'image', source: { type: 'base64', mimeType: im.mimeType, data: im.data } };
  }
  if (b.type === 'audio') {
    const au = b as { data: string; mimeType: string };
    return { type: 'audio', source: { type: 'base64', mimeType: au.mimeType, data: au.data } };
  }
  if (b.type === 'resource') {
    const r = (b as { resource?: { uri?: string; text?: string } }).resource;
    if (r?.text) return { type: 'text', text: r.text };
    if (r?.uri) return { type: 'text', text: `[resource ${r.uri}]` };
  }
  if (b.type === 'resource_link') return { type: 'text', text: `[resource ${(b as { uri: string }).uri}]` };
  return null;
}

/** Map a `tools/call` result to our tool-result shape: a plain string when the
 *  content is text-only, else a ContentPart[] (images/audio kept as base64).
 *  A tool-level `isError` is surfaced to the model as text, not thrown. */
export function mcpContentToResult(res: McpCallResult): string | ContentPart[] {
  const parts: ContentPart[] = [];
  let hasMedia = false;
  for (const b of res.content ?? []) {
    const part = blockToPart(b);
    if (!part) continue;
    if (part.type !== 'text') hasMedia = true;
    parts.push(part);
  }
  if (!hasMedia) {
    const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return res.isError ? `Tool error: ${text}` : text;
  }
  return parts;
}

/** Map a `prompts/get` result to our Message[] (drop straight into a request). */
export function mcpPromptToMessages(result: McpGetPromptResult): Message[] {
  return result.messages.map((m) => {
    const part = blockToPart(m.content);
    const content: string | ContentPart[] = part ? (part.type === 'text' ? part.text : [part]) : '';
    return { role: m.role, content };
  });
}

/** Wrap one MCP tool as an `AgentTool`. The model sees `<namespace>__<tool>`
 *  (collision-free across servers); execution calls the server with the raw name. */
export function mcpToolToAgentTool(
  client: McpClient,
  tool: McpToolDef,
  namespace: string,
  opts: McpToolAdapterOptions = {},
): AgentTool {
  return {
    definition: {
      type: 'function',
      name: `${namespace}__${tool.name}`,
      description: tool.description ?? tool.title ?? tool.name,
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
    execute: async (args, ctx) => {
      const res = await client.callTool(tool.name, args, ctx.trace);
      if (opts.validateOutput && tool.outputSchema && res.structuredContent !== undefined) {
        const errors = validateJsonSchema(tool.outputSchema, res.structuredContent);
        if (errors.length > 0) return `Tool output failed schema validation: ${errors.slice(0, 5).join('; ')}`;
      }
      return mcpContentToResult(res);
    },
  };
}
