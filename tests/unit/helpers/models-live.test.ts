/** listModelsLive — enriched by default, raw opt-out, OR built live, 24h cache. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { ModelCatalog } from '../../../src/catalog/catalog';
import { clearLiveModelsCache, listModelsLive } from '../../../src/helpers/models';
import type { EngineHandle } from '../../../src/helpers/engine';

/** Fake engine whose fetch returns a canned body and counts calls. */
function fakeEngine(body: Record<string, unknown>) {
  let calls = 0;
  const catalog = new ModelCatalog();
  catalog.loadProviderDefaults();
  const engine = {
    catalog,
    apiKeys: { anthropic: 'k', openrouter: 'k' },
    fetch: async () => {
      calls++;
      return { status: 200, headers: {}, body };
    },
  } as unknown as EngineHandle;
  return { engine, calls: () => calls };
}

beforeEach(() => clearLiveModelsCache());

describe('listModelsLive', () => {
  it('raw:true → bare id strings', async () => {
    const { engine } = fakeEngine({ data: [{ id: 'claude-opus-4-8' }, { id: 'claude-haiku-4-5' }] });
    const ids = await listModelsLive({ provider: 'anthropic', engine, raw: true });
    expect(ids).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
  });

  it('enriched (default): a live id known to the catalog returns the frozen entry', async () => {
    const { engine } = fakeEngine({ data: [{ id: 'claude-opus-4-8' }] });
    const models = await listModelsLive({ provider: 'anthropic', engine });
    expect(models).toHaveLength(1);
    expect(models[0].model).toBe('claude-opus-4.8'); // resolved to the slug entry
    expect(models[0].pricing.tiers?.priority).toBeDefined();
  });

  it('enriched: a live-only id (not in catalog) gets a minimal entry', async () => {
    const { engine } = fakeEngine({ data: [{ id: 'claude-future-9' }] });
    const models = await listModelsLive({ provider: 'anthropic', engine });
    expect(models[0].model).toBe('claude-future-9');
    expect(models[0].providerModelName).toBe('claude-future-9');
  });

  it('openrouter built live from the API (prices + caps)', async () => {
    const { engine } = fakeEngine({
      data: [
        {
          id: 'perplexity/sonar',
          pricing: { prompt: '0.000001', completion: '0.000001' },
          context_length: 127000,
          supported_parameters: ['tools', 'web_search_options'],
          architecture: { input_modalities: ['text'] },
        },
      ],
    });
    const models = await listModelsLive({ provider: 'openrouter', engine });
    expect(models[0].model).toBe('perplexity/sonar');
    expect(models[0].pricing.inputPerMTok).toBe(1); // 0.000001 * 1e6
    expect(models[0].contextWindow).toBe(127000);
    expect(models[0].capabilities.toolUse).toBe(true);
  });

  it('caches for 24h — a second call does not re-fetch', async () => {
    const { engine, calls } = fakeEngine({ data: [{ id: 'claude-opus-4-8' }] });
    await listModelsLive({ provider: 'anthropic', engine });
    await listModelsLive({ provider: 'anthropic', engine });
    expect(calls()).toBe(1);
  });

  it('refresh:true bypasses the cache', async () => {
    const { engine, calls } = fakeEngine({ data: [{ id: 'claude-opus-4-8' }] });
    await listModelsLive({ provider: 'anthropic', engine });
    await listModelsLive({ provider: 'anthropic', engine, refresh: true });
    expect(calls()).toBe(2);
  });

  it('dedups concurrent calls for the same provider (one network request)', async () => {
    // The cache only stores COMPLETED results; without in-flight dedup, two
    // simultaneous callers (e.g. a React effect double-fired by StrictMode)
    // would each hit the network.
    const { engine, calls } = fakeEngine({ data: [{ id: 'claude-opus-4-8' }] });
    const [a, b] = await Promise.all([
      listModelsLive({ provider: 'anthropic', engine, raw: true }),
      listModelsLive({ provider: 'anthropic', engine, raw: true }),
    ]);
    expect(calls()).toBe(1);
    expect(a).toEqual(b);
  });
});

// ─── the browser opt-in header ──────────────────────────────────────────────

import { buildFromSpec } from '../../../src/wire/interpreter';
import { makeRegistry } from '../../../src/llm/wire-transforms';
import { utilitySpec } from '../../../src/wire/utility-specs';

/**
 * Anthropic refuses a browser request without an explicit opt-in header. The
 * chat path sends it (messages.ts) and so do the anthropic files specs, but
 * models.list LOST it when this request moved to a spec: the header had lived
 * in the helper's own LiveSpec.headers table, which nothing called any more.
 * A browser listing models would have been rejected by CORS.
 */
describe('anthropic models.list carries the browser opt-in', () => {
  function headersFor(input: Record<string, unknown>): Record<string, string> {
    const built = buildFromSpec(
      utilitySpec('anthropic/models.list'),
      input as never,
      makeRegistry({}),
      'anthropic',
      undefined,
      { apiKey: 'k', apiVersion: '2023-06-01' },
    ) as unknown as { headers: Record<string, string> };
    return built.headers;
  }

  it('sends it in a browser', () => {
    expect(headersFor({ browser: true })['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('does NOT send it elsewhere', () => {
    // The header names an exception; an exception nobody needs should not be
    // asked for.
    expect(headersFor({ browser: false })).not.toHaveProperty(
      'anthropic-dangerous-direct-browser-access',
    );
  });

  it('still sends the auth and version headers either way', () => {
    for (const browser of [true, false]) {
      const h = headersFor({ browser });
      expect(h['x-api-key']).toBe('k');
      expect(h['anthropic-version']).toBe('2023-06-01');
    }
  });
});
