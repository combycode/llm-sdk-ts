/** AnchoredStrategy — one growing scratchpad instead of a chain of summaries.
 *
 *  `LayeredStrategy` emits a NEW summary each time it compacts, so a long conversation accumulates
 *  summaries-of-summaries: the oldest facts get re-summarised repeatedly and drift further from
 *  what was actually said. This strategy keeps a SINGLE anchor entry at the head of history and
 *  merges each compaction into it — the anchor grows, but every fact is summarised from the raw
 *  text exactly once.
 *
 *  The trade is real and worth stating: one anchor means one blast radius. A bad merge corrupts the
 *  whole record, where a chain of summaries only corrupts one link. Anchored suits long-running
 *  task/state tracking ("what have we established so far"); layered suits conversations where
 *  recency matters more than a durable state.
 *
 *  Ported from google-adk-ts `AnchoredContextCompactor` (adk 1.5), including its refusal to split a
 *  tool call from its result. */

import type { HistoryEntry } from '../../../agent/history-types';
import type { ContextStrategy, ReactContext, StrategyDecision, TriggerLevel } from '../types';

export interface AnchoredStrategyConfig {
  /** Raw entries to keep verbatim at the tail. */
  keepRecent?: number;
  /** Cap on the anchor's own length, so the thing that replaces history cannot become history. */
  anchorMaxChars?: number;
  triggers?: TriggerLevel[];
  /** Above this usage ratio, report `decline` — compaction alone will not save the request. */
  declineCeiling?: number;
}

const DEFAULT_TRIGGERS: TriggerLevel[] = [{ level: 'warn', at: 0.7 }];

const DEFAULTS = {
  keepRecent: 12,
  anchorMaxChars: 4000,
  declineCeiling: 0.95,
};

/** Marks the anchor entry so it can be found again on the next compaction. Kept in the text rather
 *  than in metadata because the anchor has to survive an export/import round trip of history. */
export const ANCHOR_MARKER = '[context-anchor]';

/** Where the retained tail starts, refusing to split a tool call from its result.
 *
 *  Cutting between them leaves a `tool_result` whose call is gone, which several providers reject
 *  outright and the rest silently misread. Walking the boundary backwards keeps the pair together.
 *  Direct port of adk's `calculateRetainStartIndex`. */
export function calculateRetainStartIndex(entries: readonly HistoryEntry[], keepRecent: number): number {
  let start = Math.max(0, entries.length - keepRecent);
  while (start > 0) {
    const retained = entries[start];
    const previous = entries[start - 1];
    if (hasToolResult(retained) && hasToolCall(previous)) start--;
    else break;
  }
  return start;
}

function parts(entry: HistoryEntry | undefined): Array<{ type?: string }> {
  const content = (entry as { message?: { content?: unknown } } | undefined)?.message?.content;
  return Array.isArray(content) ? (content as Array<{ type?: string }>) : [];
}

function hasToolResult(entry: HistoryEntry | undefined): boolean {
  return parts(entry).some((p) => p.type === 'tool_result');
}

function hasToolCall(entry: HistoryEntry | undefined): boolean {
  return parts(entry).some((p) => p.type === 'tool_call');
}

export class AnchoredStrategy implements ContextStrategy {
  readonly name = 'anchored' as const;
  readonly triggers: TriggerLevel[];

  private readonly keepRecent: number;
  private readonly anchorMaxChars: number;
  private readonly declineCeiling: number;

  constructor(config: AnchoredStrategyConfig = {}) {
    this.keepRecent = config.keepRecent ?? DEFAULTS.keepRecent;
    this.anchorMaxChars = config.anchorMaxChars ?? DEFAULTS.anchorMaxChars;
    this.declineCeiling = config.declineCeiling ?? DEFAULTS.declineCeiling;
    this.triggers = config.triggers ?? DEFAULT_TRIGGERS;
  }

  async react(ctx: ReactContext): Promise<StrategyDecision> {
    // `segment` is the seam's view of history; re-joining it gives the ordered entry list the
    // retain-boundary calculation needs (it works in absolute indices).
    const { recent, middle, old } = ctx.tools.segment({ recentCount: this.keepRecent });
    const entries: HistoryEntry[] = [...old, ...middle, ...recent];
    const total = ctx.tools.historyLength;
    if (total <= this.keepRecent + 1) return { action: 'none' };

    const retainStart = calculateRetainStartIndex(entries, this.keepRecent);
    // Everything before the tail is a candidate; the existing anchor (index 0, if any) is folded
    // back in rather than re-summarised, which is the whole point of the strategy.
    const anchorPresent = isAnchor(entries[0]);
    if (retainStart <= (anchorPresent ? 1 : 0)) return { action: 'none' };

    const toMerge = entries.slice(anchorPresent ? 1 : 0, retainStart);
    if (toMerge.length === 0) return { action: 'none' };

    const previousAnchor = anchorPresent ? anchorText(entries[0]) : '';
    const summary = await ctx.tools.summarize(
      toMerge,
      this.anchorMaxChars,
      previousAnchor
        ? 'Merge these events into the running state summary; keep established facts, drop superseded ones.'
        : 'Summarise these events as a running state summary.',
    );

    // A summariser that returns nothing must not be allowed to erase history — that would trade a
    // context overflow for silent data loss, which is strictly worse.
    if (!summary.trim()) {
      return { action: 'decline', reason: 'summarizer returned nothing; refusing to drop entries' };
    }

    const merged = mergeAnchor(previousAnchor, summary, this.anchorMaxChars);
    ctx.tools.replaceRange(0, retainStart, {
      role: 'system',
      content: `${ANCHOR_MARKER}\n${merged}`,
    });

    const percentUsed = ctx.window && ctx.window > 0 ? ctx.current / ctx.window : 0;
    if (percentUsed >= this.declineCeiling) {
      return {
        action: 'decline',
        reason: `still above ${Math.round(this.declineCeiling * 100)}% after merging ${toMerge.length} entries into the anchor`,
      };
    }
    return {
      action: 'compacted',
      note: `merged ${toMerge.length} entries into the ${previousAnchor ? 'existing' : 'new'} anchor`,
    };
  }
}

function isAnchor(entry: HistoryEntry | undefined): boolean {
  const content = (entry as { message?: { role?: string; content?: unknown } } | undefined)?.message;
  return (
    content?.role === 'system' &&
    typeof content.content === 'string' &&
    content.content.startsWith(ANCHOR_MARKER)
  );
}

function anchorText(entry: HistoryEntry | undefined): string {
  const content = (entry as { message?: { content?: unknown } } | undefined)?.message?.content;
  return typeof content === 'string' ? content.slice(ANCHOR_MARKER.length).trim() : '';
}

/** Fold a new summary into the anchor, bounded so the anchor cannot itself become the problem.
 *  When trimming is needed the NEWER text is kept — it already subsumes the older state. */
export function mergeAnchor(previous: string, addition: string, maxChars: number): string {
  const merged = previous ? `${previous}\n${addition}` : addition;
  if (merged.length <= maxChars) return merged;
  return merged.slice(merged.length - maxChars);
}
