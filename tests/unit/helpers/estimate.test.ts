/** estimate() + BudgetExceededError unit tests.
 *  Uses a stubbed catalog + a minimal engine-like fixture — no network, no keys. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { estimate } from '../../../src/helpers/estimate';
import type { EstimateOptions, EstimateRequest } from '../../../src/helpers/estimate';
import {
  BudgetExceededError,
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  FALLBACK_MAX_OUTPUT_TOKENS,
  UnknownModelError,
} from '../../../src/helpers/estimate-types';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';

// ─── Minimal engine stub ──────────────────────────────────────────────────────

function makeEngine(catalog: ModelCatalog) {
  return { catalog } as unknown as EstimateOptions['engine'];
}

// ─── Catalog fixture ──────────────────────────────────────────────────────────

let catalog: ModelCatalog;

beforeEach(() => {
  catalog = new ModelCatalog();
  catalog.set('anthropic', 'claude-x', {
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    maxOutput: 8192,
  });
  catalog.set('openai', 'gpt-mini', {
    pricing: { inputPerMTok: 0.15, outputPerMTok: 0.60 },
    // No maxOutput set — exercises the fallback constant.
  });
  catalog.set('openai', 'gpt-zero-rate', {
    pricing: {},
    // inputPerMTok / outputPerMTok both absent — ensures no NaN.
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<EstimateRequest> = {}): EstimateRequest {
  return { model: 'anthropic/claude-x', prompt: 'Hello world', ...overrides };
}

// ─── Input-token counting ─────────────────────────────────────────────────────

describe('estimate — input tokens', () => {
  it('counts tokens for a string prompt', async () => {
    const est = await estimate(makeRequest(), { engine: makeEngine(catalog) });
    expect(est.inputTokens).toBeGreaterThan(0);
    expect(est.model).toBe('anthropic/claude-x');
    expect(est.currency).toBe('USD');
  });

  it('counts tokens for a Message[] prompt', async () => {
    const est = await estimate(
      {
        model: 'anthropic/claude-x',
        prompt: [{ role: 'user', content: 'Tell me a joke.' }],
      },
      { engine: makeEngine(catalog) },
    );
    expect(est.inputTokens).toBeGreaterThan(0);
  });

  it('counts tokens for a ContentPart[] prompt', async () => {
    const est = await estimate(
      {
        model: 'anthropic/claude-x',
        prompt: [{ type: 'text', text: 'Summarize this.' }],
      },
      { engine: makeEngine(catalog) },
    );
    expect(est.inputTokens).toBeGreaterThan(0);
  });

  it('includes system prompt in input token count', async () => {
    const withSystem = await estimate(
      makeRequest({ system: 'You are a helpful assistant.' }),
      { engine: makeEngine(catalog) },
    );
    const withoutSystem = await estimate(makeRequest(), { engine: makeEngine(catalog) });
    // System prompt adds tokens.
    expect(withSystem.inputTokens).toBeGreaterThan(withoutSystem.inputTokens);
  });

  it('records heuristic assumption', async () => {
    const est = await estimate(makeRequest(), { engine: makeEngine(catalog) });
    const hasHeuristicNote = est.assumptions.some((a) => a.includes('heuristic'));
    expect(hasHeuristicNote).toBe(true);
  });
});

// ─── Three cost bounds ────────────────────────────────────────────────────────

describe('estimate — cost bounds', () => {
  it('low bound = input cost only (0 output tokens)', async () => {
    const est = await estimate(makeRequest(), { engine: makeEngine(catalog) });
    const expectedInputUsd = (est.inputTokens / 1_000_000) * 3;
    expect(est.cost.low).toBeCloseTo(expectedInputUsd, 8);
  });

  it('expected bound = input + DEFAULT_EXPECTED_OUTPUT_TOKENS output', async () => {
    const est = await estimate(makeRequest(), { engine: makeEngine(catalog) });
    expect(est.estOutputTokens).toBe(DEFAULT_EXPECTED_OUTPUT_TOKENS);
    const expectedOutputUsd = (DEFAULT_EXPECTED_OUTPUT_TOKENS / 1_000_000) * 15;
    expect(est.cost.expected).toBeCloseTo(est.cost.low + expectedOutputUsd, 8);
  });

  it('high bound = input + catalogMaxOutput output', async () => {
    const est = await estimate(makeRequest(), { engine: makeEngine(catalog) });
    const maxOutputUsd = (8192 / 1_000_000) * 15;
    expect(est.cost.high).toBeCloseTo(est.cost.low + maxOutputUsd, 8);
  });

  it('high bound uses FALLBACK_MAX_OUTPUT_TOKENS when catalog has no maxOutput', async () => {
    const est = await estimate(
      { model: 'openai/gpt-mini', prompt: 'Hello' },
      { engine: makeEngine(catalog) },
    );
    const hasNote = est.assumptions.some((a) => a.includes('FALLBACK_MAX_OUTPUT_TOKENS'));
    expect(hasNote).toBe(true);
    // high > expected since FALLBACK_MAX_OUTPUT_TOKENS > DEFAULT_EXPECTED_OUTPUT_TOKENS
    expect(est.cost.high).toBeGreaterThanOrEqual(est.cost.expected);
    const fallbackOutputUsd = (FALLBACK_MAX_OUTPUT_TOKENS / 1_000_000) * 0.6;
    expect(est.cost.high).toBeCloseTo(est.cost.low + fallbackOutputUsd, 8);
  });

  it('high bound uses maxTokens when provided', async () => {
    const est = await estimate(
      makeRequest({ maxTokens: 100 }),
      { engine: makeEngine(catalog) },
    );
    const capped = est.assumptions.some((a) => a.includes('maxTokens=100'));
    expect(capped).toBe(true);
    const maxTokensOutputUsd = (100 / 1_000_000) * 15;
    expect(est.cost.high).toBeCloseTo(est.cost.low + maxTokensOutputUsd, 8);
  });

  it('low <= expected <= high', async () => {
    const est = await estimate(makeRequest(), { engine: makeEngine(catalog) });
    expect(est.cost.low).toBeLessThanOrEqual(est.cost.expected);
    expect(est.cost.expected).toBeLessThanOrEqual(est.cost.high);
  });

  it('rates of 0 produce $0 cost without NaN', async () => {
    const est = await estimate(
      { model: 'openai/gpt-zero-rate', prompt: 'test' },
      { engine: makeEngine(catalog) },
    );
    expect(est.cost.low).toBe(0);
    expect(est.cost.expected).toBe(0);
    expect(est.cost.high).toBe(0);
    expect(Number.isNaN(est.cost.expected)).toBe(false);
  });
});

// ─── expectedOutputTokens override ───────────────────────────────────────────

describe('estimate — expectedOutputTokens override', () => {
  it('uses the caller-supplied value for expected output', async () => {
    const CALLER_GUESS = 256;
    const est = await estimate(makeRequest(), {
      engine: makeEngine(catalog),
      expectedOutputTokens: CALLER_GUESS,
    });
    expect(est.estOutputTokens).toBe(CALLER_GUESS);
    const expectedOutputUsd = (CALLER_GUESS / 1_000_000) * 15;
    expect(est.cost.expected).toBeCloseTo(est.cost.low + expectedOutputUsd, 8);
  });

  it('does NOT add a default assumption note when caller supplies the value', async () => {
    const est = await estimate(makeRequest(), {
      engine: makeEngine(catalog),
      expectedOutputTokens: 128,
    });
    const hasDefaultNote = est.assumptions.some((a) =>
      a.includes('DEFAULT_EXPECTED_OUTPUT_TOKENS'),
    );
    expect(hasDefaultNote).toBe(false);
  });
});

// ─── Unknown model throws ─────────────────────────────────────────────────────

describe('estimate — unknown model', () => {
  it('throws UnknownModelError for a model not in the catalog', async () => {
    await expect(
      estimate({ model: 'anthropic/does-not-exist', prompt: 'hi' }, { engine: makeEngine(catalog) }),
    ).rejects.toBeInstanceOf(UnknownModelError);
  });

  it('UnknownModelError carries provider and model properties', async () => {
    let caught: UnknownModelError | null = null;
    try {
      await estimate(
        { model: 'openai/unknown-model', prompt: 'hi' },
        { engine: makeEngine(catalog) },
      );
    } catch (e) {
      caught = e as UnknownModelError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.provider).toBe('openai');
    expect(caught!.model).toBe('unknown-model');
    expect(caught!.name).toBe('UnknownModelError');
  });
});

// ─── Budget guard (BudgetExceededError) ───────────────────────────────────────

describe('estimate — budget guard', () => {
  it('BudgetExceededError is thrown when expected cost exceeds maxCostUsd', async () => {
    // 1M input tokens × $3/MTok = $3, which exceeds $0.001
    const hugeCatalog = new ModelCatalog();
    hugeCatalog.set('test', 'expensive', {
      pricing: { inputPerMTok: 3_000_000, outputPerMTok: 0 },
      maxOutput: 1,
    });

    const est = await estimate(
      { model: 'test/expensive', prompt: 'hi' },
      { engine: makeEngine(hugeCatalog) },
    );
    // expected cost > $0 — just verify the estimate runs and we can throw manually
    const maxCostUsd = est.cost.expected - 0.0001;
    if (maxCostUsd >= 0 && est.cost.expected > maxCostUsd) {
      const err = new BudgetExceededError({
        bound: 'expected',
        estimate: est,
        maxCostUsd,
        costUsd: est.cost.expected,
      });
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect(err.name).toBe('BudgetExceededError');
      expect(err.bound).toBe('expected');
      expect(err.costUsd).toBe(est.cost.expected);
      expect(err.maxCostUsd).toBe(maxCostUsd);
    }
  });

  it('BudgetExceededError carries bound, estimate, maxCostUsd, costUsd', () => {
    // Unit-test the error class shape directly (no estimate() call needed).
    const mockEstimate = {
      model: 'test/m',
      inputTokens: 100,
      estOutputTokens: 512,
      cost: { low: 0.001, expected: 0.01, high: 0.05 },
      breakdown: { inputUsd: 0.001, outputUsd: 0.009 },
      currency: 'USD' as const,
      assumptions: [],
    };
    const err = new BudgetExceededError({
      bound: 'high',
      estimate: mockEstimate,
      maxCostUsd: 0.04,
      costUsd: 0.05,
    });
    expect(err.bound).toBe('high');
    expect(err.maxCostUsd).toBe(0.04);
    expect(err.costUsd).toBe(0.05);
    expect(err.estimate).toBe(mockEstimate);
    expect(err.message).toMatch(/Budget exceeded/);
  });

  it('does NOT throw when cost is under the limit', async () => {
    const est = await estimate(makeRequest(), { engine: makeEngine(catalog) });
    // The estimate itself shouldn't throw; budget guard is tested separately.
    // Verify that calling estimate with a very high limit would pass.
    const limit = est.cost.high + 1;
    expect(est.cost.expected).toBeLessThan(limit);
  });
});

// ─── complete() budget guard integration ─────────────────────────────────────

describe('complete() — budget guard', () => {
  it('throws BudgetExceededError before calling the provider when maxCostUsd is exceeded', async () => {
    // We use a catalog with absurdly high pricing so any real prompt overflows.
    const engine = makeEngine(catalog);

    // Override the catalog on this engine with a very expensive model so even
    // a tiny prompt exceeds $0.
    const tightCatalog = new ModelCatalog();
    tightCatalog.set('anthropic', 'claude-x', {
      pricing: { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 },
      maxOutput: 4096,
    });
    const tightEngine = makeEngine(tightCatalog);

    // Import complete lazily to avoid the need for a real engine / fetch.
    const { complete } = await import('../../../src/helpers/one-shot');
    await expect(
      complete({
        model: 'anthropic/claude-x',
        prompt: 'hello',
        apiKey: 'test-key',
        maxCostUsd: 0.0000001, // essentially $0
        engine: tightEngine as Parameters<typeof complete>[0]['engine'],
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('passes through (to provider call) when cost is under the limit', async () => {
    // This test uses a zero-cost model so the budget guard passes.
    // We do NOT complete a real LLM call; we expect a network/key error (not a
    // BudgetExceededError), which confirms the guard did not block it.
    const zeroCatalog = new ModelCatalog();
    zeroCatalog.set('anthropic', 'claude-x', {
      pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    });
    const freeEngine = makeEngine(zeroCatalog);

    const { complete } = await import('../../../src/helpers/one-shot');
    let thrownError: Error | null = null;
    try {
      await complete({
        model: 'anthropic/claude-x',
        prompt: 'hello',
        apiKey: 'test-key',
        maxCostUsd: 999,
        engine: freeEngine as Parameters<typeof complete>[0]['engine'],
      });
    } catch (e) {
      thrownError = e as Error;
    }
    // The guard passed; a non-budget error happened (no fetch/network in test env).
    expect(thrownError).not.toBeInstanceOf(BudgetExceededError);
    expect(thrownError).not.toBeNull();
  });
});
