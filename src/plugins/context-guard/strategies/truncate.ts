/** TruncateStrategy — cheapest possible compaction.
 *
 *  Drops the oldest messages when usage crosses a threshold. NO LLM calls,
 *  NO fact extraction, NO summarization. Use for prototypes, smoke tests,
 *  and conversations where losing old context is acceptable. */

import type { ContextStrategy, ReactContext, StrategyDecision, TriggerLevel } from '../types';

export interface TruncateStrategyConfig {
  keepRecent?: number;
  triggers?: TriggerLevel[];
  declineCeiling?: number;
}

const DEFAULT_TRIGGERS: TriggerLevel[] = [{ level: 'urgent', at: 0.85 }];

const DEFAULTS = {
  keepRecent: 20,
  declineCeiling: 0.95,
};

export class TruncateStrategy implements ContextStrategy {
  readonly name = 'truncate' as const;
  readonly triggers: TriggerLevel[];

  private readonly keepRecent: number;
  private readonly declineCeiling: number;

  constructor(config: TruncateStrategyConfig = {}) {
    this.keepRecent = config.keepRecent ?? DEFAULTS.keepRecent;
    this.declineCeiling = config.declineCeiling ?? DEFAULTS.declineCeiling;
    this.triggers = config.triggers ?? DEFAULT_TRIGGERS;
  }

  async react(ctx: ReactContext): Promise<StrategyDecision> {
    const total = ctx.tools.historyLength;

    if (total <= this.keepRecent) {
      return { action: 'none' };
    }

    const dropCount = total - this.keepRecent;
    if (dropCount <= 0) return { action: 'none' };

    ctx.tools.dropOldest(dropCount);

    const percentUsed = ctx.window && ctx.window > 0 ? ctx.current / ctx.window : 0;
    if (percentUsed >= this.declineCeiling) {
      return {
        action: 'decline',
        reason: `still above ${Math.round(this.declineCeiling * 100)}% after dropping ${dropCount} entries`,
      };
    }

    return { action: 'compacted', note: `dropped ${dropCount} oldest entries` };
  }
}
