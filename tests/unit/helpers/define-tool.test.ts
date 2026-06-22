/** defineTool() unit tests.
 *  Verifies: well-formed tool shape, JSON-schema generation, type inference,
 *  optional param handling, execute round-trip. No network. */

import { describe, expect, it } from 'bun:test';
import { defineTool } from '../../../src/helpers/define-tool';
import { isFunctionTool } from '../../../src/llm/types/tools';
import type { FunctionTool } from '../../../src/llm/types/tools';
import type { ToolExecutionContext } from '../../../src/agent/types';

const NOOP_CTX: ToolExecutionContext = {} as ToolExecutionContext;

/** Helper: get the FunctionTool definition, asserting it is one. */
function fnDef(tool: ReturnType<typeof defineTool>): FunctionTool {
  expect(isFunctionTool(tool.definition)).toBe(true);
  return tool.definition as FunctionTool;
}

// ─── Shape / structure ────────────────────────────────────────────────────────

describe('defineTool — well-formed tool shape', () => {
  it('produces a tool with definition + execute', () => {
    const tool = defineTool({
      name: 'greet',
      description: 'Says hello',
      params: { name: 'string' },
      execute: ({ name }) => `Hello, ${name}!`,
    });
    const def = fnDef(tool);
    expect(def.name).toBe('greet');
    expect(def.description).toBe('Says hello');
    expect(typeof tool.execute).toBe('function');
  });

  it('parameters schema has type:object', () => {
    const tool = defineTool({
      name: 'add',
      description: 'Adds two numbers',
      params: { a: 'number', b: 'number' },
      execute: ({ a, b }) => String(a + b),
    });
    const def = fnDef(tool);
    expect((def.parameters as Record<string, unknown>).type).toBe('object');
    expect((def.parameters as Record<string, unknown>).properties).toBeDefined();
  });

  it('all params are required by default', () => {
    const tool = defineTool({
      name: 'fn',
      description: 'd',
      params: { x: 'string', y: 'number' },
      execute: () => 'ok',
    });
    const def = fnDef(tool);
    const required = (def.parameters as Record<string, unknown>).required as string[];
    expect(required).toContain('x');
    expect(required).toContain('y');
  });

  it('optional[] params are excluded from required', () => {
    const tool = defineTool({
      name: 'fn',
      description: 'd',
      params: { x: 'string', y: 'number' },
      optional: ['y'],
      execute: () => 'ok',
    });
    const def = fnDef(tool);
    const required = (def.parameters as Record<string, unknown>).required as string[];
    expect(required).toContain('x');
    expect(required).not.toContain('y');
  });

  it('empty params produces no required array', () => {
    const tool = defineTool({
      name: 'fn',
      description: 'd',
      params: {},
      execute: () => 'done',
    });
    const def = fnDef(tool);
    // required is absent or empty when there are no required fields
    const req = (def.parameters as Record<string, unknown>).required as string[] | undefined;
    expect(!req || req.length === 0).toBe(true);
  });
});

// ─── JSON-schema generation per ParamSpec ─────────────────────────────────────

describe('defineTool — JSON-schema generation', () => {
  it('string param -> {type:"string"}', () => {
    const tool = defineTool({ name: 't', description: 'd', params: { s: 'string' }, execute: () => '' });
    const def = fnDef(tool);
    const props = (def.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.s).toEqual({ type: 'string' });
  });

  it('number param -> {type:"number"}', () => {
    const tool = defineTool({ name: 't', description: 'd', params: { n: 'number' }, execute: () => '' });
    const def = fnDef(tool);
    const props = (def.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.n).toEqual({ type: 'number' });
  });

  it('integer param -> {type:"integer"}', () => {
    const tool = defineTool({ name: 't', description: 'd', params: { i: 'integer' }, execute: () => '' });
    const def = fnDef(tool);
    const props = (def.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.i).toEqual({ type: 'integer' });
  });

  it('boolean param -> {type:"boolean"}', () => {
    const tool = defineTool({ name: 't', description: 'd', params: { b: 'boolean' }, execute: () => '' });
    const def = fnDef(tool);
    const props = (def.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.b).toEqual({ type: 'boolean' });
  });

  it('string[] param -> {type:"array",items:{type:"string"}}', () => {
    const tool = defineTool({ name: 't', description: 'd', params: { tags: 'string[]' }, execute: () => '' });
    const def = fnDef(tool);
    const props = (def.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.tags).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('number[] param -> {type:"array",items:{type:"number"}}', () => {
    const tool = defineTool({ name: 't', description: 'd', params: { vals: 'number[]' }, execute: () => '' });
    const def = fnDef(tool);
    const props = (def.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.vals).toEqual({ type: 'array', items: { type: 'number' } });
  });

  it('inline object spec passes through as-is', () => {
    const spec = { type: 'object' as const, properties: { x: { type: 'string' } }, required: ['x'] };
    const tool = defineTool({ name: 't', description: 'd', params: { opts: spec }, execute: () => '' });
    const def = fnDef(tool);
    const props = (def.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.opts).toEqual(spec);
  });
});

// ─── execute round-trip ───────────────────────────────────────────────────────

describe('defineTool — execute round-trip', () => {
  it('execute receives args and returns result string', async () => {
    const tool = defineTool({
      name: 'word_count',
      description: 'Count words',
      params: { text: 'string' },
      execute: ({ text }) => String(text.split(/\s+/).filter(Boolean).length),
    });
    const result = await tool.execute({ text: 'one two three' }, NOOP_CTX);
    expect(result).toBe('3');
  });

  it('execute can return ContentPart[]', async () => {
    const tool = defineTool({
      name: 'img',
      description: 'Returns a content part',
      params: { url: 'string' },
      execute: ({ url }) => [{ type: 'text' as const, text: `image:${url}` }],
    });
    const result = await tool.execute({ url: 'https://example.com/img.png' }, NOOP_CTX);
    expect(Array.isArray(result)).toBe(true);
    expect((result as Array<{ type: string; text: string }>)[0].text).toBe(
      'image:https://example.com/img.png',
    );
  });

  it('execute propagates thrown errors', async () => {
    const tool = defineTool({
      name: 'bomb',
      description: 'Always throws',
      params: { x: 'string' },
      execute: () => {
        throw new Error('intentional failure');
      },
    });
    await expect(tool.execute({ x: 'anything' }, NOOP_CTX)).rejects.toThrow('intentional failure');
  });

  it('execute context is forwarded', async () => {
    let received: ToolExecutionContext | undefined;
    const tool = defineTool({
      name: 'ctx_check',
      description: 'Captures context',
      params: { x: 'string' },
      execute: (_args, ctx) => {
        received = ctx;
        return 'ok';
      },
    });
    const ctx = { agentId: 'agent-1' } as unknown as ToolExecutionContext;
    await tool.execute({ x: 'hi' }, ctx);
    expect(received).toBe(ctx);
  });
});
