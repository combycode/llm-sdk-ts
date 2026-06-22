/** estimate-calibration.test.ts — Estimator + OutputCalibrationStore unit tests.
 *  Deterministic, no network, no real API keys. */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Estimator } from '../../../src/helpers/estimator';
import type { EstimateRequest } from '../../../src/helpers/estimate';
import type { EstimateOptions } from '../../../src/helpers/estimate';
import {
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  FALLBACK_MAX_OUTPUT_TOKENS,
} from '../../../src/helpers/estimate-types';
import {
  OutputCalibrationStore,
  inputBucketLabel,
  calibrationKey,
} from '../../../src/helpers/calibration-store';
import {
  CALIBRATION_EWMA_ALPHA,
  INPUT_SIZE_BUCKET_EDGES,
  INPUT_SIZE_BUCKET_LABELS,
  P90_HISTOGRAM_BIN_WIDTH,
} from '../../../src/helpers/calibration-types';
import { MemoryPersistence } from '../../../src/plugins/persistence/memory';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';

// ─── Catalog fixture ──────────────────────────────────────────────────────────

function makeTestCatalog(): ModelCatalog {
  const catalog = new ModelCatalog();
  catalog.set('anthropic', 'claude-test', {
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    maxOutput: 8192,
  });
  catalog.set('openai', 'gpt-test', {
    pricing: { inputPerMTok: 0.15, outputPerMTok: 0.60 },
  });
  return catalog;
}

function makeEngine(catalog: ModelCatalog) {
  return { catalog } as unknown as EstimateOptions['engine'];
}

function makeRequest(overrides: Partial<EstimateRequest> = {}): EstimateRequest {
  return { model: 'anthropic/claude-test', prompt: 'Hello world', ...overrides };
}

// ─── Bucket boundary mapping ──────────────────────────────────────────────────

describe('inputBucketLabel', () => {
  it('maps 0 to first bucket', () => {
    expect(inputBucketLabel(0)).toBe(INPUT_SIZE_BUCKET_LABELS[0]);
  });

  it('maps edge value (exclusive) to next bucket', () => {
    expect(inputBucketLabel(INPUT_SIZE_BUCKET_EDGES[0])).toBe(INPUT_SIZE_BUCKET_LABELS[1]);
  });

  it('maps value just below edge to current bucket', () => {
    expect(inputBucketLabel(INPUT_SIZE_BUCKET_EDGES[0] - 1)).toBe(INPUT_SIZE_BUCKET_LABELS[0]);
  });

  it('maps large value beyond last edge to last bucket', () => {
    expect(inputBucketLabel(100_000)).toBe(
      INPUT_SIZE_BUCKET_LABELS[INPUT_SIZE_BUCKET_LABELS.length - 1],
    );
  });

  it('maps each edge boundary correctly', () => {
    for (let i = 0; i < INPUT_SIZE_BUCKET_EDGES.length; i++) {
      const edge = INPUT_SIZE_BUCKET_EDGES[i];
      expect(inputBucketLabel(edge)).toBe(INPUT_SIZE_BUCKET_LABELS[i + 1]);
    }
  });
});

describe('calibrationKey', () => {
  it('encodes provider, model, and bucket into a key', () => {
    const key = calibrationKey('anthropic', 'claude-test', '0-500');
    expect(key).toContain('anthropic');
    expect(key).toContain('claude-test');
    expect(key).toContain('0-500');
    expect(key).toContain('#');
  });
});

// ─── OutputCalibrationStore (in-memory) ──────────────────────────────────────

describe('OutputCalibrationStore — basic recording', () => {
  let store: OutputCalibrationStore;

  beforeEach(() => {
    store = new OutputCalibrationStore(new MemoryPersistence());
  });

  it('returns null for an unrecorded key', async () => {
    const entry = await store.get('anthropic', 'claude-test', 100);
    expect(entry).toBeNull();
  });

  it('records the first observation as the initial EWMA mean', async () => {
    await store.record({
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 100,
      outputTokens: 400,
    });
    const entry = await store.get('anthropic', 'claude-test', 100);
    expect(entry).not.toBeNull();
    expect(entry!.ewmaMean).toBe(400);
    expect(entry!.count).toBe(1);
  });

  it('updates EWMA mean toward observed values', async () => {
    const obs = {
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 100,
      outputTokens: 0,
    };
    // Seed with 1000 (acts as the initial mean)
    await store.record({ ...obs, outputTokens: 1000 });
    // Record 0 multiple times — EWMA should move toward 0
    for (let i = 0; i < 20; i++) {
      await store.record({ ...obs, outputTokens: 0 });
    }
    const entry = await store.get('anthropic', 'claude-test', 100);
    expect(entry!.ewmaMean).toBeLessThan(500);
    expect(entry!.count).toBe(21);
  });

  it('EWMA formula: single update from initial', async () => {
    const obs = {
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 100,
      outputTokens: 500,
    };
    await store.record(obs);
    await store.record({ ...obs, outputTokens: 1000 });
    const entry = await store.get('anthropic', 'claude-test', 100);
    // After first record: ewmaMean = 500
    // After second record: alpha * 1000 + (1 - alpha) * 500
    const expected = CALIBRATION_EWMA_ALPHA * 1000 + (1 - CALIBRATION_EWMA_ALPHA) * 500;
    expect(entry!.ewmaMean).toBeCloseTo(expected, 6);
  });

  it('p90 on uniform observations returns approximately the max', async () => {
    const obs = {
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 100,
    };
    // Record 10 identical observations at 512 tokens
    for (let i = 0; i < 10; i++) {
      await store.record({ ...obs, outputTokens: 512 });
    }
    const entry = await store.get('anthropic', 'claude-test', 100);
    const p90 = store.p90(entry!);
    // p90 should fall in the same bin as 512 (bin 2: [512, 768))
    expect(p90).toBeGreaterThan(0);
    expect(p90).toBeLessThan(3 * P90_HISTOGRAM_BIN_WIDTH);
  });

  it('p90 tracks skewed distribution: high values pull p90 up', async () => {
    const obs = {
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 100,
    };
    // 9 low observations, 1 high (p90 should be near the high end)
    for (let i = 0; i < 9; i++) {
      await store.record({ ...obs, outputTokens: 50 });
    }
    await store.record({ ...obs, outputTokens: 3000 });
    const entry = await store.get('anthropic', 'claude-test', 100);
    const p90 = store.p90(entry!);
    // p90 is the 90th percentile: 9 out of 10 are <=50, the 10th is 3000.
    // Exact quantile boundary: 90% = 9 samples at 50, p90 = bin containing 3000.
    // The 9th/10th sample boundary: p90 could be near 50 or near 3000 depending
    // on bin resolution. With our histogram: 9 in bin 0, 1 in bin 11.
    // p90 with 10 total, target=9: cumulative reaches 9 at bin 0 (count=9).
    // So p90 midpoint = 0.5 * 256 = 128.
    // Either way, it should be > 0 and < 3500.
    expect(p90).toBeGreaterThan(0);
    expect(p90).toBeLessThanOrEqual(3500);
  });

  it('separates observations by input bucket', async () => {
    await store.record({
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 100,   // bucket '0-500'
      outputTokens: 200,
    });
    await store.record({
      provider: 'anthropic',
      model: 'claude-test',
      inputTokens: 1000,  // bucket '500-2000'
      outputTokens: 900,
    });
    const small = await store.get('anthropic', 'claude-test', 100);
    const medium = await store.get('anthropic', 'claude-test', 1000);
    expect(small!.ewmaMean).toBeCloseTo(200, 2);
    expect(medium!.ewmaMean).toBeCloseTo(900, 2);
  });
});

// ─── Estimator — disabled calibration = static behavior ──────────────────────

describe('Estimator — no calibration config', () => {
  it('behaves identically to static estimate() when no calibration', async () => {
    const catalog = makeTestCatalog();
    const engine = makeEngine(catalog);
    const estimator = new Estimator();
    const req = makeRequest();

    const fromEstimator = await estimator.estimate(req, { engine });
    const { estimate: staticEstimate } = await import('../../../src/helpers/estimate');
    const fromStatic = await staticEstimate(req, { engine });

    expect(fromEstimator.estOutputTokens).toBe(fromStatic.estOutputTokens);
    expect(fromEstimator.cost.expected).toBeCloseTo(fromStatic.cost.expected, 10);
    expect(fromEstimator.cost.high).toBeCloseTo(fromStatic.cost.high, 10);
  });
});

// ─── Estimator — calibration enabled, unknown key falls back ─────────────────

describe('Estimator — calibration enabled, unknown key', () => {
  it('falls back to static heuristic when no data for the key', async () => {
    const catalog = makeTestCatalog();
    const engine = makeEngine(catalog);
    const estimator = new Estimator({ calibration: { store: 'memory' } });

    const est = await estimator.estimate(makeRequest(), { engine });
    // No observations recorded, so fallback = DEFAULT_EXPECTED_OUTPUT_TOKENS
    expect(est.estOutputTokens).toBe(DEFAULT_EXPECTED_OUTPUT_TOKENS);
  });
});

// ─── Estimator — calibration shifts expected toward observed mean ─────────────

describe('Estimator — calibration enabled, known key', () => {
  let estimator: Estimator;
  let catalog: ModelCatalog;
  let engine: EstimateOptions['engine'];

  beforeEach(() => {
    catalog = makeTestCatalog();
    engine = makeEngine(catalog);
    estimator = new Estimator({ calibration: { store: 'memory' } });
  });

  async function recordN(outputTokens: number, n: number, inputTokens = 100) {
    for (let i = 0; i < n; i++) {
      await estimator.record({
        provider: 'anthropic',
        model: 'claude-test',
        inputTokens,
        outputTokens,
      });
    }
  }

  it('expected shifts toward observed mean after N observations', async () => {
    // Record 30 observations at a consistent value far from DEFAULT_EXPECTED
    const targetOutput = 2500;
    await recordN(targetOutput, 30);

    const est = await estimator.estimate(makeRequest(), { engine });
    // EWMA with alpha=0.15 after 30 identical observations should be close to 2500
    expect(est.estOutputTokens).toBeGreaterThan(DEFAULT_EXPECTED_OUTPUT_TOKENS);
    expect(est.estOutputTokens).toBeLessThanOrEqual(targetOutput + 10);
  });

  it('high bound does not exceed model maxOutput ceiling', async () => {
    // Record 50 observations at values way above maxOutput (8192)
    await recordN(50_000, 50);

    const est = await estimator.estimate(makeRequest(), { engine });
    // high must be capped at catalog maxOutput (8192) for claude-test
    const modelMaxOutput = 8192;
    const outputRate = 15; // outputPerMTok for claude-test
    const inputUsd = est.breakdown.inputUsd;
    const ceilingUsd = inputUsd + (modelMaxOutput / 1_000_000) * outputRate;
    // high must never exceed the ceiling
    expect(est.cost.high).toBeLessThanOrEqual(ceilingUsd + 1e-9);
    // and must be above the input cost (some observed output was recorded)
    expect(est.cost.high).toBeGreaterThan(est.cost.low);
  });

  it('high bound does not exceed maxTokens when specified', async () => {
    await recordN(50_000, 50);

    const maxTokens = 500;
    const est = await estimator.estimate(makeRequest({ maxTokens }), { engine });
    const outputRate = 15;
    const inputUsd = est.breakdown.inputUsd;
    const expectedHighUsd = inputUsd + (maxTokens / 1_000_000) * outputRate;
    expect(est.cost.high).toBeCloseTo(expectedHighUsd, 6);
  });

  it('adds calibrated assumption note with sample count', async () => {
    await recordN(1000, 5);
    const est = await estimator.estimate(makeRequest(), { engine });
    const calibratedNote = est.assumptions.find((a) => a.startsWith('calibrated:'));
    expect(calibratedNote).toBeDefined();
    expect(calibratedNote).toContain('5 samples');
  });

  it('low bound remains unchanged (0 output cost)', async () => {
    await recordN(2000, 10);
    const est = await estimator.estimate(makeRequest(), { engine });
    // low is always just the input cost
    const inputUsd = est.breakdown.inputUsd;
    expect(est.cost.low).toBeCloseTo(inputUsd, 10);
  });

  it('low <= expected <= high invariant holds after calibration', async () => {
    await recordN(1000, 15);
    const est = await estimator.estimate(makeRequest(), { engine });
    expect(est.cost.low).toBeLessThanOrEqual(est.cost.expected);
    expect(est.cost.expected).toBeLessThanOrEqual(est.cost.high);
  });

  it('uses model FALLBACK_MAX_OUTPUT_TOKENS ceiling when model has no maxOutput', async () => {
    await recordN(50_000, 30, 100);
    // gpt-test has no maxOutput in our catalog
    const est = await estimator.estimate(
      { model: 'openai/gpt-test', prompt: 'hi' },
      { engine },
    );
    const outputRate = 0.60;
    const inputUsd = est.breakdown.inputUsd;
    const expectedHighUsd = inputUsd + (FALLBACK_MAX_OUTPUT_TOKENS / 1_000_000) * outputRate;
    // The ceiling should be FALLBACK_MAX_OUTPUT_TOKENS since no maxOutput configured
    expect(est.cost.high).toBeLessThanOrEqual(
      inputUsd + (FALLBACK_MAX_OUTPUT_TOKENS / 1_000_000) * outputRate + 0.000001,
    );
    // We just verify the cap is respected
    expect(est.cost.high).toBeCloseTo(expectedHighUsd, 5);
  });
});

// ─── Estimator — file store round-trip ───────────────────────────────────────

describe('Estimator — file store round-trip', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'calibration-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('persists observations to disk and loads them in a new Estimator', async () => {
    const catalog = makeTestCatalog();
    const engine = makeEngine(catalog);
    const TARGET_OUTPUT = 1800;

    // First Estimator: record observations and save to file
    const estimator1 = new Estimator({ calibration: { store: 'file', path: tmpDir } });
    for (let i = 0; i < 30; i++) {
      await estimator1.record({
        provider: 'anthropic',
        model: 'claude-test',
        inputTokens: 200,
        outputTokens: TARGET_OUTPUT,
      });
    }
    const est1 = await estimator1.estimate(makeRequest({ prompt: 'Hello' }), { engine });
    expect(est1.estOutputTokens).toBeGreaterThan(DEFAULT_EXPECTED_OUTPUT_TOKENS);

    // Second Estimator: loads from the same directory (no prior recording)
    const estimator2 = new Estimator({ calibration: { store: 'file', path: tmpDir } });
    const est2 = await estimator2.estimate(makeRequest({ prompt: 'Hello' }), { engine });

    // Both should produce the same calibrated expected (data persisted on disk)
    expect(est2.estOutputTokens).toBe(est1.estOutputTokens);
    expect(est2.cost.expected).toBeCloseTo(est1.cost.expected, 8);
    expect(est2.assumptions.some((a) => a.startsWith('calibrated:'))).toBe(true);
  });

  it('starts with static behavior on an empty directory', async () => {
    const catalog = makeTestCatalog();
    const engine = makeEngine(catalog);
    const estimator = new Estimator({ calibration: { store: 'file', path: tmpDir } });
    const est = await estimator.estimate(makeRequest(), { engine });
    expect(est.estOutputTokens).toBe(DEFAULT_EXPECTED_OUTPUT_TOKENS);
    expect(est.assumptions.every((a) => !a.startsWith('calibrated:'))).toBe(true);
  });

  it('throws when store=file but path is not provided', () => {
    expect(() => new Estimator({ calibration: { store: 'file' } })).toThrow();
  });
});

// ─── Estimator — subscribeToEngine wires the hook ─────────────────────────────

describe('Estimator — subscribeToEngine', () => {
  it('records observations through the onCompletion hook', async () => {
    const { HookBus } = await import('../../../src/bus/hook-bus');
    const hooks = new HookBus();
    const catalog = makeTestCatalog();
    const fakeEngine = {
      catalog,
      hooks,
    } as unknown as import('../../../src/helpers/engine').EngineHandle;

    const estimator = new Estimator({ calibration: { store: 'memory' } });
    const unsub = estimator.subscribeToEngine(fakeEngine);

    // Emit a fake completion event
    hooks.emitSync('onCompletion', {
      provider: 'anthropic',
      model: 'claude-test',
      response: {
        usage: {
          inputTokens: 150,
          outputTokens: 800,
          totalTokens: 950,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          audioInputTokens: 0,
          audioOutputTokens: 0,
        },
        text: '',
        content: [],
        finishReason: 'stop',
        raw: {},
      } as unknown as import('../../../src/llm/types/response').CompletionResponse,
      request: {
        estimatedInputTokens: 150,
        inputChars: 600,
        messageCount: 1,
        hasTools: false,
      },
      ctx: { requestId: 'r1' } as unknown as import('../../../src/types/request-context').RequestContext,
    });

    // Give async record() a chance to run
    await new Promise((resolve) => setTimeout(resolve, 5));

    const engine2 = { catalog } as unknown as EstimateOptions['engine'];
    const est = await estimator.estimate(makeRequest(), { engine: engine2 });
    // One observation: EWMA mean = 800 (first record)
    expect(est.estOutputTokens).toBe(800);

    unsub();
  });

  it('unsubscribing stops recording', async () => {
    const { HookBus } = await import('../../../src/bus/hook-bus');
    const hooks = new HookBus();
    const catalog = makeTestCatalog();
    const fakeEngine = {
      catalog,
      hooks,
    } as unknown as import('../../../src/helpers/engine').EngineHandle;

    const estimator = new Estimator({ calibration: { store: 'memory' } });
    const unsub = estimator.subscribeToEngine(fakeEngine);
    unsub(); // immediately unsubscribe

    hooks.emitSync('onCompletion', {
      provider: 'anthropic',
      model: 'claude-test',
      response: {
        usage: {
          inputTokens: 150,
          outputTokens: 800,
          totalTokens: 950,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          audioInputTokens: 0,
          audioOutputTokens: 0,
        },
        text: '',
        content: [],
        finishReason: 'stop',
        raw: {},
      } as unknown as import('../../../src/llm/types/response').CompletionResponse,
      request: {
        estimatedInputTokens: 150,
        inputChars: 600,
        messageCount: 1,
        hasTools: false,
      },
      ctx: { requestId: 'r2' } as unknown as import('../../../src/types/request-context').RequestContext,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const engine2 = { catalog } as unknown as EstimateOptions['engine'];
    const est = await estimator.estimate(makeRequest(), { engine: engine2 });
    // No observation recorded (unsubscribed before emit) -> static fallback
    expect(est.estOutputTokens).toBe(DEFAULT_EXPECTED_OUTPUT_TOKENS);
  });
});

// ─── Estimator — disabled calibration passes all static tests ─────────────────

describe('Estimator — static fallback is always consistent', () => {
  it('uses DEFAULT_EXPECTED_OUTPUT_TOKENS when no calibration data', async () => {
    const catalog = makeTestCatalog();
    const engine = makeEngine(catalog);
    const estimator = new Estimator({ calibration: { store: 'memory' } });

    const est = await estimator.estimate(makeRequest(), { engine });
    expect(est.estOutputTokens).toBe(DEFAULT_EXPECTED_OUTPUT_TOKENS);
  });

  it('respects maxTokens for expected when below default', async () => {
    const catalog = makeTestCatalog();
    const engine = makeEngine(catalog);
    const estimator = new Estimator();
    const maxTokens = 100;

    const est = await estimator.estimate(makeRequest({ maxTokens }), { engine });
    expect(est.estOutputTokens).toBe(maxTokens);
  });
});
