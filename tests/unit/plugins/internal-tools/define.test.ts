import { describe, expect, it } from 'bun:test';
import {
  LLM_DEF_KEY,
  defineLLMTool,
  getLLMToolDefinition,
} from '../../../../src/plugins/internal-tools/runner/define';
import type { LLMToolDefinition } from '../../../../src/plugins/internal-tools/runner/types';
import type {
  InternalTool,
  InternalToolContext,
} from '../../../../src/plugins/internal-tools/types';
import type { LLMClient } from '../../../../src/llm/client';
import type { CompletionResponse } from '../../../../src/llm/types/response';
import type { TokenCounter } from '../../../../src/agent/types';

// ─── doubles ───────────────────────────────────────────────────────────

interface CapturedCall {
  messages: Array<{ role: string; content: string }>;
  options: { system?: string; maxTokens?: number; temperature?: number };
}

type StubClient = LLMClient & { calls: CapturedCall[] };

function stubClient(reply = '{"ok":true}'): StubClient {
  const calls: CapturedCall[] = [];
  const client = {
    calls,
    complete: async (
      messages: CapturedCall['messages'],
      options: CapturedCall['options'],
    ): Promise<CompletionResponse> => {
      calls.push({ messages, options });
      return {
        id: 'resp-1',
        model: 'stub',
        content: [],
        finishReason: 'stop',
        usage: {
          inputTokens: 11,
          outputTokens: 22,
          totalTokens: 33,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        text: reply,
        toolCalls: [],
        thinking: null,
        media: [],
      } as unknown as CompletionResponse;
    },
    destroy: () => {},
  };
  return client as unknown as StubClient;
}

/** Counter that reports one token per 4 characters — enough to pin arithmetic. */
const quarterCounter = {
  estimate: (text: string) => Math.ceil(text.length / 4),
  estimateMessage: () => 0,
  measure: async (text: string) => Math.ceil(text.length / 4),
  measureMessage: async () => 0,
  learn: () => {},
} as unknown as TokenCounter;

function baseDef(extra: Partial<LLMToolDefinition> = {}): LLMToolDefinition {
  return {
    id: 'test:tool@1.0.0',
    namespace: 'test',
    name: 'tool',
    version: '1.0.0',
    description: 'a test tool',
    inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    systemPrompt: 'SYS',
    userTemplate: 'USER {{a}}',
    modelPreference: { preferredModel: 'openai/gpt-x' },
    ...extra,
  };
}

function ctx(client: LLMClient, over: Partial<InternalToolContext> = {}): InternalToolContext {
  return { client, modelId: 'openai/gpt-x', ...over };
}

// ─── tests ─────────────────────────────────────────────────────────────

describe('defineLLMTool — descriptor mapping', () => {
  it('copies every declarative field onto the InternalTool', () => {
    const def = baseDef({
      outputSchema: { type: 'object' },
      recommendedThreshold: 95,
      tags: ['x', 'y'],
      signature: 'sig',
    });
    const tool = defineLLMTool(def);
    expect(tool.id).toBe('test:tool@1.0.0');
    expect(tool.namespace).toBe('test');
    expect(tool.name).toBe('tool');
    expect(tool.version).toBe('1.0.0');
    expect(tool.description).toBe('a test tool');
    expect(tool.inputSchema).toBe(def.inputSchema);
    expect(tool.outputSchema).toBe(def.outputSchema);
    expect(tool.modelPreference).toBe(def.modelPreference);
    expect(tool.recommendedThreshold).toBe(95);
    expect(tool.tags).toEqual(['x', 'y']);
    expect(tool.signature).toBe('sig');
  });

  it('leaves optional fields undefined when the definition omits them', () => {
    const tool = defineLLMTool(baseDef());
    expect(tool.outputSchema).toBeUndefined();
    expect(tool.recommendedThreshold).toBeUndefined();
    expect(tool.tags).toBeUndefined();
    expect(tool.signature).toBeUndefined();
  });
});

describe('getLLMToolDefinition', () => {
  it('recovers the original definition from a tool built by defineLLMTool', () => {
    const def = baseDef();
    expect(getLLMToolDefinition(defineLLMTool(def))).toBe(def);
  });

  it('stashes the definition under the shared cross-realm symbol', () => {
    const tool = defineLLMTool(baseDef());
    expect(LLM_DEF_KEY === Symbol.for('orxa:llm_tool_def')).toBe(true);
    expect((tool as unknown as Record<symbol, unknown>)[LLM_DEF_KEY]).toBe(
      getLLMToolDefinition(tool),
    );
  });

  it('returns null for a hand-written tool that has no definition attached', () => {
    const plain: InternalTool = {
      id: 'x:y@1.0.0',
      namespace: 'x',
      name: 'y',
      version: '1.0.0',
      description: '',
      inputSchema: { type: 'object' },
      execute: async () => null,
    };
    expect(getLLMToolDefinition(plain)).toBeNull();
  });
});

describe('defineLLMTool — execute context requirements', () => {
  it('throws when no client is in context', async () => {
    const tool = defineLLMTool(baseDef());
    await expect(tool.execute({ a: '1' }, { modelId: 'openai/gpt-x' })).rejects.toThrow(
      'Tool test:tool@1.0.0 requires an LLM client + model in context (runner must provide these)',
    );
  });

  it('throws when no modelId is in context', async () => {
    const tool = defineLLMTool(baseDef());
    await expect(tool.execute({ a: '1' }, { client: stubClient() })).rejects.toThrow(
      /requires an LLM client \+ model in context/,
    );
  });

  it('throws when the context is empty', async () => {
    const tool = defineLLMTool(baseDef());
    await expect(tool.execute({ a: '1' }, {})).rejects.toThrow(/requires an LLM client \+ model/);
  });
});

describe('defineLLMTool — model id splitting', () => {
  it('splits "provider/model" at the first slash', async () => {
    const client = stubClient();
    const tool = defineLLMTool(
      baseDef({
        userTemplate: 'x',
        variants: [
          {
            id: 'openai-one',
            systemPrompt: 'S',
            userTemplate: 'U',
            supportedModels: ['openai/some/nested-model'],
          },
          { id: 'fallback', systemPrompt: 'F', userTemplate: 'F', isDefault: true },
        ],
      }),
    );
    await tool.execute({ a: '1' }, ctx(client, { modelId: 'openai/some/nested-model' }));
    expect(client.calls[0]?.options.system).toBe('S');
  });

  it('treats a slash-less model id as both provider and model', async () => {
    const client = stubClient();
    const tool = defineLLMTool(
      baseDef({
        variants: [
          { id: 'by-provider', systemPrompt: 'P', userTemplate: 'U', supportedProviders: ['solo'] },
          { id: 'fallback', systemPrompt: 'F', userTemplate: 'F', isDefault: true },
        ],
      }),
    );
    await tool.execute({ a: '1' }, ctx(client, { modelId: 'solo' }));
    expect(client.calls[0]?.options.system).toBe('P');
  });

  it('treats a leading-slash model id as provider-only (slash index 0)', async () => {
    const client = stubClient();
    const tool = defineLLMTool(
      baseDef({
        variants: [
          { id: 'weird', systemPrompt: 'W', userTemplate: 'U', supportedProviders: ['/edge'] },
          { id: 'fallback', systemPrompt: 'F', userTemplate: 'F', isDefault: true },
        ],
      }),
    );
    await tool.execute({ a: '1' }, ctx(client, { modelId: '/edge' }));
    expect(client.calls[0]?.options.system).toBe('W');
  });
});

describe('defineLLMTool — input defaults from the schema', () => {
  it('fills a missing property from its schema default', async () => {
    const client = stubClient();
    const tool = defineLLMTool(
      baseDef({
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'string', default: 'DEF' } },
        },
        userTemplate: '{{a}}|{{b}}',
      }),
    );
    await tool.execute({ a: 'given' }, ctx(client));
    expect(client.calls[0]?.messages[0]?.content).toBe('given|DEF');
  });

  it('does NOT overwrite a supplied value, even a falsy one', async () => {
    const client = stubClient();
    const tool = defineLLMTool(
      baseDef({
        inputSchema: { type: 'object', properties: { b: { type: 'string', default: 'DEF' } } },
        userTemplate: '[{{b}}]',
      }),
    );
    await tool.execute({ b: '' }, ctx(client));
    expect(client.calls[0]?.messages[0]?.content).toBe('[]');
  });

  it('ignores properties that declare no default', async () => {
    const tool = defineLLMTool(
      baseDef({
        inputSchema: { type: 'object', properties: { b: { type: 'string' } } },
        userTemplate: '{{b}}',
      }),
    );
    await expect(tool.execute({}, ctx(stubClient()))).rejects.toThrow(
      'Template variable not found: "b"',
    );
  });

  it('starts from an empty bag when the input is not a plain object', async () => {
    const client = stubClient();
    const tool = defineLLMTool(
      baseDef({
        inputSchema: { type: 'object', properties: { b: { type: 'string', default: 'DEF' } } },
        userTemplate: '{{b}}',
      }),
    );
    await tool.execute('a bare string', ctx(client));
    expect(client.calls[0]?.messages[0]?.content).toBe('DEF');
  });

  it('starts from an empty bag when the input is an array', async () => {
    const client = stubClient();
    const tool = defineLLMTool(
      baseDef({
        inputSchema: { type: 'object', properties: { b: { type: 'string', default: 'DEF' } } },
        userTemplate: '{{b}}',
      }),
    );
    await tool.execute(['x'], ctx(client));
    expect(client.calls[0]?.messages[0]?.content).toBe('DEF');
  });

  it('contributes NO variables from an array input — not even its indices', async () => {
    const client = stubClient();
    const tool = defineLLMTool(
      baseDef({
        inputSchema: { type: 'object' },
        prepareInput: (input) => ({ keys: Object.keys(input).join(',') }),
        userTemplate: '[{{keys}}]',
      }),
    );
    await tool.execute(['x', 'y'], ctx(client));
    expect(client.calls[0]?.messages[0]?.content).toBe('[]');
  });

  it('starts from an empty bag when the input is null', async () => {
    const client = stubClient();
    const tool = defineLLMTool(
      baseDef({
        inputSchema: { type: 'object', properties: { b: { type: 'string', default: 'DEF' } } },
        userTemplate: '{{b}}',
      }),
    );
    await tool.execute(null, ctx(client));
    expect(client.calls[0]?.messages[0]?.content).toBe('DEF');
  });

  it('applies no defaults when the input schema is not of type "object"', async () => {
    const tool = defineLLMTool(
      baseDef({
        inputSchema: { type: 'string', properties: { b: { default: 'DEF' } } } as never,
        userTemplate: '{{b}}',
      }),
    );
    await expect(tool.execute({}, ctx(stubClient()))).rejects.toThrow(
      /Template variable not found/,
    );
  });

  it('applies no defaults when the object schema declares no properties', async () => {
    const tool = defineLLMTool(baseDef({ inputSchema: { type: 'object' }, userTemplate: '{{b}}' }));
    await expect(tool.execute({}, ctx(stubClient()))).rejects.toThrow(
      /Template variable not found/,
    );
  });

  it('does not mutate the caller input object', async () => {
    const input = { a: 'x' };
    const tool = defineLLMTool(
      baseDef({
        inputSchema: { type: 'object', properties: { b: { default: 'DEF' } } },
        userTemplate: '{{a}}{{b}}',
      }),
    );
    await tool.execute(input, ctx(stubClient()));
    expect(input).toEqual({ a: 'x' });
  });
});

describe('defineLLMTool — prepareInput', () => {
  it('runs after schema defaults and its result feeds the templates', async () => {
    const client = stubClient();
    const tool = defineLLMTool(
      baseDef({
        inputSchema: { type: 'object', properties: { b: { default: 'DEF' } } },
        prepareInput: (input) => ({ ...input, derived: `<${String(input.b)}>` }),
        systemPrompt: 'sys {{a}}',
        userTemplate: 'user {{derived}}',
      }),
    );
    await tool.execute({ a: 'A' }, ctx(client));
    expect(client.calls[0]?.options.system).toBe('sys A');
    expect(client.calls[0]?.messages[0]?.content).toBe('user <DEF>');
  });

  it('can drop keys, which then fail template rendering', async () => {
    const tool = defineLLMTool(baseDef({ prepareInput: () => ({}) }));
    await expect(tool.execute({ a: 'A' }, ctx(stubClient()))).rejects.toThrow(
      'Template variable not found: "a"',
    );
  });
});

describe('defineLLMTool — variant selection', () => {
  const variantDef = (over: Partial<LLMToolDefinition> = {}) =>
    baseDef({
      variants: [
        {
          id: 'anthropic',
          systemPrompt: 'A-SYS',
          userTemplate: 'A {{a}}',
          supportedProviders: ['anthropic'],
        },
        { id: 'default', systemPrompt: 'D-SYS', userTemplate: 'D {{a}}', isDefault: true },
        { id: 'fast', systemPrompt: 'F-SYS', userTemplate: 'F {{a}}', modes: ['fast'] },
      ],
      ...over,
    });

  it('synthesises a single default variant from systemPrompt/userTemplate when none are declared', async () => {
    const client = stubClient();
    const tool = defineLLMTool(baseDef({ systemPrompt: 'ONLY-SYS', userTemplate: 'ONLY {{a}}' }));
    await tool.execute({ a: 'v' }, ctx(client));
    expect(client.calls[0]?.options.system).toBe('ONLY-SYS');
    expect(client.calls[0]?.messages[0]?.content).toBe('ONLY v');
  });

  it('renders empty prompts when the definition declares neither prompt nor variants', async () => {
    const client = stubClient();
    const tool = defineLLMTool(baseDef({ systemPrompt: undefined, userTemplate: undefined }));
    await tool.execute({ a: 'v' }, ctx(client));
    expect(client.calls[0]?.options.system).toBe('');
    expect(client.calls[0]?.messages[0]?.content).toBe('');
  });

  it('selects the provider-specific variant', async () => {
    const client = stubClient();
    const tool = defineLLMTool(variantDef());
    await tool.execute({ a: 'v' }, ctx(client, { modelId: 'anthropic/claude' }));
    expect(client.calls[0]?.messages[0]?.content).toBe('A v');
  });

  it('falls back to the default variant for other providers', async () => {
    const client = stubClient();
    const tool = defineLLMTool(variantDef());
    await tool.execute({ a: 'v' }, ctx(client, { modelId: 'openai/gpt-x' }));
    expect(client.calls[0]?.messages[0]?.content).toBe('D v');
  });

  it('takes the mode from the prepared input', async () => {
    const client = stubClient();
    const tool = defineLLMTool(
      variantDef({ prepareInput: (input) => ({ ...input, mode: 'fast' }) }),
    );
    await tool.execute({ a: 'v' }, ctx(client, { modelId: 'anthropic/claude' }));
    expect(client.calls[0]?.messages[0]?.content).toBe('F v');
  });

  it('takes the mode from the raw input when prepareInput drops it', async () => {
    const client = stubClient();
    const tool = defineLLMTool(variantDef({ prepareInput: (input) => ({ a: input.a }) }));
    await tool.execute({ a: 'v', mode: 'fast' }, ctx(client));
    expect(client.calls[0]?.messages[0]?.content).toBe('F v');
  });

  it('takes the mode straight from the input when there is no prepareInput', async () => {
    const client = stubClient();
    const tool = defineLLMTool(variantDef());
    await tool.execute({ a: 'v', mode: 'fast' }, ctx(client));
    expect(client.calls[0]?.messages[0]?.content).toBe('F v');
  });
});

describe('defineLLMTool — structure guidance in the system prompt', () => {
  const jsonDef = (over: Partial<LLMToolDefinition> = {}) =>
    baseDef({ outputFormat: 'json', systemPrompt: 'BASE', userTemplate: 'U', ...over });

  it('adds no guidance and no JSON contract when outputFormat is not json', async () => {
    const client = stubClient('plain text');
    const tool = defineLLMTool(
      baseDef({ outputSchema: { type: 'object' }, outputExample: { a: 1 } }),
    );
    await tool.execute({ a: 'v' }, ctx(client));
    const system = client.calls[0]?.options.system ?? '';
    expect(system).toBe('SYS');
    expect(system).not.toContain('Output schema');
    expect(system).not.toContain('JSON API endpoint');
  });

  it('adds no guidance when outputFormat is explicitly "text"', async () => {
    const client = stubClient('plain text');
    const tool = defineLLMTool(baseDef({ outputFormat: 'text', outputSchema: { type: 'object' } }));
    await tool.execute({ a: 'v' }, ctx(client));
    expect(client.calls[0]?.options.system).toBe('SYS');
  });

  it('prepends the JSON-API contract for json output', async () => {
    const client = stubClient('{}');
    const tool = defineLLMTool(jsonDef());
    await tool.execute({ a: 'v' }, ctx(client));
    const system = client.calls[0]?.options.system ?? '';
    expect(system).toContain('You are a JSON API endpoint');
    expect(system.endsWith('BASE')).toBe(true);
  });

  it('embeds the output schema as a fenced JSON block', async () => {
    const client = stubClient('{}');
    const tool = defineLLMTool(jsonDef({ outputSchema: { type: 'object', properties: {} } }));
    await tool.execute({ a: 'v' }, ctx(client));
    const system = client.calls[0]?.options.system ?? '';
    expect(system).toContain('## Output schema (your JSON must match)');
    expect(system).toContain(JSON.stringify({ type: 'object', properties: {} }, null, 2));
  });

  it('embeds the output example as a fenced JSON block', async () => {
    const client = stubClient('{}');
    const tool = defineLLMTool(jsonDef({ outputExample: { summary: 's' } }));
    await tool.execute({ a: 'v' }, ctx(client));
    const system = client.calls[0]?.options.system ?? '';
    expect(system).toContain('## Output example (copy this shape exactly)');
    expect(system).toContain(JSON.stringify({ summary: 's' }, null, 2));
  });

  it('embeds schema before example when both are present', async () => {
    const client = stubClient('{}');
    const tool = defineLLMTool(
      jsonDef({ outputSchema: { type: 'object' }, outputExample: { a: 1 } }),
    );
    const system = await tool
      .execute({ a: 'v' }, ctx(client))
      .then(() => client.calls[0]?.options.system ?? '');
    expect(system.indexOf('Output schema')).toBeLessThan(system.indexOf('Output example'));
  });

  it('omits both blocks when neither schema nor example is declared', async () => {
    const client = stubClient('{}');
    const tool = defineLLMTool(jsonDef());
    await tool.execute({ a: 'v' }, ctx(client));
    const system = client.calls[0]?.options.system ?? '';
    expect(system).not.toContain('Output schema');
    expect(system).not.toContain('Output example');
  });

  it('renders a null output example rather than skipping it', async () => {
    const client = stubClient('{}');
    const tool = defineLLMTool(jsonDef({ outputExample: null }));
    await tool.execute({ a: 'v' }, ctx(client));
    expect(client.calls[0]?.options.system).toContain('## Output example');
  });

  it('prefers the variant schema and example over the definition-level ones', async () => {
    const client = stubClient('{}');
    const tool = defineLLMTool(
      jsonDef({
        outputSchema: { type: 'object', description: 'DEF-SCHEMA' },
        outputExample: { from: 'def' },
        variants: [
          {
            id: 'v',
            systemPrompt: 'VS',
            userTemplate: 'U',
            isDefault: true,
            outputSchema: { type: 'object', description: 'VAR-SCHEMA' },
            outputExample: { from: 'variant' },
          },
        ],
      }),
    );
    await tool.execute({ a: 'v' }, ctx(client));
    const system = client.calls[0]?.options.system ?? '';
    expect(system).toContain('VAR-SCHEMA');
    expect(system).not.toContain('DEF-SCHEMA');
    expect(system).toContain('"from": "variant"');
  });

  it('falls back to the definition schema and example when the variant declares none', async () => {
    const client = stubClient('{}');
    const tool = defineLLMTool(
      jsonDef({
        outputSchema: { type: 'object', description: 'DEF-SCHEMA' },
        outputExample: { from: 'def' },
        variants: [{ id: 'v', systemPrompt: 'VS', userTemplate: 'U', isDefault: true }],
      }),
    );
    await tool.execute({ a: 'v' }, ctx(client));
    const system = client.calls[0]?.options.system ?? '';
    expect(system).toContain('DEF-SCHEMA');
    expect(system).toContain('"from": "def"');
  });
});

describe('defineLLMTool — max tokens and temperature', () => {
  it('passes modelPreference.maxTokens and temperature through to the client', async () => {
    const client = stubClient('text');
    const tool = defineLLMTool(baseDef({ modelPreference: { maxTokens: 123, temperature: 0.7 } }));
    await tool.execute({ a: 'v' }, ctx(client));
    expect(client.calls[0]?.options.maxTokens).toBe(123);
    expect(client.calls[0]?.options.temperature).toBe(0.7);
  });

  it('leaves maxTokens undefined when the preference declares none', async () => {
    const client = stubClient('text');
    const tool = defineLLMTool(baseDef({ modelPreference: {} }));
    await tool.execute({ a: 'v' }, ctx(client));
    expect(client.calls[0]?.options.maxTokens).toBeUndefined();
  });

  it('lets resolveMaxTokens override the static preference', async () => {
    const client = stubClient('text');
    const tool = defineLLMTool(
      baseDef({
        modelPreference: { maxTokens: 123 },
        resolveMaxTokens: () => 999,
      }),
    );
    await tool.execute({ a: 'v' }, ctx(client, { counter: quarterCounter }));
    expect(client.calls[0]?.options.maxTokens).toBe(999);
  });

  it('hands resolveMaxTokens the prepared vars and the split provider/model plus counter', async () => {
    const client = stubClient('text');
    const seen: Array<Record<string, unknown>> = [];
    const tool = defineLLMTool(
      baseDef({
        prepareInput: (input) => ({ ...input, extra: 'E' }),
        resolveMaxTokens: (input, c) => {
          seen.push({ input, provider: c.provider, model: c.model, counter: c.counter });
          return 7;
        },
      }),
    );
    await tool.execute({ a: 'v' }, ctx(client, { counter: quarterCounter, modelId: 'p/m' }));
    expect(seen[0]?.input).toEqual({ a: 'v', extra: 'E' });
    expect(seen[0]?.provider).toBe('p');
    expect(seen[0]?.model).toBe('m');
    expect(seen[0]?.counter).toBe(quarterCounter);
    expect(client.calls[0]?.options.maxTokens).toBe(7);
  });

  it('throws when resolveMaxTokens is declared but no counter is in context', async () => {
    const tool = defineLLMTool(baseDef({ resolveMaxTokens: () => 5 }));
    await expect(tool.execute({ a: 'v' }, ctx(stubClient()))).rejects.toThrow(
      'Tool test:tool@1.0.0: resolveMaxTokens requires a TokenCounter in context',
    );
  });

  it('prefers the variant resolveMaxTokens over the definition-level one', async () => {
    const client = stubClient('text');
    const tool = defineLLMTool(
      baseDef({
        resolveMaxTokens: () => 100,
        variants: [
          {
            id: 'v',
            systemPrompt: 'S',
            userTemplate: 'U',
            isDefault: true,
            resolveMaxTokens: () => 200,
          },
        ],
      }),
    );
    await tool.execute({ a: 'v' }, ctx(client, { counter: quarterCounter }));
    expect(client.calls[0]?.options.maxTokens).toBe(200);
  });

  it('falls back to the definition resolveMaxTokens when the variant declares none', async () => {
    const client = stubClient('text');
    const tool = defineLLMTool(
      baseDef({
        resolveMaxTokens: () => 100,
        variants: [{ id: 'v', systemPrompt: 'S', userTemplate: 'U', isDefault: true }],
      }),
    );
    await tool.execute({ a: 'v' }, ctx(client, { counter: quarterCounter }));
    expect(client.calls[0]?.options.maxTokens).toBe(100);
  });
});

describe('defineLLMTool — request shape', () => {
  it('sends exactly one user message carrying the rendered user template', async () => {
    const client = stubClient('text');
    const tool = defineLLMTool(baseDef({ userTemplate: 'Hello {{a}}' }));
    await tool.execute({ a: 'World' }, ctx(client));
    expect(client.calls[0]?.messages).toEqual([{ role: 'user', content: 'Hello World' }]);
  });

  it('calls the client exactly once per execute', async () => {
    const client = stubClient('text');
    const tool = defineLLMTool(baseDef());
    await tool.execute({ a: 'v' }, ctx(client));
    expect(client.calls).toHaveLength(1);
  });
});

describe('defineLLMTool — recordLLMResponse', () => {
  it('hands the raw response to the runner callback', async () => {
    const seen: CompletionResponse[] = [];
    const tool = defineLLMTool(baseDef());
    await tool.execute(
      { a: 'v' },
      ctx(stubClient('text'), { recordLLMResponse: (r) => seen.push(r) }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.usage.outputTokens).toBe(22);
  });

  it('is optional — execute succeeds without it', async () => {
    const tool = defineLLMTool(baseDef());
    expect(await tool.execute({ a: 'v' }, ctx(stubClient('text')))).toBe('text');
  });

  it('is invoked before the JSON parse, so a parse failure still records usage', async () => {
    const seen: CompletionResponse[] = [];
    const tool = defineLLMTool(baseDef({ outputFormat: 'json' }));
    await tool
      .execute({ a: 'v' }, ctx(stubClient('not json'), { recordLLMResponse: (r) => seen.push(r) }))
      .catch(() => {});
    expect(seen).toHaveLength(1);
  });
});

describe('defineLLMTool — output handling', () => {
  it('returns the raw text when outputFormat is not json', async () => {
    const tool = defineLLMTool(baseDef());
    expect(await tool.execute({ a: 'v' }, ctx(stubClient('  raw text  ')))).toBe('  raw text  ');
  });

  it('returns the raw text when outputFormat is "text"', async () => {
    const tool = defineLLMTool(baseDef({ outputFormat: 'text' }));
    expect(await tool.execute({ a: 'v' }, ctx(stubClient('t')))).toBe('t');
  });

  it('parses json output, tolerating markdown fences', async () => {
    const tool = defineLLMTool(baseDef({ outputFormat: 'json' }));
    expect(await tool.execute({ a: 'v' }, ctx(stubClient('```json\n{"k":1}\n```')))).toEqual({
      k: 1,
    });
  });

  it('wraps a JSON parse failure with the tool id, the parser error and the raw prefix', async () => {
    const tool = defineLLMTool(baseDef({ outputFormat: 'json' }));
    let message = '';
    try {
      await tool.execute({ a: 'v' }, ctx(stubClient('I refuse to answer.')));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('Tool test:tool@1.0.0 produced non-JSON output');
    expect(message).toContain('Parser error: ');
    expect(message).toContain('Raw (first 500 chars): I refuse to answer.');
  });

  it('truncates the raw output at 500 chars in the failure message', async () => {
    const tool = defineLLMTool(baseDef({ outputFormat: 'json' }));
    let message = '';
    try {
      await tool.execute({ a: 'v' }, ctx(stubClient('q'.repeat(900))));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('q'.repeat(500));
    expect(message).not.toContain('q'.repeat(501));
  });
});
