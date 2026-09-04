/** StrategyToolsImpl + the marker-bounded facts helpers.
 *
 *  This is the plumbing every ContextStrategy is handed: segmentation, token
 *  measurement, history mutation, and the facts region that has to survive a
 *  compaction. The invariants pinned here are the ones a strategy relies on and
 *  cannot check for itself:
 *
 *    - `replaceRange` / `dropOldest` mutate the ACTIVE message array too. The
 *      request in flight is built from that array; a compaction that only
 *      rewrote history would send the un-compacted messages anyway.
 *    - Facts already on the conversation are fed BACK into extraction, so a
 *      second compaction cannot quietly forget what the first one learned.
 */

import { describe, expect, it } from 'bun:test';
import { ConversationHistory } from '../../../../src/agent/history';
import { HeuristicCounter } from '../../../../src/plugins/context-measurer/counter/heuristic';
import {
  parseFactsBlock,
  readFactsLayer,
  renderFactsBlock,
  renderFactsLayer,
  renderPriorFactsForExtraction,
  StrategyToolsImpl,
  writeFactsBlock,
} from '../../../../src/plugins/context-guard/tools';
import { LAYER_CHAT_FACTS } from '../../../../src/agent/context-registry/layers';
import { ContextRegistry } from '../../../../src/agent/context-registry/registry';
import type { ContextTools } from '../../../../src/plugins/context-guard/types';
import type { ExtractedFact } from '../../../../src/plugins/context-guard/facts';
import type { Message } from '../../../../src/llm/types/messages';

// ─── Harness ─────────────────────────────────────────────────────────────────

interface Calls {
  summarize: Array<{ content: string; maxLength: number; focus?: string }>;
  extract: Array<{ content: string; categories?: string[] }>;
}

function build(
  messages: Message[] = [],
  opts: { summary?: string; facts?: ExtractedFact[] } = {},
): {
  history: ConversationHistory;
  active: Message[];
  tools: StrategyToolsImpl;
  calls: Calls;
} {
  const history = new ConversationHistory();
  for (const m of messages) history.append(m);
  const active = history.messages();
  const calls: Calls = { summarize: [], extract: [] };
  const contextTools: ContextTools = {
    async summarize(content, maxLength, focus) {
      calls.summarize.push({ content, maxLength, focus });
      return opts.summary ?? 'SUMMARY';
    },
    async extractFacts(content, categories) {
      calls.extract.push({ content, categories });
      return opts.facts ?? [];
    },
  };
  const tools = new StrategyToolsImpl({
    history,
    activeMessages: active,
    counter: new HeuristicCounter(null),
    contextTools,
    provider: 'test',
    model: 'tiny',
  });
  return { history, active, tools, calls };
}

function turns(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `turn-${i}`,
  }));
}

const textOf = (m: Message): string =>
  typeof m.content === 'string' ? m.content : JSON.stringify(m.content);

// ─── segment ─────────────────────────────────────────────────────────────────

describe('StrategyToolsImpl — segment', () => {
  it('an empty history has three empty zones, not a thrown error', () => {
    const { tools } = build([]);
    expect(tools.segment({ recentCount: 4 })).toEqual({ recent: [], middle: [], old: [] });
  });

  it('recentCount holds back the tail and halves the rest into old/middle', () => {
    const { tools } = build(turns(10));
    const seg = tools.segment({ recentCount: 4 });
    expect(seg.old.map((e) => textOf(e.message))).toEqual(['turn-0', 'turn-1', 'turn-2']);
    expect(seg.middle.map((e) => textOf(e.message))).toEqual(['turn-3', 'turn-4', 'turn-5']);
    expect(seg.recent.map((e) => textOf(e.message))).toEqual([
      'turn-6',
      'turn-7',
      'turn-8',
      'turn-9',
    ]);
  });

  it('a recentCount larger than the history keeps everything recent', () => {
    const { tools } = build(turns(3));
    const seg = tools.segment({ recentCount: 99 });
    expect(seg.recent).toHaveLength(3);
    expect(seg.old).toHaveLength(0);
    expect(seg.middle).toHaveLength(0);
  });

  it('a zero recentCount falls through to the equal-thirds split', () => {
    const { tools } = build(turns(9));
    const seg = tools.segment({ recentCount: 0 });
    expect(seg.old.map((e) => textOf(e.message))).toEqual(['turn-0', 'turn-1', 'turn-2']);
    expect(seg.middle.map((e) => textOf(e.message))).toEqual(['turn-3', 'turn-4', 'turn-5']);
    expect(seg.recent.map((e) => textOf(e.message))).toEqual(['turn-6', 'turn-7', 'turn-8']);
  });

  it('no options at all is the equal-thirds split, rounding the old zone up', () => {
    const { tools } = build(turns(10));
    const seg = tools.segment();
    // ceil(10/3) = 4 per zone, remainder to recent.
    expect(seg.old).toHaveLength(4);
    expect(seg.middle).toHaveLength(4);
    expect(seg.recent).toHaveLength(2);
  });

  it('timeWindow classifies by entry age: recent / middle / older than 3 windows', () => {
    const { history, tools } = build(turns(3));
    const now = Date.now();
    const entries = history.all() as unknown as Array<{ timestamp: number }>;
    entries[0].timestamp = now - 60_000; // > 3 × 10s → old
    entries[1].timestamp = now - 20_000; // > 10s, < 30s → middle
    entries[2].timestamp = now - 1_000; // < 10s → recent

    const seg = tools.segment({ timeWindow: 10_000 });
    expect(seg.old.map((e) => textOf(e.message))).toEqual(['turn-0']);
    expect(seg.middle.map((e) => textOf(e.message))).toEqual(['turn-1']);
    expect(seg.recent.map((e) => textOf(e.message))).toEqual(['turn-2']);
  });

  it('a zero timeWindow is ignored in favour of the equal-thirds split', () => {
    const { tools } = build(turns(9));
    expect(tools.segment({ timeWindow: 0 }).old).toHaveLength(3);
  });

  it('an odd remainder rounds the OLD zone down, so the middle carries the extra', () => {
    const { tools } = build(turns(9));
    const seg = tools.segment({ recentCount: 4 });
    // remainder is 5 → floor(5/2) = 2 old, 3 middle. Rounding the other way
    // would age an entry into the fact-only zone a turn early.
    expect(seg.old.map((e) => textOf(e.message))).toEqual(['turn-0', 'turn-1']);
    expect(seg.middle.map((e) => textOf(e.message))).toEqual(['turn-2', 'turn-3', 'turn-4']);
  });

  it('segment returns copies — mutating a zone cannot corrupt the history', () => {
    const { history, tools } = build(turns(6));
    const seg = tools.segment({ recentCount: 2 });
    seg.old.length = 0;
    seg.recent.push(seg.middle[0]);
    expect(history.length).toBe(6);
    expect(tools.segment({ recentCount: 2 }).old).toHaveLength(2);
    expect(tools.segment({ recentCount: 2 }).recent).toHaveLength(2);
  });
});

// ─── measure ─────────────────────────────────────────────────────────────────

describe('StrategyToolsImpl — measure', () => {
  it('measures history entries by their messages', () => {
    const { tools, history } = build([{ role: 'user', content: 'x'.repeat(40) }]);
    // 40 chars at the 4-chars-per-token fallback.
    expect(tools.measure(history.all())).toBe(10);
  });

  it('measures a bare Message array too', () => {
    const { tools } = build([]);
    const msgs: Message[] = [
      { role: 'user', content: 'x'.repeat(40) },
      { role: 'assistant', content: 'y'.repeat(80) },
    ];
    expect(tools.measure(msgs)).toBe(30);
  });

  it('an empty list measures zero', () => {
    const { tools } = build([]);
    expect(tools.measure([])).toBe(0);
  });

  it('historyLength tracks the live history', () => {
    const { tools, history } = build(turns(4));
    expect(tools.historyLength).toBe(4);
    history.append({ role: 'user', content: 'more' });
    expect(tools.historyLength).toBe(5);
  });
});

// ─── summarize / extractFacts ────────────────────────────────────────────────

describe('StrategyToolsImpl — summarize', () => {
  it('renders each entry as "[role] text" and forwards the budget and focus', async () => {
    const { tools, history, calls } = build(turns(2));
    const out = await tools.summarize(history.all(), 250, 'decisions');
    expect(out).toBe('SUMMARY');
    expect(calls.summarize).toEqual([
      { content: '[user] turn-0\n\n[assistant] turn-1', maxLength: 250, focus: 'decisions' },
    ]);
  });

  it('flattens tool calls and results into the summarised text', async () => {
    const { tools, history, calls } = build([
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'lookup', arguments: { q: 'x' } }],
      },
      { role: 'tool', content: [{ type: 'tool_result', id: 'c1', content: 'found' }] },
      { role: 'tool', content: [{ type: 'tool_result', id: 'c2', content: [{ type: 'text', text: 'obj' }] }] },
    ]);
    await tools.summarize(history.all(), 100);
    expect(calls.summarize[0].content).toBe(
      '[assistant] [tool_call lookup]({"q":"x"})\n\n[tool] [tool_result] found\n\n' +
        '[tool] [tool_result] [{"type":"text","text":"obj"}]',
    );
  });

  it('drops entries whose content has no text at all', async () => {
    const { tools, history, calls } = build([
      { role: 'user', content: '   ' },
      { role: 'assistant', content: 'kept' },
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'http://x/y.png' } }] },
    ]);
    await tools.summarize(history.all(), 100);
    expect(calls.summarize[0].content).toBe('[assistant] kept');
  });

  it('no entries → empty summary without calling the backend', async () => {
    const { tools, calls } = build(turns(2));
    expect(await tools.summarize([], 100)).toBe('');
    expect(calls.summarize).toHaveLength(0);
  });

  it('entries with only whitespace → empty summary without calling the backend', async () => {
    const { tools, history, calls } = build([{ role: 'user', content: '  \n  ' }]);
    expect(await tools.summarize(history.all(), 100)).toBe('');
    expect(calls.summarize).toHaveLength(0);
  });
});

describe('StrategyToolsImpl — extractFacts', () => {
  it('forwards the concatenated entries and the category filter', async () => {
    const { tools, history, calls } = build(turns(2));
    await tools.extractFacts(history.all(), ['date', 'name']);
    expect(calls.extract).toEqual([
      { content: '[user] turn-0\n\n[assistant] turn-1', categories: ['date', 'name'] },
    ]);
  });

  it('nothing to extract from and no prior facts → no backend call at all', async () => {
    const { tools, calls } = build(turns(2));
    expect(await tools.extractFacts([])).toEqual([]);
    expect(calls.extract).toHaveLength(0);
  });

  it('carries facts already in the registry layer forward into the next extraction', async () => {
    const { tools, history, calls } = build(turns(2));
    history.registry.set(LAYER_CHAT_FACTS, 'ignored-text', {
      metadata: { facts: [{ key: 'city', value: 'Prague', category: 'name' }] },
    });

    await tools.extractFacts(history.all());

    const sent = calls.extract[0].content;
    expect(sent).toContain('Previously extracted facts');
    expect(sent).toContain('- city (name): Prague');
    expect(sent).toContain('---');
    expect(sent).toContain('[user] turn-0');
  });

  it('prior facts alone are enough to run an extraction on an empty range', async () => {
    const { tools, history, calls } = build(turns(2));
    history.registry.set(LAYER_CHAT_FACTS, 'x', {
      metadata: { facts: [{ key: 'city', value: 'Prague', category: 'name' }] },
    });

    await tools.extractFacts([]);

    expect(calls.extract).toHaveLength(1);
    expect(calls.extract[0].content).toContain('- city (name): Prague');
    expect(calls.extract[0].content).not.toContain('---');
  });

  it('falls back to the marker-bounded block in the system prompt when no layer exists', async () => {
    const { tools, history, calls } = build(turns(1));
    history.system = writeFactsBlock('You are helpful.', [
      { key: 'user.name', value: 'Alex', category: 'name' },
    ]);

    await tools.extractFacts(history.all());

    expect(calls.extract[0].content).toContain('- user.name (name): Alex');
  });
});

// ─── replaceRange / dropOldest ───────────────────────────────────────────────

describe('StrategyToolsImpl — history mutation reaches the active request', () => {
  it('replaceRange rewrites BOTH history and the in-flight message array', () => {
    const { tools, history, active } = build(turns(6));
    expect(active).toHaveLength(6);

    tools.replaceRange(0, 4, { role: 'user', content: 'SUMMARY' });

    expect(history.messages().map(textOf)).toEqual(['SUMMARY', 'turn-4', 'turn-5']);
    // Same array object the caller holds — not a replacement array.
    expect(active.map(textOf)).toEqual(['SUMMARY', 'turn-4', 'turn-5']);
  });

  it('dropOldest keeps the tail and rebuilds the active array', () => {
    const { tools, history, active } = build(turns(6));
    tools.dropOldest(4);
    expect(history.messages().map(textOf)).toEqual(['turn-4', 'turn-5']);
    expect(active.map(textOf)).toEqual(['turn-4', 'turn-5']);
  });

  it('dropOldest of everything clears the conversation', () => {
    const { tools, history, active } = build(turns(3));
    tools.dropOldest(3);
    expect(history.length).toBe(0);
    expect(active).toHaveLength(0);
  });

  it('dropOldest of more than there is clears rather than throwing', () => {
    const { tools, history } = build(turns(3));
    tools.dropOldest(99);
    expect(history.length).toBe(0);
  });

  it('dropOldest(0) and negative counts are no-ops', () => {
    const { tools, history, active } = build(turns(3));
    tools.dropOldest(0);
    tools.dropOldest(-2);
    expect(history.length).toBe(3);
    expect(active).toHaveLength(3);
  });
});

// ─── injectFacts ─────────────────────────────────────────────────────────────

describe('StrategyToolsImpl — injectFacts', () => {
  const facts: ExtractedFact[] = [
    { key: 'zulu', value: 'last', category: 'other' },
    { key: 'alpha', value: 'first', category: 'name' },
  ];

  it('system-append writes a sorted, owned chat.facts layer carrying the raw facts', () => {
    const { tools, history } = build(turns(2));
    tools.injectFacts(facts, 'system-append');

    const layer = history.registry.get(LAYER_CHAT_FACTS);
    expect(layer?.owner).toBe('context-guard');
    expect(layer?.metadata?.facts).toEqual(facts);
    expect(layer?.content).toBe(
      '## Key facts (preserved across compaction)\n' +
        '- alpha [name]: first\n' +
        '- zulu [other]: last',
    );
    // Tagged 'system' so it renders into the system prompt.
    expect(history.system).toContain('- alpha [name]: first');
  });

  it('an empty fact list writes nothing', () => {
    const { tools, history } = build(turns(2));
    tools.injectFacts([], 'system-append');
    expect(history.registry.get(LAYER_CHAT_FACTS)).toBeUndefined();
  });

  it('first-user-prefix prepends a bare block to the first user message', () => {
    const { tools, history, active } = build([
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'question' },
      { role: 'user', content: 'second question' },
    ]);

    tools.injectFacts(facts, 'first-user-prefix');

    expect(active[1].content).toBe(
      '## Key facts (preserved across compaction)\n' +
        '- alpha [name]: first\n' +
        '- zulu [other]: last\n\nquestion',
    );
    // No markers on the bare block, and no registry layer either.
    expect(active[1].content).not.toContain('<!-- orxa:facts -->');
    expect(history.registry.get(LAYER_CHAT_FACTS)).toBeUndefined();
    // The later user turn is untouched.
    expect(active[2].content).toBe('second question');
    // History and the active array stay in sync.
    expect(history.messages()[1].content).toBe(active[1].content);
  });

  it('first-user-prefix edits the first TEXT part of a multi-part user message', () => {
    const { tools, active } = build([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: 'http://x/y.png' } },
          { type: 'text', text: 'describe it' },
        ],
      },
    ]);

    tools.injectFacts(facts, 'first-user-prefix');

    const parts = active[0].content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe('image');
    expect(parts[1].text).toContain('Key facts');
    expect(parts[1].text?.endsWith('describe it')).toBe(true);
  });

  it('first-user-prefix prepends a new text part when there is none', () => {
    const { tools, active } = build([
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'http://x/y.png' } }] },
    ]);

    tools.injectFacts(facts, 'first-user-prefix');

    const parts = active[0].content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('- alpha [name]: first');
    expect(parts[1].type).toBe('image');
  });

  it('first-user-prefix is a no-op when the conversation has no user turn', () => {
    const { tools, active } = build([{ role: 'assistant', content: 'only me' }]);
    tools.injectFacts(facts, 'first-user-prefix');
    expect(active[0].content).toBe('only me');
  });
});

// ─── Facts rendering / parsing helpers ───────────────────────────────────────

const twoFacts: ExtractedFact[] = [
  { key: 'zulu', value: 'z', category: 'other' },
  { key: 'alpha', value: 'a', category: 'name' },
];

describe('facts block rendering', () => {
  it('renderFactsBlock wraps a sorted list in the orxa:facts markers', () => {
    expect(renderFactsBlock(twoFacts)).toBe(
      '<!-- orxa:facts -->\n' +
        '## Key facts (preserved across compaction)\n' +
        '- alpha [name]: a\n' +
        '- zulu [other]: z\n' +
        '<!-- /orxa:facts -->',
    );
  });

  it('renderFactsBlock({ bareBlock: true }) drops the markers', () => {
    const bare = renderFactsBlock(twoFacts, { bareBlock: true });
    expect(bare).not.toContain('<!--');
    expect(bare.split('\n')).toEqual([
      '## Key facts (preserved across compaction)',
      '- alpha [name]: a',
      '- zulu [other]: z',
    ]);
  });

  it('renderFactsBlock does not reorder the caller\'s array', () => {
    const input = [...twoFacts];
    renderFactsBlock(input);
    expect(input[0].key).toBe('zulu');
  });

  it('renderFactsLayer is the bare block — the layer supplies its own framing', () => {
    expect(renderFactsLayer(twoFacts)).toBe(renderFactsBlock(twoFacts, { bareBlock: true }));
  });

  it('orders keys the same way on every host, not by the host locale', () => {
    // localeCompare with no locale argument reads the HOST's locale: under
    // sv-SE or tr-TR 'ünique' sorts after 'user_name' instead of beside
    // 'unique'. This block is rendered into a system prompt, so a locale-
    // dependent order means the same facts produce different prompt bytes on
    // different machines -- a different prefix, so the provider's prompt cache
    // misses on a prompt that should have been identical.
    const mixed: ExtractedFact[] = [
      { key: 'ünique', value: '1', category: 'other' },
      { key: 'user_name', value: '2', category: 'name' },
      { key: 'Account', value: '3', category: 'other' },
      { key: 'account', value: '4', category: 'other' },
    ];
    expect(renderFactsLayer(mixed).split('\n').slice(1)).toEqual([
      '- Account [other]: 3',
      '- account [other]: 4',
      '- user_name [name]: 2',
      '- ünique [other]: 1',
    ]);
  });

  it('renderPriorFactsForExtraction labels facts as carry-forward material', () => {
    expect(renderPriorFactsForExtraction(twoFacts)).toBe(
      '## Previously extracted facts (carry forward; merge with the new content below)\n' +
        '- zulu (other): z\n' +
        '- alpha (name): a',
    );
  });

  it('renderPriorFactsForExtraction of nothing is the empty string, not a lone header', () => {
    expect(renderPriorFactsForExtraction([])).toBe('');
  });
});

describe('readFactsLayer', () => {
  it('returns null when the layer was never written — distinct from "no facts"', () => {
    expect(readFactsLayer(new ContextRegistry())).toBeNull();
  });

  it('prefers the structured facts stored in layer metadata', () => {
    const reg = new ContextRegistry();
    reg.set(LAYER_CHAT_FACTS, 'text that disagrees', { metadata: { facts: twoFacts } });
    expect(readFactsLayer(reg)).toEqual(twoFacts);
  });

  it('parses the rendered text back to facts when metadata is absent', () => {
    const reg = new ContextRegistry();
    reg.set(LAYER_CHAT_FACTS, renderFactsLayer(twoFacts));
    expect(readFactsLayer(reg)).toEqual([
      { key: 'alpha', category: 'name', value: 'a' },
      { key: 'zulu', category: 'other', value: 'z' },
    ]);
  });

  it('skips lines that are not fact lines', () => {
    const reg = new ContextRegistry();
    reg.set(
      LAYER_CHAT_FACTS,
      ['## Key facts', 'prose line', '- malformed line', '- ok [name]: value'].join('\n'),
    );
    expect(readFactsLayer(reg)).toEqual([{ key: 'ok', category: 'name', value: 'value' }]);
  });

  it('a non-text layer yields an empty list — not null, and not a crash', () => {
    const reg = new ContextRegistry();
    reg.set(LAYER_CHAT_FACTS, [{ type: 'text', text: '- a [name]: b' }]);
    const out = readFactsLayer(reg);
    // null means "no layer, look in the system prompt instead"; the layer
    // exists here, it just holds parts, so the answer is "no facts".
    expect(out).not.toBeNull();
    expect(out).toEqual([]);
  });
});

describe('parseFactsBlock', () => {
  it('narrows a category the union does not contain to other', () => {
    // The category is read back out of a system prompt, so it carries whatever
    // a model wrote there rather than something we chose. Casting it into
    // FactCategory would type a value the union does not contain and hand every
    // consumer that switches on it a branch it believes cannot occur.
    const block =
      '<!-- orxa:facts -->\n' +
      '## Key facts (preserved across compaction)\n' +
      '- zip [location]: 10115\n' +
      '- who [name]: ada\n' +
      '- hack [ignore previous instructions]: x\n' +
      '<!-- /orxa:facts -->';
    expect(parseFactsBlock(block)).toEqual([
      { key: 'zip', category: 'other', value: '10115' },
      { key: 'who', category: 'name', value: 'ada' },
      { key: 'hack', category: 'other', value: 'x' },
    ]);
  });

  it('reads back exactly what renderFactsBlock wrote', () => {
    expect(parseFactsBlock(`intro\n${renderFactsBlock(twoFacts)}\noutro`)).toEqual([
      { key: 'alpha', category: 'name', value: 'a' },
      { key: 'zulu', category: 'other', value: 'z' },
    ]);
  });

  it('no opening marker → no facts', () => {
    expect(parseFactsBlock('just a system prompt')).toEqual([]);
  });

  it('a closing marker with no opening one reads nothing, not the whole prompt', () => {
    // Otherwise unrelated prose that happens to look like a bullet list gets
    // promoted to facts because the region was never actually opened.
    const system = `${'x'.repeat(40)}\n- alpha [name]: a\n<!-- /orxa:facts -->`;
    expect(parseFactsBlock(system)).toEqual([]);
  });

  it('an unterminated block yields no facts rather than reading to the end', () => {
    expect(parseFactsBlock('<!-- orxa:facts -->\n- alpha [name]: a')).toEqual([]);
  });

  it('ignores prose and malformed bullets inside the block', () => {
    const system = [
      '<!-- orxa:facts -->',
      '## Key facts (preserved across compaction)',
      'a prose line',
      '- no category here',
      '- good [date]: 2026-01-01',
      '<!-- /orxa:facts -->',
    ].join('\n');
    expect(parseFactsBlock(system)).toEqual([
      { key: 'good', category: 'date', value: '2026-01-01' },
    ]);
  });
});

describe('writeFactsBlock', () => {
  it('appends a fresh block to an existing system prompt', () => {
    const out = writeFactsBlock('You are helpful.', twoFacts);
    expect(out.startsWith('You are helpful.\n\n<!-- orxa:facts -->')).toBe(true);
    expect(parseFactsBlock(out)).toHaveLength(2);
  });

  it('an empty system prompt becomes just the block, with no leading blank lines', () => {
    expect(writeFactsBlock('', twoFacts)).toBe(renderFactsBlock(twoFacts));
  });

  it('replaces an existing block in place, keeping the text on both sides', () => {
    const first = writeFactsBlock('before', [{ key: 'a', value: '1', category: 'number' }]);
    const withTail = `${first}\nafter`;
    const second = writeFactsBlock(withTail, twoFacts);

    expect(second.startsWith('before\n\n')).toBe(true);
    expect(second.endsWith('\nafter')).toBe(true);
    expect(parseFactsBlock(second).map((f) => f.key)).toEqual(['alpha', 'zulu']);
    // The stale fact is gone — replaced, not accumulated.
    expect(second).not.toContain('- a [number]: 1');
    // Exactly one block.
    expect(second.split('<!-- orxa:facts -->')).toHaveLength(2);
  });

  it('a block opened but never closed is truncated at the marker and rewritten', () => {
    const out = writeFactsBlock('before\n<!-- orxa:facts -->\ncorrupted tail', twoFacts);
    expect(out).toBe(`before\n${renderFactsBlock(twoFacts)}`);
    expect(out).not.toContain('corrupted tail');
  });

  it('round-trips through parseFactsBlock repeatedly without drift', () => {
    let system = 'base';
    for (let i = 0; i < 3; i++) {
      system = writeFactsBlock(system, [{ key: `k${i}`, value: `v${i}`, category: 'other' }]);
    }
    expect(parseFactsBlock(system)).toEqual([{ key: 'k2', category: 'other', value: 'v2' }]);
  });
});
