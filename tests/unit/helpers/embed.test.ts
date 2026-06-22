/** embed() unit tests.
 *  Uses a stubbed EmbeddingProviderAdapter injected via opts.adapter so no
 *  real network call is made. Also asserts that onCompletion is emitted on
 *  the hook bus (the telemetry hook added in the embed() helper). */

import { describe, expect, it } from 'bun:test';
import { embed } from '../../../src/helpers/embed';
import { HookBus } from '../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';
import type { EngineHandle } from '../../../src/helpers/engine';
import type { EmbeddingProviderAdapter, EmbedResult } from '../../../src/plugins/embeddings/types';
import type { CompletionContext } from '../../../src/bus/hook-map';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FAKE_VECTOR = [0.1, 0.2, 0.3];

/** Build a fake EmbeddingProviderAdapter that returns a canned result. */
function fakeAdapter(result: Partial<EmbedResult> = {}): EmbeddingProviderAdapter {
  return {
    name: 'fake',
    async embed(_req, _fetch): Promise<EmbedResult> {
      return {
        embeddings: result.embeddings ?? [FAKE_VECTOR],
        model: result.model ?? 'text-embedding-3-small',
        dimensions: result.dimensions ?? FAKE_VECTOR.length,
        usage: result.usage,
      };
    },
  };
}

/** Minimal engine with a live HookBus (for testing hook emission). */
function makeEngine(): EngineHandle & { hooks: HookBus } {
  const hooks = new HookBus();
  return {
    apiKeys: { openai: 'test-key' },
    catalog: new ModelCatalog(),
    hooks,
    fetch: async () => ({ status: 200, headers: {}, body: {} }),
  } as unknown as EngineHandle & { hooks: HookBus };
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('embed — happy path', () => {
  it('returns embeddings and dimensions from the adapter', async () => {
    const result = await embed({
      model: 'openai/text-embedding-3-small',
      input: 'hello world',
      apiKey: 'test-key',
      adapter: fakeAdapter({ embeddings: [FAKE_VECTOR], dimensions: FAKE_VECTOR.length }),
      engine: makeEngine(),
    });
    expect(result.embeddings).toEqual([FAKE_VECTOR]);
    expect(result.dimensions).toBe(FAKE_VECTOR.length);
  });

  it('accepts string[] input and returns one vector per element', async () => {
    const twoVecs = [[0.1, 0.2], [0.3, 0.4]];
    const result = await embed({
      model: 'openai/text-embedding-3-small',
      input: ['hello', 'world'],
      apiKey: 'test-key',
      adapter: fakeAdapter({ embeddings: twoVecs, dimensions: 2 }),
      engine: makeEngine(),
    });
    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toEqual([0.1, 0.2]);
    expect(result.embeddings[1]).toEqual([0.3, 0.4]);
  });

  it('returns the model id echoed from the adapter', async () => {
    const result = await embed({
      model: 'openai/text-embedding-3-small',
      input: 'test',
      apiKey: 'test-key',
      adapter: fakeAdapter({ model: 'text-embedding-3-small' }),
      engine: makeEngine(),
    });
    expect(result.model).toBe('text-embedding-3-small');
  });
});

// ─── onCompletion hook emission ───────────────────────────────────────────────

describe('embed — onCompletion telemetry hook', () => {
  it('emits onCompletion on the hook bus when usage is present', async () => {
    const engine = makeEngine();
    const completions: CompletionContext[] = [];
    engine.hooks.on('onCompletion', (ctx) => { completions.push(ctx); });

    await embed({
      model: 'openai/text-embedding-3-small',
      input: 'emit test',
      apiKey: 'test-key',
      adapter: fakeAdapter({ usage: { inputTokens: 42 } }),
      engine,
    });

    expect(completions).toHaveLength(1);
    expect(completions[0].provider).toBe('openai');
    expect(completions[0].model).toBe('text-embedding-3-small');
    expect(completions[0].response.usage.inputTokens).toBe(42);
  });

  it('does NOT emit onCompletion when usage is absent', async () => {
    const engine = makeEngine();
    const completions: CompletionContext[] = [];
    engine.hooks.on('onCompletion', (ctx) => { completions.push(ctx); });

    await embed({
      model: 'openai/text-embedding-3-small',
      input: 'no usage',
      apiKey: 'test-key',
      adapter: fakeAdapter({ usage: undefined }),
      engine,
    });

    // No usage on the result => emitEmbedCompletion returns early => bus stays silent
    expect(completions).toHaveLength(0);
  });
});

// ─── API-key guard ────────────────────────────────────────────────────────────

describe('embed — api-key validation', () => {
  it('throws when no apiKey and engine.apiKeys has none for the provider', async () => {
    const engine: EngineHandle = {
      apiKeys: {},
      catalog: new ModelCatalog(),
      hooks: new HookBus(),
      fetch: async () => ({ status: 200, headers: {}, body: {} }),
    } as unknown as EngineHandle;

    await expect(
      embed({
        model: 'openai/text-embedding-3-small',
        input: 'test',
        adapter: fakeAdapter(),
        engine,
      }),
    ).rejects.toThrow(/no API key/);
  });

  it('falls back to engine.apiKeys when apiKey is not explicit', async () => {
    const engine: EngineHandle = {
      apiKeys: { openai: 'engine-key' },
      catalog: new ModelCatalog(),
      hooks: new HookBus(),
      fetch: async () => ({ status: 200, headers: {}, body: {} }),
    } as unknown as EngineHandle;

    // No error expected -- engine provides the key
    const result = await embed({
      model: 'openai/text-embedding-3-small',
      input: 'test',
      adapter: fakeAdapter(),
      engine,
    });
    expect(result.embeddings).toBeDefined();
  });
});

// ─── Unsupported provider ─────────────────────────────────────────────────────

describe('embed — unsupported provider', () => {
  it('throws when defaultEmbeddingAdapter is invoked for anthropic (no adapter override)', async () => {
    const engine: EngineHandle = {
      apiKeys: { anthropic: 'key' },
      catalog: new ModelCatalog(),
      hooks: new HookBus(),
      fetch: async () => ({ status: 200, headers: {}, body: {} }),
    } as unknown as EngineHandle;

    await expect(
      embed({
        model: 'anthropic/claude-haiku-4-5',
        input: 'test',
        // no adapter override -- will hit defaultEmbeddingAdapter
        engine,
      }),
    ).rejects.toThrow(/no embedding adapter/);
  });
});
