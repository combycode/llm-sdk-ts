/** ClientPool unit tests.
 *  Verifies: key reuse semantics, catalog-based dedicated-client override,
 *  size tracking, and destroy(). No network, no real API calls. */

import { describe, expect, it } from 'bun:test';
import { ClientPool } from '../../../src/helpers/client-pool';
import { LLMClient } from '../../../src/llm/client';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';
import type { LLMClientConfig } from '../../../src/llm/client-config';
import { HookBus } from '../../../src/bus/hook-bus';

// ─── Minimal config factory ───────────────────────────────────────────────────

/** Build a minimal LLMClientConfig accepted by LLMClient constructor.
 *  We supply a stub adapter + fetch so the client never actually hits the net. */
function minConfig(provider: string, model: string): LLMClientConfig {
  const bus = new HookBus();
  return {
    provider: provider as 'openai',
    model,
    apiKey: 'test-key',
    // Minimal no-op adapter
    adapter: {
      buildRequest: () => ({ url: 'https://test', method: 'POST', headers: {}, body: {} }),
      parseResponse: () => ({
        id: 'r',
        model,
        content: [{ type: 'text', text: '' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        text: '',
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 0,
        raw: null,
      }),
    },
    // No-op fetch -- never called in pool tests
    fetch: async () => ({ status: 200, headers: {}, body: {} }),
    hooks: bus,
  } as unknown as LLMClientConfig;
}

// ─── Key reuse (same provider -> same client) ──────────────────────────────────

describe('ClientPool — key reuse', () => {
  it('same provider+model returns the identical client instance', () => {
    const pool = new ClientPool();
    const cfg = minConfig('openai', 'gpt-5-nano');
    const a = pool.get('openai', 'gpt-5-nano', cfg);
    const b = pool.get('openai', 'gpt-5-nano', cfg);
    expect(a).toBe(b);
  });

  it('same provider but different model returns the SAME client (keyed by provider)', () => {
    const pool = new ClientPool();
    const a = pool.get('openai', 'gpt-5-nano', minConfig('openai', 'gpt-5-nano'));
    const b = pool.get('openai', 'gpt-5-mini', minConfig('openai', 'gpt-5-mini'));
    // Both keyed to 'openai' (no catalog => no requiresDedicatedClient)
    expect(a).toBe(b);
  });

  it('different providers return different clients', () => {
    const pool = new ClientPool();
    const a = pool.get('openai', 'gpt-5-nano', minConfig('openai', 'gpt-5-nano'));
    const b = pool.get('anthropic', 'claude-haiku-4-5', minConfig('anthropic', 'claude-haiku-4-5'));
    expect(a).not.toBe(b);
  });
});

// ─── size ─────────────────────────────────────────────────────────────────────

describe('ClientPool — size', () => {
  it('starts at 0', () => {
    expect(new ClientPool().size).toBe(0);
  });

  it('increments when a new provider is seen', () => {
    const pool = new ClientPool();
    pool.get('openai', 'gpt-5-nano', minConfig('openai', 'gpt-5-nano'));
    expect(pool.size).toBe(1);
    pool.get('anthropic', 'claude-haiku-4-5', minConfig('anthropic', 'claude-haiku-4-5'));
    expect(pool.size).toBe(2);
  });

  it('does not grow when the same key is reused', () => {
    const pool = new ClientPool();
    const cfg = minConfig('openai', 'gpt-5-nano');
    pool.get('openai', 'gpt-5-nano', cfg);
    pool.get('openai', 'gpt-5-nano', cfg);
    expect(pool.size).toBe(1);
  });
});

// ─── destroy() ────────────────────────────────────────────────────────────────

describe('ClientPool — destroy', () => {
  it('clears the pool (size becomes 0)', async () => {
    const pool = new ClientPool();
    pool.get('openai', 'gpt-5-nano', minConfig('openai', 'gpt-5-nano'));
    expect(pool.size).toBe(1);
    await pool.destroy();
    expect(pool.size).toBe(0);
  });

  it('returns a new client after destroy (pool re-fills)', async () => {
    const pool = new ClientPool();
    const cfg = minConfig('openai', 'gpt-5-nano');
    const before = pool.get('openai', 'gpt-5-nano', cfg);
    await pool.destroy();
    const after = pool.get('openai', 'gpt-5-nano', cfg);
    // After destroy the pool is empty, so a new client is created
    expect(after).not.toBe(before);
  });
});

// ─── requiresDedicatedClient via catalog ──────────────────────────────────────

describe('ClientPool — catalog-based dedicated client', () => {
  it('separate key per model when requiresDedicatedClient=true', () => {
    const catalog = new ModelCatalog();
    catalog.set('openai', 'dedicated-model', {
      pricing: {},
      requiresDedicatedClient: true,
    });

    const pool = new ClientPool(catalog);
    const a = pool.get('openai', 'dedicated-model', minConfig('openai', 'dedicated-model'));
    const b = pool.get('openai', 'dedicated-model', minConfig('openai', 'dedicated-model'));
    // Same model with requiresDedicatedClient -- same key, same instance
    expect(a).toBe(b);

    const c = pool.get('openai', 'other-model', minConfig('openai', 'other-model'));
    // other-model has no catalog entry => keyed by provider 'openai' which is a DIFFERENT key
    // than 'openai/dedicated-model', so c must differ from a
    expect(c).not.toBe(a);
  });

  it('non-dedicated model shares a provider-level slot (no catalog)', () => {
    const pool = new ClientPool(); // no catalog
    const a = pool.get('openai', 'model-x', minConfig('openai', 'model-x'));
    const b = pool.get('openai', 'model-y', minConfig('openai', 'model-y'));
    // No catalog => keyFor returns 'openai' for both
    expect(a).toBe(b);
  });

  it('returns an LLMClient instance', () => {
    const pool = new ClientPool();
    const client = pool.get('openai', 'gpt-5-nano', minConfig('openai', 'gpt-5-nano'));
    expect(client).toBeInstanceOf(LLMClient);
  });
});
