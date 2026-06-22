/** CostCollector public types: config, budgets, filters, summaries. */

import type { HookBus } from '../../bus/hook-bus';
import type { ModelCatalog } from '../model-catalog/catalog';

export interface CostCollectorConfig {
  hooks: HookBus;
  catalog: ModelCatalog;
  sessionId?: string;
  defaultTags?: Record<string, string>;
}

export interface Budget {
  id: string;
  limit: number;
  scope: Record<string, string | undefined>;
  thresholds: number[];
  action: 'warn' | 'stop';
}

export interface CostFilter {
  provider?: string;
  model?: string;
  runId?: string;
  conversationId?: string;
  sessionId?: string;
  after?: number;
  before?: number;
  [key: string]: string | number | undefined;
}

export interface CostSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  tokens: {
    input: number;
    output: number;
    cached: number;
    cacheWrite: number;
    reasoning: number;
  };
  entries: number;
}
