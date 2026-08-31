import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import { LocalBackend } from '../../../../src/plugins/internal-tools/backends/local';
import { ToolRegistry } from '../../../../src/plugins/internal-tools/registry';
import { InternalToolRunner } from '../../../../src/plugins/internal-tools/runner/runner';
import type { InternalToolRunnerConfig } from '../../../../src/plugins/internal-tools/runner/types';
import type {
  InternalTool,
  InternalToolContext,
} from '../../../../src/plugins/internal-tools/types';
import type {
  InternalToolCallCompleteContext,
  InternalToolCallErrorContext,
  InternalToolCallStartContext,
  WarningContext,
} from '../../../../src/bus/hook-map';
import type { EngineHandle } from '../../../../src/helpers/engine';
import type { ModelCatalog } from '../../../../src/catalog/catalog';
import type { LLMClient } from '../../../../src/llm/client';
import type { CompletionResponse } from '../../../../src/llm/types/response';

// ─── doubles ───────────────────────────────────────────────────────────

type StubClient = LLMClient & { destroyed: number; id: string };

function stubClient(id: string): StubClient {
  const client = { id, destroyed: 0, destroy: () => void client.destroyed++ };
  return client as unknown as StubClient;
}

function stubEngine() {
  const created: Array<{ provider: string; model: string; apiKey?: string }> = [];
  const clients: StubClient[] = [];
  const engine = {
    created,
    clients,
    handle: {
      createClient: (opts: { provider: string; model: string; apiKey?: string }) => {
        created.push({ provider: opts.provider, model: opts.model, apiKey: opts.apiKey });
        const c = stubClient(`${opts.provider}/${opts.model}#${created.length}`);
        clients.push(c);
        return c;
      },
    } as unknown as EngineHandle,
  };
  return engine;
}

function stubCatalog(dedicated: string[]): ModelCatalog {
  return {
    get: (provider: string, model: string) =>
      dedicated.includes(`${provider}/${model}`) ? { requiresDedicatedClient: true } : null,
    list: () => [],
  } as unknown as ModelCatalog;
}

function makeTool(over: Partial<InternalTool> = {}): InternalTool {
  return {
    id: 'test:tool@1.0.0',
    namespace: 'test',
    name: 'tool',
    version: '1.0.0',
    description: 'd',
    inputSchema: { type: 'object' },
    execute: async () => 'result',
    ...over,
  };
}

interface Harness {
  runner: InternalToolRunner;
  hooks: HookBus;
  backend: LocalBackend;
  engine: ReturnType<typeof stubEngine>;
  events: {
    start: InternalToolCallStartContext[];
    complete: InternalToolCallCompleteContext[];
    error: InternalToolCallErrorContext[];
    warning: WarningContext[];
  };
}

function harness(
  tools: InternalTool[],
  config: Partial<InternalToolRunnerConfig> = {},
  opts: { withEngine?: boolean } = {},
): Harness {
  const hooks = new HookBus();
  const backend = new LocalBackend();
  for (const t of tools) backend.register(t);
  const registry = new ToolRegistry().addBackend(backend);
  const engine = stubEngine();

  const events: Harness['events'] = { start: [], complete: [], error: [], warning: [] };
  hooks.on('onInternalToolCallStart', (c) => void events.start.push(c));
  hooks.on('onInternalToolCallComplete', (c) => void events.complete.push(c));
  hooks.on('onInternalToolCallError', (c) => void events.error.push(c));
  hooks.on('onWarning', (c) => void events.warning.push(c));

  const runner = new InternalToolRunner({
    hooks,
    registry,
    apiKeys: {},
    ...(opts.withEngine === false ? {} : { engine: engine.handle }),
    ...config,
  });
  return { runner, hooks, backend, engine, events };
}

// ─── construction / accessors ──────────────────────────────────────────

describe('InternalToolRunner — construction and accessors', () => {
  it('exposes the registry it was configured with', async () => {
    const h = harness([makeTool()]);
    expect(await h.runner.registry.get('test:tool@1.0.0')).not.toBeNull();
  });

  it('starts with an empty client pool', () => {
    expect(harness([]).runner.poolSize).toBe(0);
  });

  it('hands a tool the counter it was configured with', async () => {
    let seen: unknown;
    const counter = {
      estimate: () => 42,
      estimateMessage: () => 0,
      measure: async () => 42,
      measureMessage: async () => 0,
      learn: () => {},
    };
    const tool = makeTool({
      execute: async (_i, ctx: InternalToolContext) => {
        seen = ctx.counter;
        return 'ok';
      },
    });
    const h = harness([tool], { counter });
    await h.runner.run('test:tool@1.0.0', {});
    expect(seen).toBe(counter);
  });

  it('builds a default HybridTokenCounter when none is configured', async () => {
    let estimated = -1;
    const tool = makeTool({
      execute: async (_i, ctx: InternalToolContext) => {
        estimated = ctx.counter?.estimate('hello world') ?? -1;
        return 'ok';
      },
    });
    const h = harness([tool]);
    await h.runner.run('test:tool@1.0.0', {});
    expect(estimated).toBeGreaterThan(0);
  });
});

// ─── lookup ────────────────────────────────────────────────────────────

describe('InternalToolRunner — run / runDirect', () => {
  it('run resolves the tool through the registry', async () => {
    const h = harness([makeTool()]);
    expect(await h.runner.run<string>('test:tool@1.0.0', {})).toBe('result');
  });

  it('run throws when the id is unknown to the registry', async () => {
    const h = harness([makeTool()]);
    await expect(h.runner.run('test:missing@1.0.0', {})).rejects.toThrow(
      'Tool not found in registry: test:missing@1.0.0',
    );
  });

  it('runDirect executes a tool that was never registered', async () => {
    const h = harness([]);
    expect(await h.runner.runDirect<string>(makeTool({ execute: async () => 'direct' }), {})).toBe(
      'direct',
    );
  });
});

// ─── input validation ──────────────────────────────────────────────────

describe('InternalToolRunner — input validation', () => {
  it('skips validation entirely when the schema is not an object schema', async () => {
    const h = harness([]);
    const tool = makeTool({
      inputSchema: { type: 'string' },
      execute: async (input) => input,
    });
    expect(await h.runner.runDirect<string>(tool, 'a bare string')).toBe('a bare string');
  });

  it('skips validation when the tool declares no input schema', async () => {
    const h = harness([]);
    const tool = makeTool({
      inputSchema: undefined as never,
      execute: async (input) => input,
    });
    expect(await h.runner.runDirect<number>(tool, 5)).toBe(5);
  });

  it('rejects a non-object input for an object schema, naming the actual type', async () => {
    const h = harness([]);
    const tool = makeTool({ inputSchema: { type: 'object' } });
    await expect(h.runner.runDirect(tool, 'str')).rejects.toThrow(
      'Tool test:tool@1.0.0 expects object input, got string',
    );
    await expect(h.runner.runDirect(tool, 7)).rejects.toThrow(/expects object input, got number/);
  });

  it('rejects an array input for an object schema', async () => {
    const h = harness([]);
    const tool = makeTool({ inputSchema: { type: 'object' } });
    await expect(h.runner.runDirect(tool, [1, 2])).rejects.toThrow(
      'Tool test:tool@1.0.0 expects object input, got array',
    );
  });

  it('rejects a null input for an object schema', async () => {
    const h = harness([]);
    const tool = makeTool({ inputSchema: { type: 'object' } });
    await expect(h.runner.runDirect(tool, null)).rejects.toThrow(
      /expects object input, got object/,
    );
  });

  it('rejects input missing required fields, listing every one of them', async () => {
    const h = harness([]);
    const tool = makeTool({
      inputSchema: { type: 'object', properties: {}, required: ['a', 'b', 'c'] },
    });
    await expect(h.runner.runDirect(tool, { b: 1 })).rejects.toThrow(
      'Tool test:tool@1.0.0 missing required input fields: a, c',
    );
  });

  it('accepts a required field explicitly set to undefined (presence, not value)', async () => {
    const h = harness([]);
    const tool = makeTool({
      inputSchema: { type: 'object', required: ['a'] },
      execute: async () => 'ok',
    });
    expect(await h.runner.runDirect<string>(tool, { a: undefined })).toBe('ok');
  });

  it('accepts an object schema with no required list', async () => {
    const h = harness([]);
    const tool = makeTool({ inputSchema: { type: 'object', properties: { a: {} } } });
    expect(await h.runner.runDirect<string>(tool, {})).toBe('result');
  });

  it('validates before emitting any hook', async () => {
    const h = harness([]);
    const tool = makeTool({ inputSchema: { type: 'object', required: ['a'] } });
    await h.runner.runDirect(tool, {}).catch(() => {});
    expect(h.events.start).toHaveLength(0);
    expect(h.events.error).toHaveLength(0);
  });
});

// ─── non-LLM execution ─────────────────────────────────────────────────

describe('InternalToolRunner — non-LLM execution', () => {
  it('runs a tool with no model preference and no default model', async () => {
    const h = harness([]);
    expect(await h.runner.runDirect<string>(makeTool(), {})).toBe('result');
    expect(h.runner.poolSize).toBe(0);
  });

  it('emits start then complete with an empty chosenModel and attempt 1', async () => {
    const h = harness([]);
    await h.runner.runDirect(makeTool(), { q: 1 });
    expect(h.events.start).toEqual([
      { toolId: 'test:tool@1.0.0', input: { q: 1 }, chosenModel: '', attempt: 1 },
    ]);
    expect(h.events.complete).toHaveLength(1);
    expect(h.events.complete[0]?.output).toBe('result');
    expect(h.events.complete[0]?.chosenModel).toBe('');
    expect(h.events.complete[0]?.attempts).toBe(1);
    expect(h.events.complete[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('gives the tool hooks and a counter but no client or model', async () => {
    let seen: InternalToolContext | undefined;
    const tool = makeTool({
      execute: async (_i, ctx) => {
        seen = ctx;
        return 'ok';
      },
    });
    const h = harness([]);
    await h.runner.runDirect(tool, {});
    expect(seen?.hooks).toBe(h.hooks);
    expect(seen?.counter).toBeDefined();
    expect(seen?.client).toBeUndefined();
    expect(seen?.modelId).toBeUndefined();
  });

  it('emits an error hook and rethrows when the tool throws', async () => {
    const boom = new Error('boom');
    const h = harness([]);
    const tool = makeTool({
      execute: async () => {
        throw boom;
      },
    });
    let thrown: unknown;
    await h.runner.runDirect(tool, { q: 1 }).catch((e) => {
      thrown = e;
    });
    expect(thrown).toBe(boom);
    expect(h.events.error).toHaveLength(1);
    expect(h.events.error[0]).toEqual({
      toolId: 'test:tool@1.0.0',
      input: { q: 1 },
      chosenModel: '',
      error: boom,
      attempt: 1,
      willRetry: false,
    });
    expect(h.events.complete).toHaveLength(0);
  });
});

// ─── output validation ─────────────────────────────────────────────────

describe('InternalToolRunner — output validation', () => {
  const run = async (outputSchema: unknown, output: unknown) => {
    const h = harness([]);
    await h.runner.runDirect(
      makeTool({ outputSchema: outputSchema as never, execute: async () => output }),
      {},
    );
    return h.events.warning;
  };

  it('stays silent when the tool declares no output schema', async () => {
    expect(await run(undefined, 'anything')).toHaveLength(0);
  });

  it('stays silent when the output schema declares no type', async () => {
    expect(await run({ properties: {} }, 'anything')).toHaveLength(0);
  });

  it('stays silent for an unrecognised expected type', async () => {
    expect(await run({ type: 'integer' }, 'not an integer')).toHaveLength(0);
  });

  it.each([
    ['object', { a: 1 }],
    ['array', [1]],
    ['string', 's'],
    ['number', 1],
    ['boolean', true],
  ])('stays silent when a %s output matches the schema', async (type, output) => {
    expect(await run({ type }, output)).toHaveLength(0);
  });

  it.each([
    ['object', 'a string', 'string'],
    ['object', null, 'object'],
    ['object', [1], 'array'],
    ['array', { a: 1 }, 'object'],
    ['string', 1, 'number'],
    ['number', 's', 'string'],
    ['boolean', 1, 'number'],
  ])('warns when a %s schema receives %p', async (type, output, actual) => {
    const warnings = await run({ type }, output);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('output_schema_mismatch');
    expect(warnings[0]?.source).toBe('agent');
    expect(warnings[0]?.message).toBe(
      `Tool test:tool@1.0.0 output does not match schema: expected ${type}, got ${actual}`,
    );
    expect(warnings[0]?.details).toEqual({ toolId: 'test:tool@1.0.0' });
  });

  it('warns but still returns the value — a mismatch is not fatal', async () => {
    const h = harness([]);
    const tool = makeTool({ outputSchema: { type: 'object' }, execute: async () => 'nope' });
    expect(await h.runner.runDirect<string>(tool, {})).toBe('nope');
    expect(h.events.complete).toHaveLength(1);
  });
});

// ─── model resolution ──────────────────────────────────────────────────

describe('InternalToolRunner — model resolution order', () => {
  const llmTool = (over: Partial<InternalTool> = {}) =>
    makeTool({
      execute: async (_i, ctx: InternalToolContext) => ctx.modelId,
      ...over,
    });

  it('uses the runner default model when the tool states no preference', async () => {
    const h = harness([], { defaultModel: 'openai/fallback', apiKeys: { openai: 'k' } });
    expect(await h.runner.runDirect<string>(llmTool(), {})).toBe('openai/fallback');
  });

  it('ignores the runner default model once the tool states a preference', async () => {
    const h = harness([], { defaultModel: 'openai/fallback', apiKeys: { openai: 'k' } });
    const tool = llmTool({ modelPreference: { preferredModel: 'openai/preferred' } });
    expect(await h.runner.runDirect<string>(tool, {})).toBe('openai/preferred');
  });

  it('does not even append the default model as a fallback behind a preference', async () => {
    const h = harness([], { defaultModel: 'openai/fallback', apiKeys: { openai: 'k' } });
    const tool = llmTool({
      modelPreference: { preferredModel: 'openai/preferred' },
      execute: async () => {
        throw new Error('down');
      },
    });
    await expect(h.runner.runDirect(tool, {})).rejects.toThrow(
      'failed on all 1 model(s): openai/preferred: down',
    );
  });

  it('puts compat recommendations ahead of the tool preference', async () => {
    const h = harness([], {
      apiKeys: { openai: 'k' },
      compat: { 'test:tool@1.0.0': { recommended: ['openai/best', 'openai/second'] } },
    });
    const tool = llmTool({ modelPreference: { preferredModel: 'openai/preferred' } });
    expect(await h.runner.runDirect<string>(tool, {})).toBe('openai/best');
  });

  it('ignores compat entries recorded for a different tool', async () => {
    const h = harness([], {
      apiKeys: { openai: 'k' },
      compat: { 'other:tool@1.0.0': { recommended: ['openai/best'] } },
    });
    const tool = llmTool({ modelPreference: { preferredModel: 'openai/preferred' } });
    expect(await h.runner.runDirect<string>(tool, {})).toBe('openai/preferred');
  });

  it('falls through preferred → fallbacks in declaration order', async () => {
    let attempt = 0;
    const h = harness([], { apiKeys: { openai: 'k' } });
    const tool = llmTool({
      modelPreference: {
        preferredModel: 'openai/p',
        fallbackModels: ['openai/f1', 'openai/f2'],
      },
      execute: async (_i, ctx: InternalToolContext) => {
        attempt++;
        if (attempt < 3) throw new Error(`fail ${ctx.modelId}`);
        return ctx.modelId;
      },
    });
    expect(await h.runner.runDirect<string>(tool, {})).toBe('openai/f2');
  });

  it('de-duplicates a model that appears in several sources', async () => {
    const h = harness([], {
      apiKeys: { openai: 'k' },
      compat: { 'test:tool@1.0.0': { recommended: ['openai/m'] } },
    });
    const tool = llmTool({
      modelPreference: { preferredModel: 'openai/m', fallbackModels: ['openai/m'] },
      execute: async () => {
        throw new Error('always');
      },
    });
    await expect(h.runner.runDirect(tool, {})).rejects.toThrow('failed on all 1 model(s)');
  });

  it('uses fallbackModels even with no preferredModel', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    const tool = llmTool({ modelPreference: { fallbackModels: ['openai/only'] } });
    expect(await h.runner.runDirect<string>(tool, {})).toBe('openai/only');
  });

  it('treats an empty modelPreference as "no models" and runs the tool without an LLM', async () => {
    const h = harness([], { apiKeys: {} });
    const tool = llmTool({ modelPreference: {} });
    expect(await h.runner.runDirect(tool, {})).toBeUndefined();
    expect(h.events.start[0]?.chosenModel).toBe('');
  });
});

// ─── key availability ──────────────────────────────────────────────────

describe('InternalToolRunner — key availability', () => {
  const llmTool = makeTool({
    modelPreference: { preferredModel: 'openai/m', fallbackModels: ['google/m'] },
    execute: async (_i, ctx: InternalToolContext) => ctx.modelId,
  });

  it('throws before executing when no configured key covers any candidate model', async () => {
    const h = harness([], { apiKeys: { anthropic: 'k' } });
    await expect(h.runner.runDirect(llmTool, {})).rejects.toThrow(
      'Tool test:tool@1.0.0 requires API key for one of [openai, google]; ' +
        'runner has keys for [anthropic]',
    );
    await h.runner.runDirect(llmTool, {}).catch(() => {});
    expect(h.events.start).toHaveLength(0);
  });

  it('reports an empty available list when no keys are configured at all', async () => {
    const h = harness([], { apiKeys: {} });
    await expect(h.runner.runDirect(llmTool, {})).rejects.toThrow('runner has keys for []');
  });

  it('treats an empty-string key as absent', async () => {
    const h = harness([], { apiKeys: { openai: '', google: '' } });
    await expect(h.runner.runDirect(llmTool, {})).rejects.toThrow('runner has keys for []');
  });

  it('proceeds when at least one candidate provider has a key', async () => {
    const h = harness([], { apiKeys: { google: 'k' } });
    expect(await h.runner.runDirect<string>(llmTool, {})).toBe('google/m');
  });

  it('rejects a model id that carries no provider prefix', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    const tool = makeTool({ modelPreference: { preferredModel: 'bare-model' } });
    await expect(h.runner.runDirect(tool, {})).rejects.toThrow(
      'Invalid model ID "bare-model" (expected "provider/model")',
    );
  });

  it('rejects a model id whose slash is the first character', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    const tool = makeTool({ modelPreference: { preferredModel: '/model' } });
    await expect(h.runner.runDirect(tool, {})).rejects.toThrow('Invalid model ID "/model"');
  });
});

// ─── client pooling ────────────────────────────────────────────────────

describe('InternalToolRunner — client pooling', () => {
  const echoTool = (over: Partial<InternalTool> = {}) =>
    makeTool({
      execute: async (_i, ctx: InternalToolContext) => ctx.modelId,
      ...over,
    });

  it('builds the client through the engine, passing provider, model, key and hooks', async () => {
    const h = harness([], { apiKeys: { openai: 'sk-1' } });
    await h.runner.runDirect(echoTool({ modelPreference: { preferredModel: 'openai/gpt-x' } }), {});
    expect(h.engine.created).toEqual([{ provider: 'openai', model: 'gpt-x', apiKey: 'sk-1' }]);
  });

  it('pools by PROVIDER by default — two models of one provider share a client', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    const tool = echoTool({ modelPreference: { preferredModel: 'openai/a' } });
    await h.runner.runDirect(tool, {});
    await h.runner.runDirect(echoTool({ modelPreference: { preferredModel: 'openai/b' } }), {});
    expect(h.runner.poolSize).toBe(1);
    expect(h.engine.created).toHaveLength(1);
  });

  it('pools separately per provider', async () => {
    const h = harness([], { apiKeys: { openai: 'k', google: 'k' } });
    await h.runner.runDirect(echoTool({ modelPreference: { preferredModel: 'openai/a' } }), {});
    await h.runner.runDirect(echoTool({ modelPreference: { preferredModel: 'google/b' } }), {});
    expect(h.runner.poolSize).toBe(2);
  });

  it('pools by provider/model when the catalog flags requiresDedicatedClient', async () => {
    const h = harness([], {
      apiKeys: { openai: 'k' },
      catalog: stubCatalog(['openai/a', 'openai/b']),
    });
    await h.runner.runDirect(echoTool({ modelPreference: { preferredModel: 'openai/a' } }), {});
    await h.runner.runDirect(echoTool({ modelPreference: { preferredModel: 'openai/b' } }), {});
    expect(h.runner.poolSize).toBe(2);
  });

  it('still pools by provider for a model the catalog does not flag', async () => {
    const h = harness([], {
      apiKeys: { openai: 'k' },
      catalog: stubCatalog(['openai/dedicated']),
    });
    await h.runner.runDirect(echoTool({ modelPreference: { preferredModel: 'openai/a' } }), {});
    await h.runner.runDirect(echoTool({ modelPreference: { preferredModel: 'openai/b' } }), {});
    expect(h.runner.poolSize).toBe(1);
  });

  it('forwards clientOptions to every pooled client', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const hooks = new HookBus();
    const runner = new InternalToolRunner({
      hooks,
      registry: new ToolRegistry(),
      apiKeys: { openai: 'k' },
      clientOptions: { maxRetries: 3 } as never,
      engine: {
        createClient: (opts: Record<string, unknown>) => {
          seen.push(opts);
          return stubClient('c');
        },
      } as unknown as EngineHandle,
    });
    await runner.runDirect(echoTool({ modelPreference: { preferredModel: 'openai/a' } }), {});
    expect(seen[0]?.maxRetries).toBe(3);
    expect(seen[0]?.hooks).toBe(hooks);
  });

  it('fails the attempt with a clear message when no engine is configured', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } }, { withEngine: false });
    await expect(
      h.runner.runDirect(echoTool({ modelPreference: { preferredModel: 'openai/a' } }), {}),
    ).rejects.toThrow(
      'InternalToolRunner: engine is required to execute LLM-backed tools (tool model "openai/a")',
    );
  });

  it('refuses to build a client for a provider with no key', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    const getClient = (
      h.runner as unknown as { getClient(modelId: string): LLMClient }
    ).getClient.bind(h.runner);
    expect(() => getClient('google/m')).toThrow('No API key for provider: google');
  });
});

// ─── destroy ───────────────────────────────────────────────────────────

describe('InternalToolRunner — destroy', () => {
  it('destroys every pooled client and empties the pool', async () => {
    const h = harness([], { apiKeys: { openai: 'k', google: 'k' } });
    const tool = (m: string) =>
      makeTool({
        modelPreference: { preferredModel: m },
        execute: async () => 'ok',
      });
    await h.runner.runDirect(tool('openai/a'), {});
    await h.runner.runDirect(tool('google/b'), {});
    expect(h.runner.poolSize).toBe(2);

    await h.runner.destroy();

    expect(h.runner.poolSize).toBe(0);
    expect(h.engine.clients.map((c) => c.destroyed)).toEqual([1, 1]);
  });

  it('is a no-op on an empty pool', async () => {
    const h = harness([]);
    await h.runner.destroy();
    expect(h.runner.poolSize).toBe(0);
  });

  it('rebuilds clients after destroy', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    const tool = makeTool({
      modelPreference: { preferredModel: 'openai/a' },
      execute: async () => 'ok',
    });
    await h.runner.runDirect(tool, {});
    await h.runner.destroy();
    await h.runner.runDirect(tool, {});
    expect(h.engine.created).toHaveLength(2);
  });
});

// ─── LLM execution and fallback ────────────────────────────────────────

describe('InternalToolRunner — LLM execution', () => {
  it('gives the tool a client, model id, tool id, hooks and counter', async () => {
    let seen: InternalToolContext | undefined;
    const h = harness([], { apiKeys: { openai: 'k' } });
    await h.runner.runDirect(
      makeTool({
        modelPreference: { preferredModel: 'openai/gpt-x' },
        execute: async (_i, ctx) => {
          seen = ctx;
          return 'ok';
        },
      }),
      {},
    );
    expect(seen?.client).toBe(h.engine.clients[0]);
    expect(seen?.modelId).toBe('openai/gpt-x');
    expect(seen?.toolId).toBe('test:tool@1.0.0');
    expect(seen?.hooks).toBe(h.hooks);
    expect(seen?.counter).toBeDefined();
  });

  it('emits start with the chosen model and attempt 1, then complete', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    await h.runner.runDirect(makeTool({ modelPreference: { preferredModel: 'openai/gpt-x' } }), {
      q: 1,
    });
    expect(h.events.start).toEqual([
      { toolId: 'test:tool@1.0.0', input: { q: 1 }, chosenModel: 'openai/gpt-x', attempt: 1 },
    ]);
    expect(h.events.complete[0]?.chosenModel).toBe('openai/gpt-x');
    expect(h.events.complete[0]?.attempts).toBe(1);
  });

  it('reports the usage the tool recorded via recordLLMResponse', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    const usage = {
      inputTokens: 5,
      outputTokens: 6,
      totalTokens: 11,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    await h.runner.runDirect(
      makeTool({
        modelPreference: { preferredModel: 'openai/gpt-x' },
        execute: async (_i, ctx: InternalToolContext) => {
          ctx.recordLLMResponse?.({ usage } as unknown as CompletionResponse);
          return 'ok';
        },
      }),
      {},
    );
    expect(h.events.complete[0]?.usage).toEqual(usage);
  });

  it('reports undefined usage when the tool never records a response', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    await h.runner.runDirect(makeTool({ modelPreference: { preferredModel: 'openai/gpt-x' } }), {});
    expect(h.events.complete[0]?.usage).toBeUndefined();
  });

  it('keeps only the LAST recorded usage when a tool makes several calls', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    await h.runner.runDirect(
      makeTool({
        modelPreference: { preferredModel: 'openai/gpt-x' },
        execute: async (_i, ctx: InternalToolContext) => {
          ctx.recordLLMResponse?.({ usage: { outputTokens: 1 } } as unknown as CompletionResponse);
          ctx.recordLLMResponse?.({ usage: { outputTokens: 2 } } as unknown as CompletionResponse);
          return 'ok';
        },
      }),
      {},
    );
    expect(h.events.complete[0]?.usage).toEqual({ outputTokens: 2 } as never);
  });

  it('validates the output of an LLM-backed tool too', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    await h.runner.runDirect(
      makeTool({
        modelPreference: { preferredModel: 'openai/gpt-x' },
        outputSchema: { type: 'array' },
        execute: async () => 'not an array',
      }),
      {},
    );
    expect(h.events.warning.map((w) => w.code)).toContain('output_schema_mismatch');
  });
});

describe('InternalToolRunner — LLM fallback', () => {
  const failThenSucceed = (failFor: string[]) =>
    makeTool({
      modelPreference: {
        preferredModel: 'openai/first',
        fallbackModels: ['openai/second', 'openai/third'],
      },
      execute: async (_i, ctx: InternalToolContext) => {
        if (failFor.includes(ctx.modelId ?? '')) throw new Error(`down: ${ctx.modelId}`);
        return ctx.modelId;
      },
    });

  it('moves to the next model and reports the attempt number', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    expect(await h.runner.runDirect<string>(failThenSucceed(['openai/first']), {})).toBe(
      'openai/second',
    );
    expect(h.events.start.map((e) => [e.chosenModel, e.attempt])).toEqual([
      ['openai/first', 1],
      ['openai/second', 2],
    ]);
    expect(h.events.complete[0]?.attempts).toBe(2);
  });

  it('emits an error hook with willRetry=true for every model but the last', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    await h.runner.runDirect(failThenSucceed(['openai/first', 'openai/second']), {});
    expect(h.events.error.map((e) => [e.chosenModel, e.attempt, e.willRetry])).toEqual([
      ['openai/first', 1, true],
      ['openai/second', 2, true],
    ]);
  });

  it('emits an internal_tool_fallback warning naming the failed model', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    await h.runner.runDirect(failThenSucceed(['openai/first']), {});
    const warn = h.events.warning.find((w) => w.code === 'internal_tool_fallback');
    expect(warn?.source).toBe('agent');
    expect(warn?.message).toBe('Tool test:tool@1.0.0 failed on openai/first, trying next model');
    expect(warn?.details).toEqual({
      toolId: 'test:tool@1.0.0',
      failedModel: 'openai/first',
      errorMessage: 'down: openai/first',
    });
  });

  it('does NOT emit a fallback warning after the final model fails', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    await h.runner
      .runDirect(failThenSucceed(['openai/first', 'openai/second', 'openai/third']), {})
      .catch(() => {});
    expect(h.events.warning.filter((w) => w.code === 'internal_tool_fallback')).toHaveLength(2);
    expect(h.events.error[2]?.willRetry).toBe(false);
  });

  it('throws a summary of every failure once all models are exhausted', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    await expect(
      h.runner.runDirect(failThenSucceed(['openai/first', 'openai/second', 'openai/third']), {}),
    ).rejects.toThrow(
      'Tool test:tool@1.0.0 failed on all 3 model(s): openai/first: down: openai/first; ' +
        'openai/second: down: openai/second; openai/third: down: openai/third',
    );
  });

  it('does not emit a complete hook when every model fails', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    await h.runner
      .runDirect(failThenSucceed(['openai/first', 'openai/second', 'openai/third']), {})
      .catch(() => {});
    expect(h.events.complete).toHaveLength(0);
  });

  it('skips a model whose provider has no key, without emitting a start hook for it', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    const tool = makeTool({
      modelPreference: {
        preferredModel: 'google/gemini',
        fallbackModels: ['openai/gpt-x'],
      },
      execute: async (_i, ctx: InternalToolContext) => ctx.modelId,
    });
    expect(await h.runner.runDirect<string>(tool, {})).toBe('openai/gpt-x');
    expect(h.events.start.map((e) => e.chosenModel)).toEqual(['openai/gpt-x']);
    expect(h.events.error).toHaveLength(0);
  });

  it('folds a skipped keyless model into the final failure summary', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } });
    const tool = makeTool({
      modelPreference: {
        preferredModel: 'google/gemini',
        fallbackModels: ['openai/gpt-x'],
      },
      execute: async () => {
        throw new Error('nope');
      },
    });
    await expect(h.runner.runDirect(tool, {})).rejects.toThrow(
      'failed on all 2 model(s): google/gemini: No API key for google; openai/gpt-x: nope',
    );
  });

  it('folds a client-construction failure into the summary and moves on', async () => {
    const hooks = new HookBus();
    let calls = 0;
    const runner = new InternalToolRunner({
      hooks,
      registry: new ToolRegistry(),
      apiKeys: { openai: 'k' },
      engine: {
        createClient: () => {
          calls++;
          if (calls === 1) throw new Error('adapter missing');
          return stubClient('ok');
        },
      } as unknown as EngineHandle,
      catalog: stubCatalog(['openai/a', 'openai/b']),
    });
    const tool = makeTool({
      modelPreference: { preferredModel: 'openai/a', fallbackModels: ['openai/b'] },
      execute: async (_i, ctx: InternalToolContext) => ctx.modelId,
    });
    expect(await runner.runDirect<string>(tool, {})).toBe('openai/b');
  });

  it('reports every model as failed when no engine can build any client', async () => {
    const h = harness([], { apiKeys: { openai: 'k' } }, { withEngine: false });
    const tool = makeTool({
      modelPreference: { preferredModel: 'openai/a', fallbackModels: ['openai/b'] },
    });
    await expect(h.runner.runDirect(tool, {})).rejects.toThrow('failed on all 2 model(s)');
    expect(h.events.start).toHaveLength(0);
  });
});
