/** LayeredStrategy — the three-zone compaction policy, stated as behaviour.
 *
 *  These are the etalon for a port. Two failures a port of this file has already
 *  shipped are pinned explicitly:
 *
 *    1. A compactor that DELETED history when the summariser returned an empty
 *       string. Empty summary is a normal outcome (no tools wired, a refusal, a
 *       blank model reply) — it must degrade to a placeholder entry, never to
 *       "drop the range and put nothing back".
 *
 *    2. A compaction boundary that split a tool_call from its tool_result. The
 *       range handed to replaceRange must be exactly the range that was
 *       summarised; one off-by-one there strands a tool_result whose call no
 *       longer exists, which most providers reject outright.
 */

import { describe, expect, it } from 'bun:test';
import { ConversationHistory } from '../../../../src/agent/history';
import { LayeredStrategy } from '../../../../src/plugins/context-guard/strategies/layered';
import { StrategyToolsImpl } from '../../../../src/plugins/context-guard/tools';
import { HeuristicCounter } from '../../../../src/plugins/context-measurer/counter/heuristic';
import { LAYER_CHAT_FACTS } from '../../../../src/agent/context-registry/layers';
import type {
  ContextTools,
  ReactContext,
  StrategyDecision,
  StrategyTools,
} from '../../../../src/plugins/context-guard/types';
import type { ExtractedFact } from '../../../../src/plugins/context-guard/facts';
import type { ContentPart, Message } from '../../../../src/llm/types/messages';

// ─── Harness ─────────────────────────────────────────────────────────────────

interface RecordingTools extends ContextTools {
  summarizeCalls: Array<{ content: string; maxLength: number }>;
  factCalls: string[];
}

function recordingTools(opts: { summary?: string; facts?: ExtractedFact[] } = {}): RecordingTools {
  const summarizeCalls: Array<{ content: string; maxLength: number }> = [];
  const factCalls: string[] = [];
  return {
    summarizeCalls,
    factCalls,
    async summarize(content: string, maxLength: number): Promise<string> {
      summarizeCalls.push({ content, maxLength });
      return opts.summary ?? '';
    },
    async extractFacts(content: string): Promise<ExtractedFact[]> {
      factCalls.push(content);
      return opts.facts ?? [];
    },
  };
}

/** Delegates to the real StrategyToolsImpl while recording fact injections,
 *  so a test can say WHICH zones contributed facts and not merely that the
 *  layer ended up populated. */
function spyOnInjectFacts(
  impl: StrategyTools,
  record: Array<{ count: number; site: string }>,
): StrategyTools {
  return {
    get historyLength() {
      return impl.historyLength;
    },
    segment: (o) => impl.segment(o),
    measure: (i) => impl.measure(i),
    measureCurrent: () => impl.measureCurrent(),
    extractFacts: (e, c) => impl.extractFacts(e, c),
    summarize: (e, n, f) => impl.summarize(e, n, f),
    replaceRange: (a, b, r) => impl.replaceRange(a, b, r),
    dropOldest: (n) => impl.dropOldest(n),
    injectFacts: (facts, site) => {
      record.push({ count: facts.length, site });
      impl.injectFacts(facts, site);
    },
  };
}

function harness(
  messages: Message[],
  tools: ContextTools,
  over: Partial<ReactContext> = {},
): {
  history: ConversationHistory;
  active: Message[];
  ctx: ReactContext;
  injections: Array<{ count: number; site: string }>;
} {
  const history = new ConversationHistory();
  for (const m of messages) history.append(m);
  const active = history.messages();
  const injections: Array<{ count: number; site: string }> = [];
  const ctx: ReactContext = {
    level: 'healthy',
    percentage: 0.55,
    current: 550,
    window: 1000,
    delta: 0,
    provider: 'test',
    model: 'tiny',
    attempt: 0,
    tools: spyOnInjectFacts(
      new StrategyToolsImpl({
        history,
        activeMessages: active,
        counter: new HeuristicCounter(null),
        contextTools: tools,
        provider: 'test',
        model: 'tiny',
      }),
      injections,
    ),
    state: {},
    ...over,
  };
  return { history, active, ctx, injections };
}

/** Ten alternating text turns, each individually identifiable. */
function tenTurns(): Message[] {
  return Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `turn-${i}`,
  }));
}

/** The text turns used below always carry string content; anything else is a
 *  bug in the test, so surface it rather than stringifying it away. */
function textOf(m: Message): string {
  if (typeof m.content !== 'string') throw new Error('expected a string-content message');
  return m.content;
}

/** The note on a `compacted` decision. Narrowing first is the point: a
 *  decision that is NOT a compaction has no note, and reading one off it
 *  would quietly pass `undefined` into the comparison. */
function noteOf(d: StrategyDecision): string | undefined {
  expect(d.action).toBe('compacted');
  return d.action === 'compacted' ? d.note : undefined;
}

function texts(history: ConversationHistory): string[] {
  return history.messages().map(textOf);
}

// ─── Level ladder ────────────────────────────────────────────────────────────

describe('LayeredStrategy — level ladder', () => {
  it('healthy compacts only the OLD third and leaves middle + recent verbatim', async () => {
    const tools = recordingTools({ summary: 'the gist' });
    const { history, ctx } = harness(tenTurns(), tools);
    const strategy = new LayeredStrategy({ recentCount: 4 });

    const decision = await strategy.react(ctx);

    expect(decision).toEqual({
      action: 'compacted',
      note: 'compacted 3 old entries into one summary; 0 facts preserved',
    });
    // 3 old entries → 1 summary; turns 3..9 survive untouched.
    expect(texts(history)).toEqual([
      '[Earlier conversation summary]\nthe gist',
      'turn-3',
      'turn-4',
      'turn-5',
      'turn-6',
      'turn-7',
      'turn-8',
      'turn-9',
    ]);
    // Only the old zone was summarised — the middle was never sent.
    expect(tools.summarizeCalls).toHaveLength(1);
    expect(tools.summarizeCalls[0].content).toContain('turn-2');
    expect(tools.summarizeCalls[0].content).not.toContain('turn-3');
  });

  it('healthy is a no-op when the recent window already covers the whole history', async () => {
    const tools = recordingTools({ summary: 'x' });
    const { history, ctx } = harness(tenTurns(), tools);
    const strategy = new LayeredStrategy({ recentCount: 20 });

    expect(await strategy.react(ctx)).toEqual({ action: 'none' });
    expect(history.length).toBe(10);
    expect(tools.summarizeCalls).toHaveLength(0);
  });

  it('pressure compacts old AND middle into two separate summaries', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(tenTurns(), tools, { level: 'pressure', percentage: 0.75 });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    expect(await strategy.react(ctx)).toEqual({
      action: 'compacted',
      note: 'compacted old + middle layers',
    });
    expect(texts(history)).toEqual([
      '[Earlier conversation summary]\ngist',
      '[Prior discussion summary]\ngist',
      'turn-6',
      'turn-7',
      'turn-8',
      'turn-9',
    ]);
    // Two distinct summarise calls with the strategy's two distinct budgets.
    expect(tools.summarizeCalls.map((c) => c.maxLength)).toEqual([400, 300]);
    expect(tools.summarizeCalls[1].content).toContain('turn-5');
    expect(tools.summarizeCalls[1].content).not.toContain('turn-6');
  });

  it('pressure with nothing old still compacts the middle at index 0', async () => {
    const tools = recordingTools({ summary: 'gist' });
    // 5 entries, recentCount 4 → remainder is one entry, midPoint 0 → old [], middle [e0].
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      role: 'user' as const,
      content: `turn-${i}`,
    }));
    const { history, ctx } = harness(msgs, tools, { level: 'pressure' });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    await strategy.react(ctx);

    expect(texts(history)).toEqual([
      '[Prior discussion summary]\ngist',
      'turn-1',
      'turn-2',
      'turn-3',
      'turn-4',
    ]);
  });

  it('urgent additionally halves the recent window', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(tenTurns(), tools, { level: 'urgent', percentage: 0.87 });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    expect(await strategy.react(ctx)).toEqual({
      action: 'compacted',
      note: 'urgent: compacted old+middle and shrunk recent to last 2',
    });
    // recentCount 4 → halfRecent 2: exactly the last two turns survive verbatim.
    expect(texts(history)).toEqual([
      '[Compacted prior context]\ngist',
      'turn-8',
      'turn-9',
    ]);
  });

  it('urgent never shrinks the recent window below two entries', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(tenTurns(), tools, { level: 'urgent' });
    // floor(2/2) = 1, but the floor of 2 must win.
    const strategy = new LayeredStrategy({ recentCount: 2 });

    await strategy.react(ctx);

    expect(texts(history).slice(-2)).toEqual(['turn-8', 'turn-9']);
    expect(history.length).toBe(3);
  });

  it('critical keeps only the last two entries', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(tenTurns(), tools, { level: 'critical', percentage: 0.96 });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    expect(await strategy.react(ctx)).toEqual({
      action: 'compacted',
      note: 'critical: kept last 2, compacted 8, 0 facts preserved',
    });
    expect(texts(history)).toEqual([
      '[Conversation so far - compacted]\ngist',
      'turn-8',
      'turn-9',
    ]);
  });

  it('an unknown level does nothing rather than guessing a zone', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(tenTurns(), tools, { level: 'exuberant' });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    expect(await strategy.react(ctx)).toEqual({ action: 'none' });
    expect(history.length).toBe(10);
  });
});

// ─── The empty-summary trap ──────────────────────────────────────────────────

describe('LayeredStrategy — an empty summary must not delete history', () => {
  it('healthy: the compacted range becomes a placeholder entry, not nothing', async () => {
    const tools = recordingTools({ summary: '' });
    const { history, ctx } = harness(tenTurns(), tools);
    const strategy = new LayeredStrategy({ recentCount: 4 });

    await strategy.react(ctx);

    expect(texts(history)).toEqual([
      '[Earlier conversation omitted]',
      'turn-3',
      'turn-4',
      'turn-5',
      'turn-6',
      'turn-7',
      'turn-8',
      'turn-9',
    ]);
  });

  it('pressure: both zones get their own placeholder', async () => {
    const tools = recordingTools({ summary: '' });
    const { history, ctx } = harness(tenTurns(), tools, { level: 'pressure' });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    await strategy.react(ctx);

    expect(texts(history).slice(0, 2)).toEqual([
      '[Earlier conversation omitted]',
      '[Prior discussion omitted]',
    ]);
    expect(history.length).toBe(6);
  });

  it('urgent: placeholder text, recent window still intact', async () => {
    const tools = recordingTools({ summary: '' });
    const { history, ctx } = harness(tenTurns(), tools, { level: 'urgent' });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    await strategy.react(ctx);

    expect(texts(history)).toEqual(['[Prior context compacted]', 'turn-8', 'turn-9']);
  });

  it('critical: placeholder text, last two entries still intact', async () => {
    const tools = recordingTools({ summary: '' });
    const { history, ctx } = harness(tenTurns(), tools, { level: 'critical' });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    await strategy.react(ctx);

    expect(texts(history)).toEqual(['[Prior conversation compacted]', 'turn-8', 'turn-9']);
  });
});

// ─── The tool-call / tool-result pairing invariant ───────────────────────────

/** Every tool_result left in history must still have its tool_call, and vice
 *  versa. A compaction boundary that is off by one against the range it
 *  summarised strands one half of a pair. */
function unpairedToolParts(history: ConversationHistory): {
  orphanResults: string[];
  orphanCalls: string[];
} {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const msg of history.messages()) {
    if (typeof msg.content === 'string') continue;
    for (const part of msg.content as ContentPart[]) {
      if (part.type === 'tool_call') calls.add(part.id);
      else if (part.type === 'tool_result') results.add(part.id);
    }
  }
  return {
    orphanResults: [...results].filter((id) => !calls.has(id)),
    orphanCalls: [...calls].filter((id) => !results.has(id)),
  };
}

/** user / assistant(tool_call) / tool(tool_result), repeated `pairs` times. */
function toolConversation(pairs: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < pairs; i++) {
    out.push({ role: 'user', content: `ask-${i}` });
    out.push({
      role: 'assistant',
      content: [{ type: 'tool_call', id: `call_${i}`, name: 'lookup', arguments: { i } }],
    });
    out.push({
      role: 'tool',
      content: [{ type: 'tool_result', id: `call_${i}`, content: `result-${i}` }],
    });
  }
  return out;
}

describe('LayeredStrategy — compaction never splits a tool call from its result', () => {
  it('critical: the surviving tail carries a complete pair, the rest is summarised', async () => {
    const tools = recordingTools({ summary: 'gist' });
    // 4 pairs = 12 entries. keepLast 2 → the tail is [tool_call_3, tool_result_3].
    const { history, ctx } = harness(toolConversation(4), tools, { level: 'critical' });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    await strategy.react(ctx);

    expect(unpairedToolParts(history)).toEqual({ orphanResults: [], orphanCalls: [] });
    expect(history.length).toBe(3);
    // Everything removed was handed to the summariser — nothing dropped silently.
    const sent = tools.summarizeCalls[0].content;
    for (const i of [0, 1, 2]) {
      expect(sent).toContain(`[tool_call lookup]({"i":${i}})`);
      expect(sent).toContain(`result-${i}`);
    }
    // Pair 3 survives verbatim, so it is NOT in the summarised text.
    expect(sent).not.toContain('[tool_call lookup]({"i":3})');
    expect(sent).not.toContain('result-3');
  });

  it('urgent: the halved recent window still lands on a whole pair', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(toolConversation(4), tools, { level: 'urgent' });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    await strategy.react(ctx);

    expect(unpairedToolParts(history)).toEqual({ orphanResults: [], orphanCalls: [] });
    expect(history.length).toBe(3);
  });

  it('healthy: the old/middle boundary does not strand a result either', async () => {
    const tools = recordingTools({ summary: 'gist' });
    // 6 pairs = 18 entries, recentCount 6 → old = 6 entries = exactly two pairs.
    const { history, ctx } = harness(toolConversation(6), tools);
    const strategy = new LayeredStrategy({ recentCount: 6 });

    await strategy.react(ctx);

    expect(unpairedToolParts(history)).toEqual({ orphanResults: [], orphanCalls: [] });
  });
});

// ─── Facts are carried across the compaction ─────────────────────────────────

describe('LayeredStrategy — facts survive compaction', () => {
  const facts: ExtractedFact[] = [
    { key: 'project.name', value: 'orxa', category: 'identifier' },
    { key: 'deadline', value: '2026-01-31', category: 'date' },
  ];

  it('healthy writes extracted facts into the chat.facts layer and counts them', async () => {
    const tools = recordingTools({ summary: 'gist', facts });
    const { history, ctx } = harness(tenTurns(), tools);
    const strategy = new LayeredStrategy({ recentCount: 4 });

    const decision = await strategy.react(ctx);

    expect(decision).toEqual({
      action: 'compacted',
      note: 'compacted 3 old entries into one summary; 2 facts preserved',
    });
    const layer = history.registry.get(LAYER_CHAT_FACTS);
    expect(layer?.metadata?.facts).toEqual(facts);
    expect(layer?.content).toContain('deadline [date]: 2026-01-31');
  });

  it('no facts extracted → no facts layer is created at all', async () => {
    const tools = recordingTools({ summary: 'gist', facts: [] });
    const { history, ctx } = harness(tenTurns(), tools);
    const strategy = new LayeredStrategy({ recentCount: 4 });

    await strategy.react(ctx);

    expect(history.registry.get(LAYER_CHAT_FACTS)).toBeUndefined();
  });

  it('critical reports the number of facts it preserved', async () => {
    const tools = recordingTools({ summary: 'gist', facts });
    const { history, ctx } = harness(tenTurns(), tools, { level: 'critical' });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    expect(await strategy.react(ctx)).toEqual({
      action: 'compacted',
      note: 'critical: kept last 2, compacted 8, 2 facts preserved',
    });
    expect(history.registry.get(LAYER_CHAT_FACTS)?.metadata?.facts).toEqual(facts);
  });

  it('pressure injects facts from BOTH the old and the middle zone', async () => {
    const tools = recordingTools({ summary: 'gist', facts });
    const { history, ctx, injections } = harness(tenTurns(), tools, { level: 'pressure' });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    await strategy.react(ctx);

    // Each zone is extracted AND injected in its own right — dropping the old
    // zone's injection is invisible in the final layer, because the middle
    // zone writes the same layer name a moment later.
    expect(tools.factCalls).toHaveLength(2);
    expect(injections).toEqual([
      { count: 2, site: 'system-append' },
      { count: 2, site: 'system-append' },
    ]);
    expect(history.registry.get(LAYER_CHAT_FACTS)?.metadata?.facts).toEqual(facts);
  });

  it('urgent extracts and injects each zone before the aggressive pass', async () => {
    const tools = recordingTools({ summary: 'gist', facts });
    const { ctx, injections } = harness(tenTurns(), tools, { level: 'urgent' });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    await strategy.react(ctx);

    // old (400 chars) → middle (300 chars) → merged remainder (400 chars).
    // Collapsing that into a single pass loses the two zone-scoped fact passes.
    expect(tools.summarizeCalls.map((c) => c.maxLength)).toEqual([400, 300, 400]);
    expect(tools.summarizeCalls[0].content).toContain('turn-2');
    expect(tools.summarizeCalls[0].content).not.toContain('turn-3');
    expect(tools.summarizeCalls[1].content).toContain('turn-5');
    expect(injections).toHaveLength(3);
  });
});

// ─── Declining ───────────────────────────────────────────────────────────────

describe('LayeredStrategy — declining', () => {
  it('declines once a retry is still above the decline ceiling', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(tenTurns(), tools, {
      level: 'critical',
      percentage: 0.93,
      attempt: 1,
    });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    const decision = await strategy.react(ctx);

    expect(decision.action).toBe('decline');
    expect((decision as { reason: string }).reason).toBe(
      'Context at 93.0% after 2 compaction attempt(s); unable to fit safely.',
    );
    // Declining must not touch history — the caller decides what happens next.
    expect(history.length).toBe(10);
  });

  it('the first attempt above the ceiling still tries to compact', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(tenTurns(), tools, {
      level: 'critical',
      percentage: 0.99,
      attempt: 0,
    });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    expect((await strategy.react(ctx)).action).toBe('compacted');
    expect(history.length).toBe(3);
  });

  it('a configurable ceiling moves the line', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { ctx } = harness(tenTurns(), tools, {
      level: 'critical',
      percentage: 0.6,
      attempt: 1,
    });
    const strategy = new LayeredStrategy({ recentCount: 4, declineCeiling: 0.5 });

    expect((await strategy.react(ctx)).action).toBe('decline');
  });

  it('critical declines when the new content alone exceeds what compaction can free', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const two: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    const { history, ctx } = harness(two, tools, { level: 'critical', percentage: 0.97 });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    const decision = await strategy.react(ctx);

    expect(decision).toEqual({
      action: 'decline',
      reason:
        'Context at 97.0% with only 2 entries — the new content alone exceeds what compaction can free.',
    });
    expect(history.length).toBe(2);
  });

  it('critical declines when segmentation leaves nothing compactable', async () => {
    // Reachable only through a custom StrategyTools: the strategy takes the
    // segmenter as a dependency, and a segmenter may legitimately hold
    // everything back (e.g. a time-window one where every entry is recent).
    let replaced = 0;
    const everythingIsRecent: StrategyTools = {
      historyLength: 5,
      segment: () => ({ recent: [], middle: [], old: [] }),
      measure: () => 0,
      measureCurrent: () => 0,
      extractFacts: async () => [],
      summarize: async () => '',
      replaceRange: () => {
        replaced++;
      },
      dropOldest: () => {},
      injectFacts: () => {},
    };
    const strategy = new LayeredStrategy({ recentCount: 4 });

    const decision = await strategy.react({
      level: 'critical',
      percentage: 0.96,
      current: 960,
      window: 1000,
      delta: 0,
      provider: 'test',
      model: 'tiny',
      attempt: 0,
      tools: everythingIsRecent,
      state: {},
    });

    expect(decision).toEqual({
      action: 'decline',
      reason: 'Nothing left to compact but still above critical threshold.',
    });
    expect(replaced).toBe(0);
  });
});

// ─── Jump escalation ─────────────────────────────────────────────────────────

describe('LayeredStrategy — jump escalation', () => {
  it('a big single-turn jump escalates healthy to the pressure policy', async () => {
    const tools = recordingTools({ summary: 'gist' });
    // delta 400 of a 1000 window = 0.4 ≥ the 0.3 escalation delta.
    const { history, ctx } = harness(tenTurns(), tools, { level: 'healthy', delta: 400 });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    expect(await strategy.react(ctx)).toEqual({
      action: 'compacted',
      note: 'compacted old + middle layers',
    });
    expect(history.length).toBe(6);
  });

  it('a jump below the delta leaves the level alone', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(tenTurns(), tools, { level: 'healthy', delta: 299 });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    expect(await strategy.react(ctx)).toEqual({
      action: 'compacted',
      note: 'compacted 3 old entries into one summary; 0 facts preserved',
    });
    expect(history.length).toBe(8);
  });

  it('a configurable delta moves the escalation line', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(tenTurns(), tools, { level: 'healthy', delta: 100 });
    const strategy = new LayeredStrategy({ recentCount: 4, jumpEscalateDelta: 0.1 });

    expect(noteOf(await strategy.react(ctx))).toBe('compacted old + middle layers');
    expect(history.length).toBe(6);
  });

  it('the top level cannot escalate past itself', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { ctx } = harness(tenTurns(), tools, { level: 'critical', delta: 900 });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    expect(noteOf(await strategy.react(ctx))).toBe(
      'critical: kept last 2, compacted 8, 0 facts preserved',
    );
  });

  it('a level absent from the trigger ladder is not escalated', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(tenTurns(), tools, { level: 'nonsense', delta: 900 });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    expect(await strategy.react(ctx)).toEqual({ action: 'none' });
    expect(history.length).toBe(10);
  });

  it('an unknown window cannot produce a jump fraction, so no escalation', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(tenTurns(), tools, {
      level: 'healthy',
      window: null,
      delta: 9999,
    });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    expect(noteOf(await strategy.react(ctx))).toBe(
      'compacted 3 old entries into one summary; 0 facts preserved',
    );
    expect(history.length).toBe(8);
  });

  it('a zero window does not divide by zero into an escalation', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(tenTurns(), tools, {
      level: 'healthy',
      window: 0,
      delta: 9999,
    });
    const strategy = new LayeredStrategy({ recentCount: 4 });

    expect(noteOf(await strategy.react(ctx))).toBe(
      'compacted 3 old entries into one summary; 0 facts preserved',
    );
    expect(history.length).toBe(8);
  });

  it('escalates along a custom trigger ladder', async () => {
    const tools = recordingTools({ summary: 'gist' });
    const { history, ctx } = harness(tenTurns(), tools, { level: 'warm', delta: 500 });
    const strategy = new LayeredStrategy({
      recentCount: 4,
      triggers: [
        { level: 'warm', at: 0.4 },
        { level: 'critical', at: 0.9 },
      ],
    });

    expect(strategy.triggers.map((t) => t.level)).toEqual(['warm', 'critical']);
    // warm → critical, skipping the built-in ladder entirely.
    expect(noteOf(await strategy.react(ctx))).toBe(
      'critical: kept last 2, compacted 8, 0 facts preserved',
    );
    expect(history.length).toBe(3);
  });
});

// ─── Defaults ────────────────────────────────────────────────────────────────

describe('LayeredStrategy — defaults', () => {
  it('ships the four-step trigger ladder', () => {
    expect(new LayeredStrategy().triggers).toEqual([
      { level: 'healthy', at: 0.5 },
      { level: 'pressure', at: 0.7 },
      { level: 'urgent', at: 0.85 },
      { level: 'critical', at: 0.95 },
    ]);
  });

  it('keeps six recent entries and asks for a 400-char old-zone summary', async () => {
    const tools = recordingTools({ summary: 'gist' });
    // 13 entries, recentCount 6 → remainder 7 → old = 3, middle = 4. Chosen so
    // that a one-off in the default recentCount changes the old-zone size.
    const thirteen: Message[] = Array.from({ length: 13 }, (_, i) => ({
      role: 'user' as const,
      content: `turn-${i}`,
    }));
    const { history, ctx } = harness(thirteen, tools);

    const decision = await new LayeredStrategy().react(ctx);

    expect(decision).toEqual({
      action: 'compacted',
      note: 'compacted 3 old entries into one summary; 0 facts preserved',
    });
    expect(history.length).toBe(11);
    expect(tools.summarizeCalls[0].maxLength).toBe(400);
    expect(texts(history)[0]).toBe('[Earlier conversation summary]\ngist');
    expect(texts(history)[1]).toBe('turn-3');
  });
});
