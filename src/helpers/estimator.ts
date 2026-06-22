/** estimator.ts — Estimator class: static estimate() + optional adaptive
 *  calibration (EWMA mean + histogram p90 per provider/model/input-bucket).
 *
 *  Usage (opt-in calibration):
 *
 *    const estimator = new Estimator({ calibration: { store: 'file', path: './data' } });
 *
 *    // Wire it to the engine so completions are recorded automatically:
 *    const unsub = estimator.subscribeToEngine(engine);
 *
 *    // Use calibrated estimates:
 *    const est = await estimator.estimate({ model: 'anthropic/claude-haiku-4-5', prompt: 'Hi' });
 *    // est.cost.expected uses the EWMA mean (after data accumulates)
 *    // est.cost.high     uses the p90 (capped at model ceiling)
 *    // est.assumptions   records calibration source + count
 *
 *  Calling without calibration config is identical to the free estimate() fn. */

import type { HookBus } from '../bus/hook-bus';
import type { CompletionContext } from '../bus/hook-map';
import { FilePersistence } from '../plugins/persistence/file';
import { MemoryPersistence } from '../plugins/persistence/memory';
import { resolveModel } from './client-resolver';
import { coreRegistry, type EngineHandle } from './engine';
import { estimate } from './estimate';
import type { EstimateRequest } from './estimate';
import { DEFAULT_EXPECTED_OUTPUT_TOKENS, FALLBACK_MAX_OUTPUT_TOKENS } from './estimate-types';
import type { EstimateResult } from './estimate-types';
import { OutputCalibrationStore } from './calibration-store';
import type { EstimatorOptions, CalibrationObservation } from './calibration-types';

// ─── Re-export options ────────────────────────────────────────────────────────

export type { EstimatorOptions } from './calibration-types';

// ─── Estimator class ──────────────────────────────────────────────────────────

export class Estimator {
  private readonly calibrationStore: OutputCalibrationStore | null;

  constructor(opts: EstimatorOptions = {}) {
    this.calibrationStore = opts.calibration
      ? buildCalibrationStore(opts.calibration)
      : null;
  }

  /** Pre-flight cost estimate.  When calibration is enabled AND the key has
   *  data, uses the learned EWMA mean for `expected` and learned p90 (capped)
   *  for `high`.  Otherwise falls back to the exact static estimate() behavior. */
  async estimate(
    request: EstimateRequest,
    opts: import('./estimate').EstimateOptions = {},
  ): Promise<EstimateResult> {
    const base = await estimate(request, opts);

    if (!this.calibrationStore) {
      return base;
    }

    return this.applyCalibratedBounds(request, base, opts);
  }

  /** Record one completion observation into the calibration store.
   *  This is the manual "feed" path; subscribeToEngine() wires it automatically. */
  async record(obs: CalibrationObservation): Promise<void> {
    if (!this.calibrationStore) return;
    await this.calibrationStore.record(obs);
  }

  /** Subscribe to an engine's onCompletion hook so every real completion
   *  automatically updates the calibration store.
   *  Returns an unsubscribe function. */
  subscribeToEngine(engine: EngineHandle): () => void {
    return subscribeHooks(engine.hooks, this);
  }

  /** Subscribe directly to a HookBus (for advanced wiring). */
  subscribeToHooks(hooks: HookBus): () => void {
    return subscribeHooks(hooks, this);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async applyCalibratedBounds(
    request: EstimateRequest,
    base: EstimateResult,
    opts: import('./estimate').EstimateOptions,
  ): Promise<EstimateResult> {
    const modelStr = opts.model ?? request.model;
    const { provider, model } = resolveModel(modelStr, request.provider, 'estimator');

    const engine = opts.engine ?? coreRegistry.get();
    const catalogEntry = engine.catalog.get(provider, model);
    const hardCeiling = request.maxTokens ?? catalogEntry?.maxOutput ?? FALLBACK_MAX_OUTPUT_TOKENS;

    const entry = await this.calibrationStore!.get(provider, model, base.inputTokens);
    if (!entry) {
      return base;
    }

    const pricing = engine.catalog.getPricing(provider, model);
    if (!pricing) {
      return base;
    }

    const outputRate = pricing.outputPerMTok ?? 0;
    const inputUsd = base.breakdown.inputUsd;
    const mediaUsd = (base.breakdown.imageUsd ?? 0) + (base.breakdown.audioUsd ?? 0);

    const calibratedExpectedTokens = Math.round(entry.ewmaMean);
    const rawP90Tokens = Math.round(this.calibrationStore!.p90(entry));
    // high = p90 capped at ceiling, but never less than expected (preserves low<=expected<=high)
    const calibratedHighTokens = Math.min(
      Math.max(rawP90Tokens, calibratedExpectedTokens),
      hardCeiling,
    );

    const calibratedExpectedUsd =
      inputUsd + mediaUsd + (calibratedExpectedTokens / 1_000_000) * outputRate;
    const calibratedHighUsd =
      inputUsd + mediaUsd + (calibratedHighTokens / 1_000_000) * outputRate;

    const assumptions = [
      ...base.assumptions,
      `calibrated: expected from ${entry.count} samples (${model}#${bucketFromEntry(entry.key)})`,
    ];

    return {
      ...base,
      estOutputTokens: calibratedExpectedTokens,
      cost: {
        low: base.cost.low,
        expected: calibratedExpectedUsd,
        high: calibratedHighUsd,
      },
      breakdown: {
        ...base.breakdown,
        outputUsd: calibratedExpectedUsd - inputUsd - mediaUsd,
      },
      assumptions,
    };
  }
}

// ─── Hook subscription ────────────────────────────────────────────────────────

function subscribeHooks(hooks: HookBus, estimator: Estimator): () => void {
  const handler = (ctx: CompletionContext) => {
    const inputTokens =
      ctx.response.usage.inputTokens || ctx.request.estimatedInputTokens;
    const outputTokens = ctx.response.usage.outputTokens;
    if (outputTokens <= 0) return;

    const obs: CalibrationObservation = {
      provider: ctx.provider,
      model: ctx.model,
      inputTokens,
      outputTokens,
    };
    void estimator.record(obs);
  };
  return hooks.on('onCompletion', handler);
}

// ─── Persistence factory ──────────────────────────────────────────────────────

function buildCalibrationStore(
  config: import('./calibration-types').CalibrationStoreConfig,
): OutputCalibrationStore {
  if (config.store === 'file') {
    if (!config.path) {
      throw new Error(
        'Estimator calibration: store="file" requires a path. ' +
          'Pass { store: "file", path: "./calibration-data" }.',
      );
    }
    return new OutputCalibrationStore(new FilePersistence(config.path));
  }
  return new OutputCalibrationStore(new MemoryPersistence());
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

function bucketFromEntry(key: string): string {
  const hashIdx = key.lastIndexOf('#');
  return hashIdx >= 0 ? key.slice(hashIdx + 1) : key;
}

/** Compute and record a CalibrationObservation from raw CompletionContext fields.
 *  Exported so tests can call it without a full engine wiring. */
export function observationFromCompletion(ctx: CompletionContext): CalibrationObservation {
  return {
    provider: ctx.provider,
    model: ctx.model,
    inputTokens: ctx.response.usage.inputTokens || ctx.request.estimatedInputTokens,
    outputTokens: ctx.response.usage.outputTokens,
  };
}

/** Default_expected fallback re-exported for callers who import from Estimator. */
export { DEFAULT_EXPECTED_OUTPUT_TOKENS };
