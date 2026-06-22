/** CostCollector — listens to onCompletion, computes cost from ModelCatalog
 *  pricing or provider-reported totals, emits onCostEntry/onBudgetWarning/
 *  onBudgetExceeded. */

import type { HookBus } from '../../bus/hook-bus';
import type {
  BudgetExceededContext,
  BudgetWarningContext,
  CompletionContext,
  CostEntry,
} from '../../bus/hook-map';
import type { ModelCatalog } from '../model-catalog/catalog';
import {
  applyFilter,
  calculateCost,
  computeCost,
  extractProviderCost,
  matchesScope,
  summarize,
} from './cost-collector-internal';
import type { Budget, CostCollectorConfig, CostFilter, CostSummary } from './cost-collector-types';

export class CostCollector {
  private ledger: CostEntry[] = [];
  private hooks: HookBus;
  private catalog: ModelCatalog;
  private sessionId?: string;
  private defaultTags: Record<string, string>;
  private budgets: Budget[] = [];
  private triggeredThresholds = new Map<string, Set<number>>();
  private _runningTotal = 0;
  private watchedAgents = new Set<{ stop(): void }>();
  private unsub: (() => void) | null = null;

  private unsubMedia: (() => void) | null = null;

  constructor(config: CostCollectorConfig) {
    this.hooks = config.hooks;
    this.catalog = config.catalog;
    this.sessionId = config.sessionId;
    this.defaultTags = config.defaultTags ?? {};

    this.unsub = this.hooks.on('onCompletion', (ctx) => {
      this.handleCompletion(ctx);
    });
    this.unsubMedia = this.hooks.on('onMediaGenerated', (ctx) => {
      this.handleMediaGenerated(ctx);
    });
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
    this.unsubMedia?.();
    this.unsubMedia = null;
  }

  // ─── Budget ───────────────────────────────────────────────────────────

  addBudget(budget: Budget): void {
    this.budgets.push(budget);
    this.triggeredThresholds.set(budget.id, new Set());
  }

  removeBudget(id: string): void {
    this.budgets = this.budgets.filter((b) => b.id !== id);
    this.triggeredThresholds.delete(id);
  }

  watchAgent(agent: { stop(): void }): void {
    this.watchedAgents.add(agent);
  }

  setTag(key: string, value: string): void {
    this.defaultTags[key] = value;
  }

  // ─── Queries ──────────────────────────────────────────────────────────

  total(filter?: CostFilter): CostSummary {
    return summarize(this.filterEntries(filter));
  }

  byProvider(filter?: CostFilter): Record<string, CostSummary> {
    return this.groupBy('provider', filter);
  }

  byModel(filter?: CostFilter): Record<string, CostSummary> {
    const entries = this.filterEntries(filter);
    const groups: Record<string, CostEntry[]> = {};
    for (const e of entries) {
      const key = `${e.provider}/${e.model}`;
      (groups[key] ??= []).push(e);
    }
    const result: Record<string, CostSummary> = {};
    for (const [key, group] of Object.entries(groups)) result[key] = summarize(group);
    return result;
  }

  byTag(tagName: string, filter?: CostFilter): Record<string, CostSummary> {
    const entries = this.filterEntries(filter);
    const groups: Record<string, CostEntry[]> = {};
    for (const e of entries) {
      const val = e.tags[tagName] ?? '(none)';
      (groups[val] ??= []).push(e);
    }
    const result: Record<string, CostSummary> = {};
    for (const [key, group] of Object.entries(groups)) result[key] = summarize(group);
    return result;
  }

  entries(filter?: CostFilter): CostEntry[] {
    return this.filterEntries(filter);
  }

  get entryCount(): number {
    return this.ledger.length;
  }

  get runningTotal(): number {
    return this._runningTotal;
  }

  get modelCatalog(): ModelCatalog {
    return this.catalog;
  }

  export(): CostEntry[] {
    return [...this.ledger];
  }

  import(entries: CostEntry[]): void {
    this.ledger.push(...entries);
    for (const e of entries) this._runningTotal += e.cost.total;
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private handleMediaGenerated(ctx: import('../../bus/hook-map').MediaGeneratedContext): void {
    if (!ctx.mediaType || !ctx.count) return;
    const provider = ctx.provider;
    const model = ctx.model ?? `${provider}/${ctx.mediaType}`;

    // Token usage the provider reported (token-priced media: gpt-image, gemini-tts).
    const tokens = ctx.usage
      ? {
          input: ctx.usage.inputTokens,
          output: ctx.usage.outputTokens,
          cached: ctx.usage.cachedTokens,
          cacheWrite: ctx.usage.cacheWriteTokens,
          reasoning: ctx.usage.reasoningTokens,
          audioInput: ctx.usage.audioInputTokens ?? 0,
          audioOutput: ctx.usage.audioOutputTokens ?? 0,
        }
      : undefined;

    const providerEvidence = ctx.providerEvidence
      ? extractProviderCost(provider, ctx.providerEvidence)
      : {};

    // The one cost engine prices via provider → token → per-unit → unknown.
    const cost = computeCost(this.catalog, {
      provider,
      model: ctx.model ?? ctx.mediaType,
      tokens,
      media: {
        type: ctx.mediaType,
        count: ctx.count,
        durationSeconds: ctx.durationSeconds,
        textChars: ctx.textInput?.length,
        resolution: ctx.resolution,
      },
      providerEvidence,
    });

    const tags: Record<string, string | undefined> = {
      ...this.defaultTags,
      provider,
      model,
      sessionId: this.sessionId,
      type: 'media',
      mediaType: ctx.mediaType,
    };

    const entry: CostEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      provider,
      model,
      tokens: tokens ?? { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
      cost,
      providerEvidence,
      tags,
    };

    this.ledger.push(entry);
    this._runningTotal += cost.total;
    this.hooks.emitSync('onCostEntry', { entry, runningTotal: this._runningTotal });
    this.checkBudgets(entry);
  }

  private handleCompletion(ctx: CompletionContext): void {
    const { provider, model, response, request } = ctx;

    const tokens = {
      input: response.usage.inputTokens || request.estimatedInputTokens,
      output: response.usage.outputTokens,
      cached: response.usage.cachedTokens,
      cacheWrite: response.usage.cacheWriteTokens,
      reasoning: response.usage.reasoningTokens,
      audioInput: response.usage.audioInputTokens ?? 0,
      audioOutput: response.usage.audioOutputTokens ?? 0,
    };

    const providerEvidence = extractProviderCost(provider, response.raw);
    // The provider reports the tier it actually billed; the adapter normalized it
    // to the catalog key on usage.pricingTier. Cost prices at that tier's rates.
    const pricingTier = response.usage.pricingTier;
    const cost = calculateCost(
      this.catalog,
      provider,
      model,
      tokens,
      providerEvidence,
      pricingTier,
    );

    const tags: Record<string, string | undefined> = {
      ...this.defaultTags,
      provider,
      model,
      sessionId: this.sessionId,
      runId: ctx.ctx?.requestId,
      conversationId: ctx.ctx?.conversationId,
    };

    const entry: CostEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      provider,
      model,
      tokens,
      cost,
      ...(response.usage.serviceTier ? { serviceTier: response.usage.serviceTier } : {}),
      providerEvidence,
      tags,
    };

    this.ledger.push(entry);
    this._runningTotal += cost.total;

    this.hooks.emitSync('onCostEntry', { entry, runningTotal: this._runningTotal });
    this.checkBudgets(entry);
  }

  private checkBudgets(entry: CostEntry): void {
    for (const budget of this.budgets) {
      if (!matchesScope(entry, budget.scope)) continue;

      const spent = this.total(budget.scope as CostFilter).total;
      const triggered = this.triggeredThresholds.get(budget.id);
      if (!triggered) continue;

      for (const threshold of budget.thresholds) {
        if (triggered.has(threshold)) continue;
        if (spent >= budget.limit * threshold) {
          triggered.add(threshold);
          this.hooks.emitSync('onBudgetWarning', {
            budgetId: budget.id,
            scope: budget.scope,
            limit: budget.limit,
            current: spent,
            threshold,
            percentage: (spent / budget.limit) * 100,
          } as BudgetWarningContext);
        }
      }

      if (spent >= budget.limit && !triggered.has(1.0)) {
        triggered.add(1.0);
        this.hooks.emitSync('onBudgetExceeded', {
          budgetId: budget.id,
          scope: budget.scope,
          limit: budget.limit,
          current: spent,
          overage: spent - budget.limit,
        } as BudgetExceededContext);

        if (budget.action === 'stop') {
          for (const agent of this.watchedAgents) agent.stop();
        }
      }
    }
  }

  private filterEntries(filter?: CostFilter): CostEntry[] {
    if (!filter) return this.ledger;
    return this.ledger.filter((e) => applyFilter(e, filter));
  }

  private groupBy(field: 'provider', filter?: CostFilter): Record<string, CostSummary> {
    const entries = this.filterEntries(filter);
    const groups: Record<string, CostEntry[]> = {};
    for (const e of entries) {
      const key = e[field];
      (groups[key] ??= []).push(e);
    }
    const result: Record<string, CostSummary> = {};
    for (const [key, group] of Object.entries(groups)) result[key] = summarize(group);
    return result;
  }
}
