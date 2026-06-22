/** LayeredStrategy — three-zone compaction policy.
 *
 *  Zones: recent (verbatim) / middle (per-segment summary) / old (fact-only).
 *  Escalation by trigger level: healthy/pressure/urgent/critical. */

import type { ContextStrategy, ReactContext, StrategyDecision, TriggerLevel } from '../types';
import type { Message } from '../../../llm/types/messages';

export interface LayeredStrategyConfig {
  recentCount?: number;
  middleSummaryChars?: number;
  oldSummaryChars?: number;
  jumpEscalateDelta?: number;
  declineCeiling?: number;
  triggers?: TriggerLevel[];
}

const DEFAULT_TRIGGERS: TriggerLevel[] = [
  { level: 'healthy', at: 0.5 },
  { level: 'pressure', at: 0.7 },
  { level: 'urgent', at: 0.85 },
  { level: 'critical', at: 0.95 },
];

const DEFAULTS = {
  recentCount: 6,
  middleSummaryChars: 300,
  oldSummaryChars: 400,
  jumpEscalateDelta: 0.3,
  declineCeiling: 0.9,
};

export class LayeredStrategy implements ContextStrategy {
  readonly triggers: TriggerLevel[];
  private readonly cfg: Required<Omit<LayeredStrategyConfig, 'triggers'>>;

  constructor(config: LayeredStrategyConfig = {}) {
    this.triggers = config.triggers ?? DEFAULT_TRIGGERS;
    this.cfg = {
      recentCount: config.recentCount ?? DEFAULTS.recentCount,
      middleSummaryChars: config.middleSummaryChars ?? DEFAULTS.middleSummaryChars,
      oldSummaryChars: config.oldSummaryChars ?? DEFAULTS.oldSummaryChars,
      jumpEscalateDelta: config.jumpEscalateDelta ?? DEFAULTS.jumpEscalateDelta,
      declineCeiling: config.declineCeiling ?? DEFAULTS.declineCeiling,
    };
  }

  async react(ctx: ReactContext): Promise<StrategyDecision> {
    const effectiveLevel = this.applyJumpEscalation(ctx);

    if (ctx.percentage >= this.cfg.declineCeiling && ctx.attempt >= 1) {
      return {
        action: 'decline',
        reason: `Context at ${(ctx.percentage * 100).toFixed(1)}% after ${ctx.attempt + 1} compaction attempt(s); unable to fit safely.`,
      };
    }

    switch (effectiveLevel) {
      case 'healthy':
        return this.compactOldLayer(ctx);
      case 'pressure':
        return this.compactOldAndMiddle(ctx);
      case 'urgent':
        return this.compactAll(ctx);
      case 'critical':
        return this.compactAggressive(ctx);
      default:
        return { action: 'none' };
    }
  }

  private async compactOldLayer(ctx: ReactContext): Promise<StrategyDecision> {
    const { old } = ctx.tools.segment({ recentCount: this.cfg.recentCount });
    if (old.length === 0) return { action: 'none' };

    const facts = await ctx.tools.extractFacts(old);
    const summary = await ctx.tools.summarize(old, this.cfg.oldSummaryChars);

    const replacementText = summary
      ? `[Earlier conversation summary]\n${summary}`
      : '[Earlier conversation omitted]';
    const replacement: Message = {
      role: 'user',
      content: replacementText,
    };
    ctx.tools.replaceRange(0, old.length, replacement);

    if (facts.length > 0) {
      ctx.tools.injectFacts(facts, 'system-append');
    }

    return {
      action: 'compacted',
      note: `compacted ${old.length} old entries into one summary; ${facts.length} facts preserved`,
    };
  }

  private async compactOldAndMiddle(ctx: ReactContext): Promise<StrategyDecision> {
    const { old, middle } = ctx.tools.segment({ recentCount: this.cfg.recentCount });

    let replacedOld = 0;
    if (old.length > 0) {
      const facts = await ctx.tools.extractFacts(old);
      const summary = await ctx.tools.summarize(old, this.cfg.oldSummaryChars);
      const text = summary
        ? `[Earlier conversation summary]\n${summary}`
        : '[Earlier conversation omitted]';
      ctx.tools.replaceRange(0, old.length, { role: 'user', content: text });
      if (facts.length > 0) ctx.tools.injectFacts(facts, 'system-append');
      replacedOld = 1;
    }

    if (middle.length > 0) {
      const facts = await ctx.tools.extractFacts(middle);
      const summary = await ctx.tools.summarize(middle, this.cfg.middleSummaryChars);
      const text = summary
        ? `[Prior discussion summary]\n${summary}`
        : '[Prior discussion omitted]';
      ctx.tools.replaceRange(replacedOld, replacedOld + middle.length, {
        role: 'user',
        content: text,
      });
      if (facts.length > 0) ctx.tools.injectFacts(facts, 'system-append');
    }

    return { action: 'compacted', note: 'compacted old + middle layers' };
  }

  private async compactAll(ctx: ReactContext): Promise<StrategyDecision> {
    await this.compactOldAndMiddle(ctx);

    const halfRecent = Math.max(2, Math.floor(this.cfg.recentCount / 2));
    const total = ctx.tools.historyLength;
    const seg = ctx.tools.segment({ recentCount: halfRecent });
    const merged = [...seg.old, ...seg.middle];
    if (merged.length > 0) {
      const facts = await ctx.tools.extractFacts(merged);
      const summary = await ctx.tools.summarize(merged, this.cfg.oldSummaryChars);
      const text = summary ? `[Compacted prior context]\n${summary}` : '[Prior context compacted]';
      const upTo = total - halfRecent;
      ctx.tools.replaceRange(0, upTo, { role: 'user', content: text });
      if (facts.length > 0) ctx.tools.injectFacts(facts, 'system-append');
    }

    return {
      action: 'compacted',
      note: `urgent: compacted old+middle and shrunk recent to last ${halfRecent}`,
    };
  }

  private async compactAggressive(ctx: ReactContext): Promise<StrategyDecision> {
    const keepLast = 2;
    const total = ctx.tools.historyLength;
    if (total <= keepLast) {
      return {
        action: 'decline',
        reason: `Context at ${(ctx.percentage * 100).toFixed(1)}% with only ${total} entries — the new content alone exceeds what compaction can free.`,
      };
    }

    const seg = ctx.tools.segment({ recentCount: keepLast });
    const toCompact = [...seg.old, ...seg.middle];
    if (toCompact.length === 0) {
      return {
        action: 'decline',
        reason: 'Nothing left to compact but still above critical threshold.',
      };
    }

    const facts = await ctx.tools.extractFacts(toCompact);
    const summary = await ctx.tools.summarize(toCompact, this.cfg.oldSummaryChars);
    const text = summary
      ? `[Conversation so far - compacted]\n${summary}`
      : '[Prior conversation compacted]';
    ctx.tools.replaceRange(0, toCompact.length, { role: 'user', content: text });
    if (facts.length > 0) ctx.tools.injectFacts(facts, 'system-append');

    return {
      action: 'compacted',
      note: `critical: kept last ${keepLast}, compacted ${toCompact.length}, ${facts.length} facts preserved`,
    };
  }

  private applyJumpEscalation(ctx: ReactContext): string {
    if (ctx.window === null || ctx.window === 0) return ctx.level;
    const deltaFraction = ctx.delta / ctx.window;
    if (deltaFraction < this.cfg.jumpEscalateDelta) return ctx.level;

    const idx = this.triggers.findIndex((t) => t.level === ctx.level);
    if (idx < 0 || idx >= this.triggers.length - 1) return ctx.level;
    return this.triggers[idx + 1].level;
  }
}
