/** ContextMeasurer — auto-wires measurement + calibration learning.
 *  Pattern matches CostCollector / FilesRegistry: instantiate → hooks attach. */

import type { HookBus } from '../../bus/hook-bus';
import type { Message } from '../../llm/types/messages';
import type { TokenCounter } from '../../agent/types';
import type { ConversationHistory } from '../../agent/history';
import type { ModelCatalog } from '../model-catalog/catalog';
import type { Persistence } from '../persistence/types';
import type { CalibrationStore, ContextThresholds, CalibrationConfig } from './types';
import { CONTEXT_DEFAULTS } from './types';
import { PersistenceCalibrationStore } from './calibration/store';
import { HybridTokenCounter } from './counter/hybrid';

export interface ContextMeasurerConfig {
  hooks: HookBus;
  catalog: ModelCatalog;

  /** Use an explicit counter, else a HybridTokenCounter is built from catalog. */
  counter?: TokenCounter;

  /** Persistence for calibration. If absent, no calibration learning occurs. */
  persistence?: Persistence;

  /** Explicit calibration store (overrides persistence). */
  calibrationStore?: CalibrationStore;

  /** API keys for exact counting endpoints. */
  countApiKeys?: { anthropic?: string; google?: string };

  /** Thresholds for warning/exact escalation. */
  thresholds?: Partial<ContextThresholds>;

  /** Calibration tuning (EMA alpha, confidence samples). */
  calibration?: Partial<CalibrationConfig>;
}

export class ContextMeasurer {
  readonly counter: TokenCounter;
  readonly calibrationStore: CalibrationStore | null;
  readonly thresholds: ContextThresholds;

  private hooks: HookBus;
  private catalog: ModelCatalog;
  private unsubscribers: Array<() => void> = [];

  constructor(config: ContextMeasurerConfig) {
    this.hooks = config.hooks;
    this.catalog = config.catalog;

    if (config.calibrationStore) {
      this.calibrationStore = config.calibrationStore;
    } else if (config.persistence) {
      this.calibrationStore = new PersistenceCalibrationStore(
        config.persistence,
        config.calibration,
      );
    } else {
      this.calibrationStore = null;
    }

    this.counter =
      config.counter ??
      new HybridTokenCounter({
        catalog: this.catalog,
        calibrationStore: this.calibrationStore ?? undefined,
        countApiKeys: config.countApiKeys,
      });

    this.thresholds = { ...CONTEXT_DEFAULTS.thresholds, ...config.thresholds };

    this.wire();
  }

  private wire(): void {
    this.unsubscribers.push(
      this.hooks.on('onCompletion', (ctx) => {
        this.learnFromCompletion(ctx);
      }),
    );

    this.unsubscribers.push(
      this.hooks.on('onMessageResolve', async (ctx) => {
        const result = await this.measureAndEmit(
          ctx.provider,
          ctx.model,
          ctx.messages,
          ctx.history,
          ctx.system,
        );
        if (result.abort) {
          ctx.abort = true;
          if (result.abortReason !== undefined) ctx.abortReason = result.abortReason;
        }
      }),
    );
  }

  destroy(): void {
    for (const un of this.unsubscribers) un();
    this.unsubscribers = [];
  }

  /** Pre-warm calibration cache on startup. */
  async warmCache(): Promise<void> {
    if (this.counter instanceof HybridTokenCounter) {
      await this.counter.warmCache();
    }
  }

  /** Measure + emit onContextMeasure. Returns final state including any abort
   *  set by listeners (ContextGuard may set it). */
  async measureAndEmit(
    provider: string,
    model: string,
    messages: Message[],
    history?: ConversationHistory,
    system?: string,
  ): Promise<{ total: number; abort: boolean; abortReason?: string }> {
    let total = 0;
    if (system && system.length > 0) {
      total += this.counter.estimate(system, { provider, model });
    }
    for (const msg of messages) {
      total += this.counter.estimateMessage(msg, { provider, model });
    }

    const window = this.catalog.get(provider, model)?.contextWindow ?? null;
    const percentage = window ? total / window : null;

    let accuracy: 'fast' | 'exact' = 'fast';
    if (percentage !== null && percentage >= this.thresholds.exact) {
      try {
        let exactTotal = 0;
        if (system && system.length > 0) {
          exactTotal += await this.counter.measure(system, { provider, model, accuracy: 'exact' });
        }
        for (const msg of messages) {
          exactTotal += await this.counter.measureMessage(msg, {
            provider,
            model,
            accuracy: 'exact',
          });
        }
        total = exactTotal;
        accuracy = 'exact';
      } catch {
        // Stick with fast estimate
      }
    }

    const ctx = {
      provider,
      model,
      current: total,
      window,
      percentage: window ? total / window : null,
      accuracy,
      messages,
      system,
      history,
      abort: undefined as boolean | undefined,
      abortReason: undefined as string | undefined,
    };

    await this.hooks.emit('onContextMeasure', ctx);

    let finalTotal = ctx.current;
    if (!ctx.abort) {
      finalTotal = 0;
      if (system && system.length > 0) {
        finalTotal += this.counter.estimate(system, { provider, model });
      }
      for (const msg of messages) {
        finalTotal += this.counter.estimateMessage(msg, { provider, model });
      }
    }

    return {
      total: finalTotal,
      abort: ctx.abort === true,
      abortReason: ctx.abortReason,
    };
  }

  private learnFromCompletion(ctx: {
    provider: string;
    model: string;
    response: { usage: { inputTokens: number } };
    request: { inputChars: number };
  }): void {
    if (!this.calibrationStore) return;
    if (ctx.response.usage.inputTokens <= 0) return;
    if (!ctx.request.inputChars || ctx.request.inputChars <= 0) return;

    this.counter.learn({
      provider: ctx.provider,
      model: ctx.model,
      bytesSent: ctx.request.inputChars,
      actualTokens: ctx.response.usage.inputTokens,
      timestamp: Date.now(),
    });
  }
}
