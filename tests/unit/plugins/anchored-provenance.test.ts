/** AnchoredStrategy (google-adk 1.5 `AnchoredContextCompactor`) and `checkProvenance()`
 *  (openai-ts 7.x `POST /v1/content_provenance_checks`). */

import { describe, expect, it } from 'bun:test';
import {
  ANCHOR_MARKER,
  AnchoredStrategy,
  calculateRetainStartIndex,
  mergeAnchor,
} from '../../../src/plugins/context-guard/strategies/anchored';
import { parseProvenanceResponse } from '../../../src/llm/providers/openai/provenance';
import type { HistoryEntry } from '../../../src/agent/history-types';
import type { ReactContext, StrategyTools } from '../../../src/plugins/context-guard/types';

const entry = (role: string, content: unknown): HistoryEntry =>
  ({ message: { role, content } }) as unknown as HistoryEntry;

const text = (t: string) => entry('user', [{ type: 'text', text: t }]);
const toolCall = () => entry('assistant', [{ type: 'tool_call', id: 'c1', name: 'x', arguments: {} }]);
const toolResult = () => entry('tool', [{ type: 'tool_result', id: 'c1', content: 'ok' }]);

// ─── the tool-pair split guard ───────────────────────────────────────────────

describe('calculateRetainStartIndex', () => {
  it('keeps the last N when nothing straddles the boundary', () => {
    const entries = [text('a'), text('b'), text('c'), text('d')];
    expect(calculateRetainStartIndex(entries, 2)).toBe(2);
  });

  it('walks back rather than splitting a tool call from its result', () => {
    // Boundary would land ON the tool_result, orphaning it from its call.
    const entries = [text('a'), toolCall(), toolResult(), text('d')];
    expect(calculateRetainStartIndex(entries, 2)).toBe(1);
  });

  it('walks back across a chain of pairs', () => {
    const entries = [text('a'), toolCall(), toolResult(), toolCall(), toolResult()];
    expect(calculateRetainStartIndex(entries, 2)).toBe(3);
  });

  it('never goes below zero', () => {
    expect(calculateRetainStartIndex([toolCall(), toolResult()], 1)).toBe(0);
    expect(calculateRetainStartIndex([], 5)).toBe(0);
  });
});

describe('mergeAnchor', () => {
  it('appends to an existing anchor', () => {
    expect(mergeAnchor('old state', 'new facts', 1000)).toBe('old state\nnew facts');
  });

  it('keeps the NEWER text when it has to trim', () => {
    // The newer summary already subsumes the older state, so dropping from the front is the
    // lossless-ish direction.
    const merged = mergeAnchor('x'.repeat(100), 'NEWEST', 20);
    expect(merged.length).toBe(20);
    expect(merged.endsWith('NEWEST')).toBe(true);
  });
});

// ─── the strategy ────────────────────────────────────────────────────────────

function makeTools(entries: HistoryEntry[], summary: string) {
  const calls: Array<{ from: number; to: number; replacement: unknown }> = [];
  const tools: StrategyTools = {
    segment: ({ recentCount = 0 } = {}) => ({
      recent: entries.slice(Math.max(0, entries.length - recentCount)),
      middle: entries.slice(0, Math.max(0, entries.length - recentCount)),
      old: [],
    }),
    measure: () => 0,
    extractFacts: async () => [],
    summarize: async () => summary,
    replaceRange: (from, to, replacement) => {
      calls.push({ from, to, replacement });
    },
    dropOldest: () => {},
    injectFacts: () => {},
    get historyLength() {
      return entries.length;
    },
  };
  return { tools, calls };
}

const ctx = (tools: StrategyTools): ReactContext =>
  ({
    level: 'warn',
    percentage: 0.75,
    current: 750,
    window: 1000,
    delta: 0,
    provider: 'openai',
    model: 'gpt-4o',
    attempt: 1,
    tools,
    state: {},
  }) as ReactContext;

describe('AnchoredStrategy', () => {
  it('creates a marked anchor on first compaction', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => text(`m${i}`));
    const { tools, calls } = makeTools(entries, 'the running state');
    const decision = await new AnchoredStrategy({ keepRecent: 3 }).react(ctx(tools));

    expect(decision.action).toBe('compacted');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.from).toBe(0);
    const replacement = calls[0]?.replacement as { role: string; content: string };
    expect(replacement.role).toBe('system');
    expect(replacement.content.startsWith(ANCHOR_MARKER)).toBe(true);
    expect(replacement.content).toContain('the running state');
  });

  it('merges into the existing anchor instead of stacking a second summary', async () => {
    const entries = [
      entry('system', `${ANCHOR_MARKER}\nprevious state`),
      ...Array.from({ length: 9 }, (_, i) => text(`m${i}`)),
    ];
    const { tools, calls } = makeTools(entries, 'newer state');
    const decision = await new AnchoredStrategy({ keepRecent: 3 }).react(ctx(tools));

    expect(decision.action).toBe('compacted');
    const content = (calls[0]?.replacement as { content: string }).content;
    // One anchor, both states — not summary-of-summary.
    expect(content).toContain('previous state');
    expect(content).toContain('newer state');
    expect(content.match(new RegExp(ANCHOR_MARKER.replace(/[[\]]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(decision.action === 'compacted' && decision.note).toContain('existing anchor');
  });

  it('refuses to drop entries when the summariser returns nothing', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => text(`m${i}`));
    const { tools, calls } = makeTools(entries, '   ');
    const decision = await new AnchoredStrategy({ keepRecent: 3 }).react(ctx(tools));

    // Trading a context overflow for silent data loss would be strictly worse.
    expect(decision.action).toBe('decline');
    expect(calls).toHaveLength(0);
  });

  it('does nothing when history is already short', async () => {
    const { tools, calls } = makeTools([text('a'), text('b')], 's');
    expect((await new AnchoredStrategy({ keepRecent: 12 }).react(ctx(tools))).action).toBe('none');
    expect(calls).toHaveLength(0);
  });
});

// ─── provenance parsing ──────────────────────────────────────────────────────

describe('parseProvenanceResponse', () => {
  it('reports a trusted C2PA manifest', () => {
    const v = parseProvenanceResponse({
      created_at: 123,
      results: [
        { type: 'c2pa', outcome: 'detected', validation_state: 'trusted', issuer: 'OpenAI', model: 'gpt-image-1' },
        { type: 'synthid', outcome: 'not_detected' },
      ],
    });
    expect(v.detected).toBe(true);
    expect(v.trusted).toBe(true);
    expect(v.signals).toHaveLength(2);
    expect(v.signals[0]?.issuer).toBe('OpenAI');
  });

  it('detected but NOT trusted when the manifest fails validation', () => {
    const v = parseProvenanceResponse({
      results: [{ type: 'c2pa', outcome: 'detected', validation_state: 'invalid' }],
    });
    expect(v.detected).toBe(true);
    expect(v.trusted).toBe(false);
  });

  it('counts a single detected signal — audio carries SynthID only', () => {
    const v = parseProvenanceResponse({
      results: [{ type: 'synthid', outcome: 'detected' }],
    });
    // Requiring both schemes would report every audio file as clean.
    expect(v.detected).toBe(true);
  });

  it('reports nothing detected for an empty or missing result set', () => {
    expect(parseProvenanceResponse({ results: [] }).detected).toBe(false);
    expect(parseProvenanceResponse(undefined).detected).toBe(false);
    expect(parseProvenanceResponse(undefined).signals).toEqual([]);
  });
});
