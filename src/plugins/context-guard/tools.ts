/** StrategyToolsImpl — plumbing the guard provides to each strategy.
 *  Wraps history mutation, token measurement, summarize/fact-extract calls,
 *  and fact injection so policy code stays short. */

import type { Message, ContentPart } from '../../llm/types/messages';
import type { TokenCounter } from '../../agent/types';
import type { ConversationHistory } from '../../agent/history';
import type { HistoryEntry } from '../../agent/history-types';
import type { ContextRegistry } from '../../agent/context-registry/registry';
import { LAYER_CHAT_FACTS, PRIORITY_CHAT_FACTS } from '../../agent/context-registry/layers';
import type { ExtractedFact } from './facts';
import type { ContextTools, FactInjectionSite, StrategyTools } from './types';

export interface StrategyToolsDeps {
  history: ConversationHistory;
  /** Active messages array — mutated in place when replaceRange/dropOldest
   *  fire so the current request reflects the compaction. */
  activeMessages: Message[];
  counter: TokenCounter;
  contextTools: ContextTools;
  provider: string;
  model: string;
}

export class StrategyToolsImpl implements StrategyTools {
  constructor(private readonly deps: StrategyToolsDeps) {}

  get historyLength(): number {
    return this.deps.history.all().length;
  }

  segment(opts?: { recentCount?: number; timeWindow?: number }): {
    recent: HistoryEntry[];
    middle: HistoryEntry[];
    old: HistoryEntry[];
  } {
    const entries = this.deps.history.all().slice();
    if (entries.length === 0) {
      return { recent: [], middle: [], old: [] };
    }

    const recentCount = opts?.recentCount;
    const timeWindow = opts?.timeWindow;

    if (typeof recentCount === 'number' && recentCount > 0) {
      const recentStart = Math.max(0, entries.length - recentCount);
      const recent = entries.slice(recentStart);
      const remainder = entries.slice(0, recentStart);
      const midPoint = Math.floor(remainder.length / 2);
      return {
        old: remainder.slice(0, midPoint),
        middle: remainder.slice(midPoint),
        recent,
      };
    }

    if (typeof timeWindow === 'number' && timeWindow > 0) {
      const now = Date.now();
      const cutoffRecent = now - timeWindow;
      const cutoffOld = now - timeWindow * 3;
      const old: HistoryEntry[] = [];
      const middle: HistoryEntry[] = [];
      const recent: HistoryEntry[] = [];
      for (const e of entries) {
        if (e.timestamp < cutoffOld) old.push(e);
        else if (e.timestamp < cutoffRecent) middle.push(e);
        else recent.push(e);
      }
      return { old, middle, recent };
    }

    const third = Math.ceil(entries.length / 3);
    return {
      old: entries.slice(0, third),
      middle: entries.slice(third, 2 * third),
      recent: entries.slice(2 * third),
    };
  }

  measure(items: readonly HistoryEntry[] | Message[]): number {
    const ctx = { provider: this.deps.provider, model: this.deps.model };
    let total = 0;
    for (const item of items) {
      const msg = 'message' in item ? (item as HistoryEntry).message : (item as Message);
      total += this.deps.counter.estimateMessage(msg, ctx);
    }
    return total;
  }

  async extractFacts(
    entries: readonly HistoryEntry[],
    categories?: string[],
  ): Promise<ExtractedFact[]> {
    const priorFacts =
      readFactsLayer(this.deps.history.registry) ?? parseFactsBlock(this.deps.history.system ?? '');
    const contentFromEntries = entries.length === 0 ? '' : this.concatContent(entries);

    if (contentFromEntries.trim().length === 0 && priorFacts.length === 0) {
      return [];
    }

    const priorBlock = priorFacts.length > 0 ? renderPriorFactsForExtraction(priorFacts) : '';
    const content =
      priorBlock && contentFromEntries
        ? `${priorBlock}\n\n---\n\n${contentFromEntries}`
        : priorBlock || contentFromEntries;

    return this.deps.contextTools.extractFacts(content, categories);
  }

  async summarize(
    entries: readonly HistoryEntry[],
    maxLength: number,
    focus?: string,
  ): Promise<string> {
    if (entries.length === 0) return '';
    const content = this.concatContent(entries);
    if (content.trim().length === 0) return '';
    return this.deps.contextTools.summarize(content, maxLength, focus);
  }

  replaceRange(from: number, to: number, replacement: Message): void {
    this.deps.history.spliceRange(from, to, replacement);
    const rebuilt = this.deps.history.messages();
    this.deps.activeMessages.length = 0;
    this.deps.activeMessages.push(...rebuilt);
  }

  dropOldest(n: number): void {
    if (n <= 0) return;
    const total = this.deps.history.length;
    if (n >= total) {
      this.deps.history.clear();
    } else {
      this.deps.history.truncate(total - n);
    }
    const rebuilt = this.deps.history.messages();
    this.deps.activeMessages.length = 0;
    this.deps.activeMessages.push(...rebuilt);
  }

  injectFacts(facts: ExtractedFact[], site: FactInjectionSite): void {
    if (facts.length === 0) return;

    if (site === 'system-append') {
      this.deps.history.registry.set(LAYER_CHAT_FACTS, renderFactsLayer(facts), {
        priority: PRIORITY_CHAT_FACTS,
        tags: ['system'],
        owner: 'context-guard',
        mergeParent: true,
        metadata: { facts },
      });
      return;
    }

    const block = renderFactsBlock(facts, { bareBlock: true });
    const messages = this.deps.activeMessages;
    const firstUserIdx = messages.findIndex((m) => m.role === 'user');
    if (firstUserIdx === -1) return;
    const msg = messages[firstUserIdx];
    messages[firstUserIdx] = {
      ...msg,
      content: this.prependText(msg.content, `${block}\n\n`),
    } as Message;
    const entries = this.deps.history.all();
    const entry = entries.find((e) => e.message.role === 'user');
    if (entry) {
      (entry as { message: Message }).message = messages[firstUserIdx];
    }
  }

  private concatContent(entries: readonly HistoryEntry[]): string {
    const parts: string[] = [];
    for (const e of entries) {
      const role = e.message.role;
      const text = this.contentToPlainText(e.message.content);
      if (text.trim().length === 0) continue;
      parts.push(`[${role}] ${text}`);
    }
    return parts.join('\n\n');
  }

  private contentToPlainText(content: string | ContentPart[]): string {
    if (typeof content === 'string') return content;
    const parts: string[] = [];
    for (const p of content) {
      if (p.type === 'text') parts.push(p.text);
      else if (p.type === 'tool_call')
        parts.push(`[tool_call ${p.name}](${JSON.stringify(p.arguments)})`);
      else if (p.type === 'tool_result') {
        const c = typeof p.content === 'string' ? p.content : JSON.stringify(p.content);
        parts.push(`[tool_result] ${c}`);
      }
    }
    return parts.join('\n');
  }

  private prependText(content: string | ContentPart[], prefix: string): string | ContentPart[] {
    if (typeof content === 'string') return prefix + content;
    const idx = content.findIndex((p) => p.type === 'text');
    if (idx >= 0) {
      const parts = [...content];
      const original = parts[idx] as { type: 'text'; text: string };
      parts[idx] = { type: 'text', text: prefix + original.text };
      return parts;
    }
    return [{ type: 'text', text: prefix }, ...content];
  }
}

// ─── Marker-bounded facts region (module-level helpers) ────────────────────

const FACTS_OPEN = '<!-- orxa:facts -->';
const FACTS_CLOSE = '<!-- /orxa:facts -->';
const FACTS_HEADER = '## Key facts (preserved across compaction)';

export function renderFactsBlock(
  facts: ExtractedFact[],
  opts: { bareBlock?: boolean } = {},
): string {
  const sorted = [...facts].sort((a, b) => a.key.localeCompare(b.key));
  const lines = [FACTS_HEADER];
  for (const f of sorted) {
    lines.push(`- ${f.key} [${f.category}]: ${f.value}`);
  }
  const body = lines.join('\n');
  if (opts.bareBlock) return body;
  return `${FACTS_OPEN}\n${body}\n${FACTS_CLOSE}`;
}

export function renderFactsLayer(facts: ExtractedFact[]): string {
  const sorted = [...facts].sort((a, b) => a.key.localeCompare(b.key));
  const lines = [FACTS_HEADER];
  for (const f of sorted) {
    lines.push(`- ${f.key} [${f.category}]: ${f.value}`);
  }
  return lines.join('\n');
}

export function readFactsLayer(registry: ContextRegistry): ExtractedFact[] | null {
  const layer = registry.get(LAYER_CHAT_FACTS);
  if (!layer) return null;
  const meta = layer.metadata;
  if (meta && Array.isArray(meta.facts)) {
    return meta.facts as ExtractedFact[];
  }
  if (typeof layer.content === 'string') {
    return parseFactsLayerText(layer.content);
  }
  return [];
}

function parseFactsLayerText(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const lineRe = /^-\s+(\S.*?)\s+\[([^\]]+)\]:\s+(.+)$/;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    const m = line.match(lineRe);
    if (!m) continue;
    facts.push({
      key: m[1],
      category: m[2] as ExtractedFact['category'],
      value: m[3],
    });
  }
  return facts;
}

export function parseFactsBlock(system: string): ExtractedFact[] {
  const openIdx = system.indexOf(FACTS_OPEN);
  if (openIdx < 0) return [];
  const closeIdx = system.indexOf(FACTS_CLOSE, openIdx + FACTS_OPEN.length);
  if (closeIdx < 0) return [];
  const inner = system.slice(openIdx + FACTS_OPEN.length, closeIdx);
  const facts: ExtractedFact[] = [];
  const lineRe = /^-\s+(\S.*?)\s+\[([^\]]+)\]:\s+(.+)$/;
  for (const rawLine of inner.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    const m = line.match(lineRe);
    if (!m) continue;
    facts.push({
      key: m[1],
      category: m[2] as ExtractedFact['category'],
      value: m[3],
    });
  }
  return facts;
}

export function writeFactsBlock(system: string, facts: ExtractedFact[]): string {
  const block = renderFactsBlock(facts);
  const openIdx = system.indexOf(FACTS_OPEN);
  if (openIdx < 0) {
    return system.length > 0 ? `${system}\n\n${block}` : block;
  }
  const closeIdx = system.indexOf(FACTS_CLOSE, openIdx + FACTS_OPEN.length);
  if (closeIdx < 0) {
    return system.slice(0, openIdx) + block;
  }
  const before = system.slice(0, openIdx);
  const after = system.slice(closeIdx + FACTS_CLOSE.length);
  return before + block + after;
}

export function renderPriorFactsForExtraction(facts: ExtractedFact[]): string {
  if (facts.length === 0) return '';
  const lines = ['## Previously extracted facts (carry forward; merge with the new content below)'];
  for (const f of facts) {
    lines.push(`- ${f.key} (${f.category}): ${f.value}`);
  }
  return lines.join('\n');
}
