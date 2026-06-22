/** ConversationHistory — traversable, exportable, importable.
 *  This is the canonical source of truth for any conversation. */

import type { Content, Message } from '../llm/types/messages';
import { emptyUsage, type Usage } from '../llm/types/response';
import { ContextRegistry } from './context-registry/registry';
import type {
  ConversationHistoryConfig,
  HistoryEntry,
  HistorySnapshot,
} from './history-types';
import type { TokenCounter } from './types';

/** Name of the layer used by the legacy `history.system` setter. */
const LEGACY_SYSTEM_LAYER = '_legacy_system';

export class ConversationHistory {
  private entries: HistoryEntry[] = [];
  private _id: string;
  private _metadata: Record<string, unknown> = {};
  private _createdAt: number;
  private _updatedAt: number;

  /** Layered context storage. Contributors (ContextGuard, memory manager,
   *  RAG, user) write named layers here. `history.system` getter/setter is a
   *  thin shim over `registry.set(LEGACY_SYSTEM_LAYER, ...)` for backward compat. */
  readonly registry: ContextRegistry;

  /** Provider-reported exact input-token count from the last completion (includes system + all prior messages up to that point). */
  private _lastActualTotal = 0;
  /** Index of the last entry that was included in _lastActualTotal. Entries after this index are "pending" and estimated. */
  private _lastActualEntryIndex = -1;

  private _counter: TokenCounter | null;
  private _provider: string | undefined;
  private _model: string | undefined;

  constructor(idOrConfig?: string | ConversationHistoryConfig) {
    if (typeof idOrConfig === 'string' || idOrConfig === undefined) {
      this._id = idOrConfig ?? crypto.randomUUID();
      this._counter = null;
    } else {
      this._id = idOrConfig.id ?? crypto.randomUUID();
      this._counter = idOrConfig.counter ?? null;
      this._provider = idOrConfig.provider;
      this._model = idOrConfig.model;
      if (idOrConfig.strategy !== undefined) {
        this._metadata.contextStrategy = idOrConfig.strategy;
      }
    }
    this._createdAt = Date.now();
    this._updatedAt = this._createdAt;
    this.registry = new ContextRegistry({
      id: `history-${this._id.slice(0, 8)}`,
      counter: this._counter ?? undefined,
      defaultOwner: 'history',
    });
  }

  /** Get the last provider-reported exact input token count. */
  get lastActualTotal(): number {
    return this._lastActualTotal;
  }

  /**
   * Record the actual input token count reported by a provider for a request.
   *
   * Call this BEFORE appending the response. The input tokens describe the state
   * of history that was sent — which is what's currently in history before the
   * response is added.
   *
   * Note: normally this is automatic. When you call `append()` with an assistant
   * message carrying `usage.inputTokens`, this is invoked internally.
   */
  recordActualUsage(inputTokens: number): void {
    this._lastActualTotal = inputTokens;
    this._lastActualEntryIndex = this.entries.length - 1;
    this._updatedAt = Date.now();
  }

  get id(): string {
    return this._id;
  }
  get length(): number {
    return this.entries.length;
  }

  /** Legacy system-prompt accessor — reads all 'system'-tagged layers in the
   *  registry. For the common case of a single system prompt, this returns
   *  the same string that was set via the setter. When other contributors
   *  (ContextGuard, memory manager) have added more 'system'-tagged layers,
   *  the returned string is their composed output. */
  get system(): string | undefined {
    const flat = this.registry.flat({ tag: 'system', includeParent: false });
    return flat.length > 0 ? flat : undefined;
  }

  /** Legacy setter — writes to the `_legacy_system` layer tagged 'system'.
   *  Priority 200 (in the "dynamic contributor" zone). Historically this field
   *  was used for content that changes during conversation (ContextGuard facts),
   *  so it renders AFTER stable prefix layers (agent role @10, context @100)
   *  for prompt-cache friendliness. Pass undefined to remove the layer. */
  set system(value: string | undefined) {
    if (value === undefined || value === '') {
      this.registry.remove(LEGACY_SYSTEM_LAYER);
    } else {
      this.registry.set(LEGACY_SYSTEM_LAYER, value, {
        priority: 200,
        tags: ['system'],
        owner: 'history.system-setter',
      });
    }
    this._updatedAt = Date.now();
  }

  get metadata(): Record<string, unknown> {
    return this._metadata;
  }

  setMetadata(key: string, value: unknown): void {
    this._metadata[key] = value;
    this._updatedAt = Date.now();
  }

  /** Add a message to history */
  append(
    message: Message,
    meta?: { model?: string; usage?: Usage; latencyMs?: number },
  ): HistoryEntry {
    // If this is an assistant response with provider-reported inputTokens, it tells us
    // the exact token count of the request that produced it — which was all messages
    // currently in history (before this response is appended).
    if (message.role === 'assistant' && meta?.usage && meta.usage.inputTokens > 0) {
      this._lastActualTotal = meta.usage.inputTokens;
      this._lastActualEntryIndex = this.entries.length - 1; // before this append
    }

    // tokenEstimate: use exact outputTokens for assistant response, else estimate
    let tokenEstimate: number;
    if (message.role === 'assistant' && meta?.usage?.outputTokens) {
      tokenEstimate = meta.usage.outputTokens;
    } else {
      tokenEstimate = this.estimateTokensForMessage(message);
    }

    const entry: HistoryEntry = {
      index: this.entries.length,
      message,
      timestamp: Date.now(),
      model: meta?.model,
      usage: meta?.usage,
      latencyMs: meta?.latencyMs,
      tokenEstimate,
    };
    this.entries.push(entry);
    this._updatedAt = Date.now();
    return entry;
  }

  /** Get all messages (for building request) */
  messages(): Message[] {
    return this.entries.map((e) => e.message);
  }

  /** Get messages as entries (with metadata) */
  all(): readonly HistoryEntry[] {
    return this.entries;
  }

  /** Get entry by index */
  at(index: number): HistoryEntry | undefined {
    let i = index;
    if (i < 0) i = this.entries.length + i;
    return this.entries[i];
  }

  /** Get last N entries */
  last(n: number): HistoryEntry[] {
    return this.entries.slice(-n);
  }

  /** Get last N messages */
  lastMessages(n: number): Message[] {
    return this.entries.slice(-n).map((e) => e.message);
  }

  /** Find entries matching a predicate */
  filter(fn: (entry: HistoryEntry) => boolean): HistoryEntry[] {
    return this.entries.filter(fn);
  }

  /** Get entries by role */
  byRole(role: Message['role']): HistoryEntry[] {
    return this.entries.filter((e) => e.message.role === role);
  }

  /** Iterate entries */
  [Symbol.iterator](): Iterator<HistoryEntry> {
    return this.entries[Symbol.iterator]();
  }

  /** Cumulative usage across all turns */
  totalUsage(): Usage {
    const total = emptyUsage();
    for (const entry of this.entries) {
      if (!entry.usage) continue;
      total.inputTokens += entry.usage.inputTokens;
      total.outputTokens += entry.usage.outputTokens;
      total.totalTokens += entry.usage.totalTokens;
      total.cachedTokens += entry.usage.cachedTokens;
      total.cacheWriteTokens += entry.usage.cacheWriteTokens;
      total.reasoningTokens += entry.usage.reasoningTokens;
    }
    return total;
  }

  /**
   * Estimated total input tokens for the next request.
   *
   * Uses a hybrid: exact count for entries already sent (from last response's usage)
   * plus estimate of entries added since. Accurate because only the delta is estimated.
   *
   * If no actual usage has been recorded yet (fresh history), estimates everything.
   */
  estimatedTokens(): number {
    // If we have an actual count for entries [0..lastActualEntryIndex], use it
    // and only estimate entries added since.
    if (this._lastActualEntryIndex >= 0 && this._lastActualEntryIndex < this.entries.length) {
      let total = this._lastActualTotal;
      for (let i = this._lastActualEntryIndex + 1; i < this.entries.length; i++) {
        const e = this.entries[i];
        total += e.tokenEstimate ?? this.estimateTokensForMessage(e.message);
      }
      return total;
    }

    // No actual data yet — estimate everything from scratch
    let total = 0;
    const systemText = this.system;
    if (systemText) total += this.estimateTokens(systemText);
    for (const entry of this.entries) {
      total += entry.tokenEstimate ?? this.estimateTokensForMessage(entry.message);
    }
    return total;
  }

  private estimateTokensForMessage(msg: Message): number {
    if (this._counter && this._provider && this._model) {
      return this._counter.estimateMessage(msg, { provider: this._provider, model: this._model });
    }
    return this.estimateTokens(msg.content);
  }

  /** Clear all history */
  clear(): void {
    this.entries = [];
    this._updatedAt = Date.now();
  }

  /** Truncate to last N entries */
  truncate(keepLast: number): HistoryEntry[] {
    if (keepLast >= this.entries.length) return [];
    const removed = this.entries.splice(0, this.entries.length - keepLast);
    this.entries.forEach((e, i) => {
      e.index = i;
    });
    this._updatedAt = Date.now();
    return removed;
  }

  /** Replace entries in [from, to) with a single synthetic message.
   *  Used by ContextGuard when compacting a range into a summary entry.
   *  - from, to are inclusive-exclusive indices against current entries (0-based).
   *  - replacement becomes a new HistoryEntry with timestamp = max timestamp in
   *    the replaced range (preserves chronological order).
   *  Returns the removed entries. Entry indices past `to` shift down. */
  spliceRange(from: number, to: number, replacement: Message): HistoryEntry[] {
    if (from < 0 || to > this.entries.length || from >= to) {
      return [];
    }
    const removed = this.entries.slice(from, to);
    const timestamp = removed.reduce((t, e) => Math.max(t, e.timestamp), 0) || Date.now();
    const replacementEntry: HistoryEntry = {
      index: from,
      message: replacement,
      timestamp,
    };
    this.entries.splice(from, to - from, replacementEntry);
    this.entries.forEach((e, i) => {
      e.index = i;
    });
    // The provider-reported token count is invalidated — the range we replaced
    // no longer matches what the model last saw. Reset to 0 so next recordActualUsage
    // re-anchors.
    if (this._lastActualEntryIndex >= from) {
      this._lastActualTotal = 0;
      this._lastActualEntryIndex = -1;
    }
    this._updatedAt = Date.now();
    return removed;
  }

  /** Append text to the legacy system layer. Preserves backward-compat
   *  semantics; new code should write named registry layers directly. */
  appendSystem(text: string): void {
    const current = this.registry.get(LEGACY_SYSTEM_LAYER);
    const prior = current && typeof current.content === 'string' ? current.content : '';
    const next = prior ? `${prior}\n\n${text}` : text;
    this.registry.set(LEGACY_SYSTEM_LAYER, next, {
      priority: 200,
      tags: ['system'],
      owner: 'history.appendSystem',
    });
    this._updatedAt = Date.now();
  }

  /** Deep clone this history, including the registry. */
  fork(newId?: string): ConversationHistory {
    const forked = new ConversationHistory(newId);
    forked._metadata = { ...this._metadata };
    forked.entries = this.entries.map((e) => ({
      ...e,
      message: { ...e.message },
      usage: e.usage ? { ...e.usage } : undefined,
    }));
    // Copy registry layers one by one (skip subscription state — fresh listeners).
    for (const layer of this.registry.list()) {
      forked.registry.set(layer.name, layer.content, {
        priority: layer.priority,
        tags: [...layer.tags],
        owner: layer.owner,
        mergeParent: layer.mergeParent,
        metadata: layer.metadata ? { ...layer.metadata } : undefined,
      });
    }
    return forked;
  }

  /** Export to JSON-serializable snapshot. Includes registry state. */
  export(): HistorySnapshot {
    return {
      id: this._id,
      entries: this.entries.map((e) => ({
        ...e,
        message: { ...e.message },
        usage: e.usage ? { ...e.usage } : undefined,
      })),
      registry: this.registry.snapshot(),
      metadata: { ...this._metadata },
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }

  /** Import from snapshot. Supports both new (registry-aware) and legacy
   *  (`system` field only) snapshots. */
  static import(snapshot: HistorySnapshot): ConversationHistory {
    const history = new ConversationHistory(snapshot.id);
    history._metadata = { ...snapshot.metadata };
    history._createdAt = snapshot.createdAt;
    history._updatedAt = snapshot.updatedAt;
    history.entries = snapshot.entries.map((e) => ({
      ...e,
      message: { ...e.message },
      usage: e.usage ? { ...e.usage } : undefined,
    }));
    if (snapshot.registry) {
      for (const layer of snapshot.registry.layers) {
        history.registry.set(layer.name, layer.content, {
          priority: layer.priority,
          tags: [...layer.tags],
          owner: layer.owner,
          mergeParent: layer.mergeParent,
          metadata: layer.metadata ? { ...layer.metadata } : undefined,
        });
      }
    } else if (snapshot.system !== undefined) {
      history.system = snapshot.system;
    }
    return history;
  }

  /** Rough token estimate: ~4 chars per token for English */
  private estimateTokens(content: Content): number {
    if (typeof content === 'string') return Math.ceil(content.length / 4);
    let total = 0;
    for (const part of content) {
      if (part.type === 'text') total += Math.ceil(part.text.length / 4);
      else if (part.type === 'tool_call')
        total += Math.ceil(JSON.stringify(part.arguments).length / 4) + 10;
      else if (part.type === 'tool_result') {
        const c = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
        total += Math.ceil(c.length / 4);
      } else total += 250; // images, audio, video — rough estimate
    }
    return total;
  }
}
