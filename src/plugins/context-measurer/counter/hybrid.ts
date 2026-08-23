/** HybridTokenCounter — selects strategy per model based on catalog config. */

import type { Message } from '../../../llm/types/messages';
import type { TokenCountContext, TokenCounter, LearnInput } from '../../../agent/types';
import type { ModelCatalog } from '../../../catalog/catalog';
import type { EngineFetch } from '../../../network/types';
import type { CalibrationStore } from '../types';
import { HeuristicCounter } from './heuristic';
import { TiktokenCounter, isTiktokenUnavailable } from './tiktoken';
import { CountApiCounter, AnthropicCountApi, GoogleCountApi } from './count-api';

export interface HybridCounterConfig {
  catalog?: ModelCatalog;
  calibrationStore?: CalibrationStore;
  countApiKeys?: {
    anthropic?: string;
    google?: string;
  };
  /** Required to use the exact count APIs: they are HTTP calls, and every HTTP
   *  call in this library goes through the engine's fetch. Without it the exact
   *  strategies are unavailable and counting falls back to the heuristic — which
   *  is said out loud rather than done quietly, because a silent downgrade from
   *  exact to estimated is invisible in the only place it matters: the number. */
  fetch?: EngineFetch;
}

/**
 * HybridTokenCounter routes based on catalog's tokenizer.strategy:
 *   'tiktoken'  → TiktokenCounter (exact for OpenAI)
 *   'count_api' → CountApiCounter (exact via provider endpoint for Anthropic/Google)
 *   'heuristic' → HeuristicCounter (calibration-aware fallback)
 */
export class HybridTokenCounter implements TokenCounter {
  private heuristic: HeuristicCounter;
  /** Built on first use, not in the constructor — most consumers never route to the tiktoken
   *  strategy, and the optional peer dependency should not be reached for merely constructing a
   *  counter. See CONSTITUTION.md standing decisions (2026-08-08). */
  private _tiktoken?: TiktokenCounter;
  private countApi: CountApiCounter;
  /** Said once per counter, not once per call. */
  private warnedNoTiktoken = false;
  private readonly _config: HybridCounterConfig;

  constructor(config: HybridCounterConfig) {
    this._config = config;
    this.heuristic = new HeuristicCounter(config.catalog ?? null, config.calibrationStore ?? null);

    const countApis: { anthropic?: AnthropicCountApi; google?: GoogleCountApi } = {};
    const wanted = config.countApiKeys?.anthropic || config.countApiKeys?.google;
    if (wanted && !config.fetch) {
      console.warn(
        '[llm-sdk] HybridTokenCounter: countApiKeys were given without `fetch`, so the exact ' +
          'count APIs are unavailable and counting falls back to the heuristic. Pass engine.fetch.',
      );
    }
    if (config.fetch && config.countApiKeys?.anthropic) {
      countApis.anthropic = new AnthropicCountApi(config.countApiKeys.anthropic, config.fetch);
    }
    if (config.fetch && config.countApiKeys?.google) {
      countApis.google = new GoogleCountApi(config.countApiKeys.google, config.fetch);
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
    return this.withoutOptionalPeer(ctx, (c) => c.measure(text, ctx), () => this.heuristic.measure(text, ctx));
  }

  async measureMessage(msg: Message, ctx?: TokenCountContext): Promise<number> {
    return this.withoutOptionalPeer(
      ctx,
      (c) => c.measureMessage(msg, ctx),
      () => this.heuristic.measureMessage(msg, ctx),
    );
  }

  /** Run the chosen strategy, falling back to the heuristic if — and ONLY if —
   *  the optional `tiktoken` peer is not installed.
   *
   *  The catalog can name `tiktoken` for a model without the consumer having
   *  installed it: it is an optional PEER dependency precisely so that most
   *  people do not carry its 5.6 MB of wasm. Without this, marking OpenAI models
   *  as exactly-countable would turn a number into a thrown error for everyone
   *  who did not opt in — and the guide has always promised the opposite
   *  ("without it everything still works").
   *
   *  Only THAT error is caught. A network failure inside the count API, or a
   *  genuine tokenizer fault, still surfaces: silently answering with an estimate
   *  when an exact count was asked for and was possible is how a wrong number
   *  gets believed. */
  private async withoutOptionalPeer(
    ctx: TokenCountContext | undefined,
    run: (counter: TokenCounter) => Promise<number>,
    fallback: () => Promise<number>,
  ): Promise<number> {
    const counter = this.strategyFor(ctx);
    try {
      return await run(counter);
    } catch (err) {
      if (!isTiktokenUnavailable(err)) throw err;
      if (!this.warnedNoTiktoken) {
        this.warnedNoTiktoken = true;
        console.warn(
          '[llm-sdk] the catalog asks for exact tiktoken counting but the optional peer ' +
            '"tiktoken" is not installed — falling back to the heuristic. Install it (npm i ' +
            'tiktoken) for exact OpenAI counts, or ignore this if an estimate is fine.',
        );
      }
      return fallback();
    }
  }

  learn(input: LearnInput): void {
    this.heuristic.learn(input);
  }

  /** Which strategy a context resolves to, without running it.
   *
   *  Public because a caller has to be able to ASK. `countTokens()` records a
   *  zero-cost ledger entry for a count-API call, and it was deciding that from
   *  the provider and the presence of a key — that is intent, not evidence. It now
   *  asks what actually ran, so the ledger cannot claim a provider call that never
   *  left the process. */
  strategyNameFor(ctx?: TokenCountContext): 'tiktoken' | 'count_api' | 'heuristic' {
    if (!ctx?.provider || !ctx.model || !this._config.catalog) return 'heuristic';
    const strategy = this._config.catalog.get(ctx.provider, ctx.model)?.tokenizer?.strategy;
    return strategy === 'tiktoken' || strategy === 'count_api' ? strategy : 'heuristic';
  }

  private strategyFor(ctx?: TokenCountContext): TokenCounter {
    if (!ctx?.provider || !ctx.model || !this._config.catalog) return this.heuristic;

    const info = this._config.catalog.get(ctx.provider, ctx.model);
    const strategy = info?.tokenizer?.strategy ?? 'heuristic';

    switch (strategy) {
      case 'tiktoken':
        return (this._tiktoken ??= new TiktokenCounter());
      case 'count_api':
        return this.countApi;
      case 'heuristic':
        return this.heuristic;
      default:
        return this.heuristic;
    }
  }
}
