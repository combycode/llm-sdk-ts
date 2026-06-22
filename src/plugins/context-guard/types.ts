/** ContextGuard types — strategy interface, decisions, trigger ladder. */

import type { Message } from '../../llm/types/messages';
import type { HookBus } from '../../bus/hook-bus';
import type { HistoryEntry } from '../../agent/history-types';
import type { ContextMeasurer } from '../context-measurer/measurer';
import type { ExtractedFact } from './facts';

/** One step of the trigger ladder. */
export interface TriggerLevel {
  level: string;
  at: number;
}

/** Pluggable adapter for the LLM-driven helpers a strategy may need.
 *  Default impl is a no-op (TruncateStrategy works without it). Layered
 *  strategy benefits from real summarize/extractFacts (e.g. backed by an
 *  agent or a built-in tool registry). */
export interface ContextTools {
  summarize(content: string, maxLength: number, focus?: string): Promise<string>;
  extractFacts(content: string, categories?: string[]): Promise<ExtractedFact[]>;
}

/** Default no-op tools — returns empty summary and no facts. Sufficient for
 *  TruncateStrategy and tests. */
export class NoopContextTools implements ContextTools {
  async summarize(): Promise<string> {
    return '';
  }
  async extractFacts(): Promise<ExtractedFact[]> {
    return [];
  }
}

/** Adapter that delegates ContextTools to an InternalToolRunner.
 *  - summarize → runs `orxa:summarize@1.0.0` and returns its `summary` field.
 *  - extractFacts → runs `orxa:fact-extract@1.0.0` when present in the
 *    registry, else returns []. (fact-extract ships in extensions/, not core.)
 */
export class RunnerContextTools implements ContextTools {
  constructor(
    private readonly deps: {
      runner: {
        run<T>(toolId: string, input: unknown): Promise<T>;
        registry: { get(toolId: string): Promise<unknown> };
      };
      summarizeId?: string;
      factExtractId?: string;
    },
  ) {}

  async summarize(content: string, maxLength: number, focus?: string): Promise<string> {
    const id = this.deps.summarizeId ?? 'orxa:summarize@1.0.0';
    const out = await this.deps.runner.run<{ summary: string }>(id, {
      content,
      maxLength,
      focus,
    });
    return out?.summary ?? '';
  }

  async extractFacts(content: string, categories?: string[]): Promise<ExtractedFact[]> {
    const id = this.deps.factExtractId ?? 'orxa:fact-extract@1.0.0';
    const tool = await this.deps.runner.registry.get(id);
    if (!tool) return [];
    const out = await this.deps.runner.run<{ facts?: ExtractedFact[] }>(id, {
      content,
      categories,
    });
    return out?.facts ?? [];
  }
}

export interface ReactContext {
  level: string;
  percentage: number;
  current: number;
  window: number | null;
  delta: number;
  provider: string;
  model: string;
  attempt: number;
  tools: StrategyTools;
  state: Record<string, unknown>;
}

export type StrategyDecision =
  | { action: 'none' }
  | { action: 'compacted'; note?: string }
  | { action: 'warn'; message: string }
  | { action: 'decline'; reason: string };

export interface ContextStrategy {
  readonly triggers: TriggerLevel[];
  react(ctx: ReactContext): StrategyDecision | Promise<StrategyDecision>;
}

export type FactInjectionSite = 'system-append' | 'first-user-prefix';

export interface StrategyTools {
  segment(opts?: { recentCount?: number; timeWindow?: number }): {
    recent: HistoryEntry[];
    middle: HistoryEntry[];
    old: HistoryEntry[];
  };
  measure(items: readonly HistoryEntry[] | Message[]): number;
  extractFacts(entries: readonly HistoryEntry[], categories?: string[]): Promise<ExtractedFact[]>;
  summarize(entries: readonly HistoryEntry[], maxLength: number, focus?: string): Promise<string>;
  replaceRange(from: number, to: number, replacement: Message): void;
  dropOldest(n: number): void;
  injectFacts(facts: ExtractedFact[], site: FactInjectionSite): void;
  readonly historyLength: number;
}

export type UnknownStrategyPolicy = 'skip' | 'fallback-default' | 'throw';

export interface ContextGuardConfig {
  hooks: HookBus;
  measurer: ContextMeasurer;
  /** Pluggable summarize / fact-extract backend. Defaults to a no-op
   *  (sufficient for TruncateStrategy; LayeredStrategy needs a real one). */
  contextTools?: ContextTools;
  strategies: Record<string, ContextStrategy>;
  defaultStrategy: string;
  onUnknownStrategy?: UnknownStrategyPolicy;
  maxCompactRetries?: number;
  criticalFloor?: number;
}

export interface GuardConversationState {
  v: 1;
  lastLevelIdx: number;
  lastCurrent: number;
  strategyState?: Record<string, Record<string, unknown>>;
}
