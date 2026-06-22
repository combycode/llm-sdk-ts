/** ContextGuard — stateless engine that routes onContextMeasure events to
 *  per-conversation strategies. */

import type { HookBus } from '../../bus/hook-bus';
import type { ContextMeasureContext } from '../../bus/hook-map';
import type { ConversationHistory } from '../../agent/history';
import type { ContextMeasurer } from '../context-measurer/measurer';
import type {
  ContextGuardConfig,
  ContextStrategy,
  ContextTools,
  ReactContext,
  TriggerLevel,
  UnknownStrategyPolicy,
  GuardConversationState,
} from './types';
import { NoopContextTools } from './types';
import { StrategyToolsImpl } from './tools';

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_CRITICAL_FLOOR = 0.95;
const STATE_KEY = '__orxa';
const GUARD_STATE_SUBKEY = 'contextGuard';

export class ContextGuard {
  private readonly hooks: HookBus;
  private readonly measurer: ContextMeasurer;
  private readonly contextTools: ContextTools;
  private readonly strategies: Record<string, ContextStrategy>;
  private readonly defaultStrategy: string;
  private readonly onUnknownStrategy: UnknownStrategyPolicy;
  private readonly maxRetries: number;
  private readonly criticalFloor: number;

  private readonly triggerCache = new Map<ContextStrategy, TriggerLevel[]>();
  private readonly warnedUnknownStrategies = new Set<string>();

  private unsubscribe: (() => void) | null = null;

  constructor(config: ContextGuardConfig) {
    this.hooks = config.hooks;
    this.measurer = config.measurer;
    this.contextTools = config.contextTools ?? new NoopContextTools();
    this.strategies = config.strategies;
    this.defaultStrategy = config.defaultStrategy;
    this.onUnknownStrategy = config.onUnknownStrategy ?? 'skip';
    this.maxRetries = config.maxCompactRetries ?? DEFAULT_MAX_RETRIES;
    this.criticalFloor = config.criticalFloor ?? DEFAULT_CRITICAL_FLOOR;

    if (!(this.defaultStrategy in this.strategies)) {
      throw new Error(
        `ContextGuard: defaultStrategy "${this.defaultStrategy}" is not in the strategies map (keys: [${Object.keys(this.strategies).join(', ')}])`,
      );
    }

    this.wire();
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private wire(): void {
    this.unsubscribe = this.hooks.on('onContextMeasure', async (ctx) => {
      await this.handleMeasure(ctx);
    });
  }

  private async handleMeasure(ctx: ContextMeasureContext): Promise<void> {
    const history = ctx.history;
    if (!history) return;

    if (ctx.window === null || ctx.percentage === null) return;

    const strategy = this.resolveStrategy(history);
    if (!strategy) return;

    const triggers = this.getSortedTriggers(strategy);
    const state = this.readState(history);

    const crossedIdx = highestCrossedLevel(triggers, ctx.percentage);
    const prevLevelIdx = state.lastLevelIdx;
    const delta = ctx.current - state.lastCurrent;

    const isNewCrossing = crossedIdx > prevLevelIdx;
    const isClimbing = crossedIdx >= 0 && crossedIdx === prevLevelIdx && delta > 0;
    if (!isNewCrossing && !isClimbing) {
      state.lastCurrent = ctx.current;
      state.lastLevelIdx = Math.max(state.lastLevelIdx, crossedIdx);
      this.writeState(history, state);
      return;
    }

    state.lastLevelIdx = crossedIdx;
    state.lastCurrent = ctx.current;
    this.writeState(history, state);

    const strategyName = this.resolveStrategyName(history);
    const strategyState = this.readStrategyState(state, strategyName);

    const tools = new StrategyToolsImpl({
      history,
      activeMessages: ctx.messages,
      counter: this.measurer.counter,
      contextTools: this.contextTools,
      provider: ctx.provider,
      model: ctx.model,
    });

    let attempt = 0;
    let currentPct = ctx.percentage;
    let currentTokens = ctx.current;

    while (attempt <= this.maxRetries) {
      const reactCtx: ReactContext = {
        level: triggers[crossedIdx].level,
        percentage: currentPct,
        current: currentTokens,
        window: ctx.window,
        delta,
        provider: ctx.provider,
        model: ctx.model,
        attempt,
        tools,
        state: strategyState,
      };

      const decision = await strategy.react(reactCtx);
      this.writeStrategyState(history, strategyName, strategyState);

      switch (decision.action) {
        case 'none':
          return;

        case 'warn':
          await this.hooks.emit('onWarning', {
            source: 'context',
            code: 'context_pressure',
            message: decision.message,
            details: {
              conversationId: history.id,
              level: reactCtx.level,
              percentage: currentPct,
              current: currentTokens,
            },
          });
          return;

        case 'decline':
          ctx.abort = true;
          ctx.abortReason = decision.reason;
          await this.hooks.emit('onWarning', {
            source: 'context',
            code: 'context_declined',
            message: `Context declined: ${decision.reason}`,
            details: {
              conversationId: history.id,
              percentage: currentPct,
              current: currentTokens,
            },
          });
          return;

        case 'compacted': {
          currentTokens = tools.measure(ctx.messages);
          currentPct = ctx.window ? currentTokens / ctx.window : 0;
          ctx.current = currentTokens;
          ctx.percentage = currentPct;

          if (currentPct < this.criticalFloor && currentPct < triggers[crossedIdx].at) {
            return;
          }
          attempt++;
          continue;
        }
      }
    }

    ctx.abort = true;
    ctx.abortReason = `Context still at ${(currentPct * 100).toFixed(1)}% after ${this.maxRetries} compaction attempts; unable to fit request.`;
    await this.hooks.emit('onWarning', {
      source: 'context',
      code: 'context_exhausted',
      message: ctx.abortReason,
      details: {
        conversationId: history.id,
        percentage: currentPct,
        current: currentTokens,
        attempts: attempt,
      },
    });
  }

  private resolveStrategy(history: ConversationHistory): ContextStrategy | null {
    const raw = history.metadata.contextStrategy;
    if (raw === false) return null;

    const name = typeof raw === 'string' && raw.length > 0 ? raw : this.defaultStrategy;

    const strategy = this.strategies[name];
    if (strategy) return strategy;

    if (!this.warnedUnknownStrategies.has(name)) {
      this.warnedUnknownStrategies.add(name);
      this.hooks.emitSync('onWarning', {
        source: 'context',
        code: 'context_unknown_strategy',
        message: `ContextGuard: strategy "${name}" is not registered`,
        details: {
          conversationId: history.id,
          strategyName: name,
          available: Object.keys(this.strategies),
          resolution: this.onUnknownStrategy,
        },
      });
    }

    switch (this.onUnknownStrategy) {
      case 'skip':
        return null;
      case 'fallback-default':
        return this.strategies[this.defaultStrategy];
      case 'throw':
        throw new Error(
          `ContextGuard: unknown strategy "${name}" on conversation ${history.id}. Available: [${Object.keys(this.strategies).join(', ')}]`,
        );
    }
  }

  private resolveStrategyName(history: ConversationHistory): string {
    const raw = history.metadata.contextStrategy;
    if (typeof raw === 'string' && raw.length > 0 && raw in this.strategies) {
      return raw;
    }
    return this.defaultStrategy;
  }

  private getSortedTriggers(strategy: ContextStrategy): TriggerLevel[] {
    const cached = this.triggerCache.get(strategy);
    if (cached) return cached;
    const sorted = [...strategy.triggers].sort((a, b) => a.at - b.at);
    this.triggerCache.set(strategy, sorted);
    return sorted;
  }

  private readState(history: ConversationHistory): GuardConversationState {
    const orxa = history.metadata[STATE_KEY] as Record<string, unknown> | undefined;
    const existing = orxa?.[GUARD_STATE_SUBKEY] as GuardConversationState | undefined;
    if (existing && existing.v === 1) {
      return {
        v: 1,
        lastLevelIdx: existing.lastLevelIdx,
        lastCurrent: existing.lastCurrent,
        strategyState: existing.strategyState ? { ...existing.strategyState } : undefined,
      };
    }
    return { v: 1, lastLevelIdx: -1, lastCurrent: 0 };
  }

  private writeState(history: ConversationHistory, state: GuardConversationState): void {
    const md = history.metadata;
    const orxa = (md[STATE_KEY] ?? {}) as Record<string, unknown>;
    orxa[GUARD_STATE_SUBKEY] = state;
    md[STATE_KEY] = orxa;
  }

  private readStrategyState(
    guardState: GuardConversationState,
    strategyName: string,
  ): Record<string, unknown> {
    if (!guardState.strategyState) guardState.strategyState = {};
    if (!guardState.strategyState[strategyName]) {
      guardState.strategyState[strategyName] = {};
    }
    return guardState.strategyState[strategyName];
  }

  private writeStrategyState(
    history: ConversationHistory,
    strategyName: string,
    strategyState: Record<string, unknown>,
  ): void {
    const current = this.readState(history);
    if (!current.strategyState) current.strategyState = {};
    current.strategyState[strategyName] = strategyState;
    this.writeState(history, current);
  }
}

function highestCrossedLevel(triggers: TriggerLevel[], percentage: number): number {
  let idx = -1;
  for (let i = 0; i < triggers.length; i++) {
    if (percentage >= triggers[i].at) idx = i;
    else break;
  }
  return idx;
}
