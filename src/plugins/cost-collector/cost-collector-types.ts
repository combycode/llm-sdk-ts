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
  /** How many of `entries` could not be priced — no catalog entry for the model, or no
   *  applicable rate. They count as 0 in every field above, so a summary without this
   *  number cannot tell "this run was cheap" from "this run was never priced". Free
   *  calls are NOT counted here: they are priced, at zero. */
  unpriced: number;
  /** The distinct `provider/model` values behind `unpriced`, so the gap is actionable
   *  rather than merely visible. Empty when everything was priced. */
  unpricedModels: string[];
}
