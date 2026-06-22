/** HybridTokenCounter — selects strategy per model based on catalog config. */

import type { Message } from '../../../llm/types/messages';
import type { TokenCountContext, TokenCounter, LearnInput } from '../../../agent/types';
import type { ModelCatalog } from '../../model-catalog/catalog';
import type { CalibrationStore } from '../types';
import { HeuristicCounter } from './heuristic';
import { TiktokenCounter } from './tiktoken';
import { CountApiCounter, AnthropicCountApi, GoogleCountApi } from './count-api';

export interface HybridCounterConfig {
  catalog?: ModelCatalog;
  calibrationStore?: CalibrationStore;
  countApiKeys?: {
    anthropic?: string;
    google?: string;
  };
}

/**
 * HybridTokenCounter routes based on catalog's tokenizer.strategy:
 *   'tiktoken'  → TiktokenCounter (exact for OpenAI)
 *   'count_api' → CountApiCounter (exact via provider endpoint for Anthropic/Google)
 *   'heuristic' → HeuristicCounter (calibration-aware fallback)
 */
export class HybridTokenCounter implements TokenCounter {
  private heuristic: HeuristicCounter;
  private tiktoken: TiktokenCounter;
  private countApi: CountApiCounter;
  private readonly _config: HybridCounterConfig;

  constructor(config: HybridCounterConfig) {
    this._config = config;
    this.heuristic = new HeuristicCounter(config.catalog ?? null, config.calibrationStore ?? null);
    this.tiktoken = new TiktokenCounter();

    const countApis: { anthropic?: AnthropicCountApi; google?: GoogleCountApi } = {};
    if (config.countApiKeys?.anthropic) {
      countApis.anthropic = new AnthropicCountApi(config.countApiKeys.anthropic);
    }
    if (config.countApiKeys?.google) {
      countApis.google = new GoogleCountApi(config.countApiKeys.google);
    }
    this.countApi = new CountApiCounter(config.catalog ?? null, countApis);
  }

  async warmCache(): Promise<void> {
    await this.heuristic.warmCache();
  }

  estimate(text: string, ctx?: TokenCountContext): number {
    return this.strategyFor(ctx).estimate(text, ctx);
  }

  estimateMessage(msg: Message, ctx?: TokenCountContext): number {
    return this.strategyFor(ctx).estimateMessage(msg, ctx);
  }

  async measure(text: string, ctx?: TokenCountContext): Promise<number> {
    return this.strategyFor(ctx).measure(text, ctx);
  }

  async measureMessage(msg: Message, ctx?: TokenCountContext): Promise<number> {
    return this.strategyFor(ctx).measureMessage(msg, ctx);
  }

  learn(input: LearnInput): void {
    this.heuristic.learn(input);
  }

  private strategyFor(ctx?: TokenCountContext): TokenCounter {
    if (!ctx?.provider || !ctx.model || !this._config.catalog) return this.heuristic;

    const info = this._config.catalog.get(ctx.provider, ctx.model);
    const strategy = info?.tokenizer?.strategy ?? 'heuristic';

    switch (strategy) {
      case 'tiktoken':
        return this.tiktoken;
      case 'count_api':
        return this.countApi;
      case 'heuristic':
        return this.heuristic;
      default:
        return this.heuristic;
    }
  }
}
