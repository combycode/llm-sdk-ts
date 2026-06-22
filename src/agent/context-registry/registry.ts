/** ContextRegistry — layered, observable, composable context store.
 *
 *  Lives at three conceptual scopes (all use the same class, distinguished
 *  only by their parent chain): orchestrator-global, module-level, and
 *  conversation-level. Composed render walks the parent chain; child layers
 *  override parents by default, or merge additively via layer.mergeParent.
 *
 *  Events bubble from parent to children — subscribers on child registries
 *  see all effective changes without wiring to parents manually. */

import type { ContentPart } from '../../llm/types/messages';
import type { TokenCounter } from '../types';
import {
  type CollectedEntry,
  concatContent,
  cryptoRandomShort,
  layerToText,
  passesFilter,
  sortLayers,
} from './registry-internal';
import type {
  ContextLayer,
  ContextRegistryConfig,
  ContextRegistryEvent,
  RegistryEventHandler,
  RegistrySnapshot,
  RenderedPart,
  RenderOptions,
  RenderResult,
  SetLayerOptions,
  SizeChangeHandler,
} from './types';

export class ContextRegistry {
  readonly id: string;
  private readonly defaultOwner: string | undefined;
  private readonly separator: string;
  private readonly counter: TokenCounter | null;
  private readonly layers = new Map<string, ContextLayer>();

  // Subscription storage — same pattern semantics as AgentBus:
  //   exact 'foo' → exactSubs['foo']
  //   prefix 'foo.*' → prefixSubs['foo.']
  //   wildcard '*' → wildcardSubs
  private readonly exactSubs = new Map<string, Set<RegistryEventHandler>>();
  private readonly prefixSubs = new Map<string, Set<RegistryEventHandler>>();
  private readonly wildcardSubs = new Set<RegistryEventHandler>();
  private readonly sizeSubs = new Set<SizeChangeHandler>();

  private _parent: ContextRegistry | null = null;
  private parentUnsub: (() => void) | null = null;

  constructor(config: ContextRegistryConfig = {}) {
    this.id = config.id ?? `ctx-reg-${cryptoRandomShort()}`;
    this.defaultOwner = config.defaultOwner;
    this.separator = config.separator ?? '\n\n';
    this.counter = config.counter ?? null;
    if (config.parent) this.setParent(config.parent);
  }

  // ─── Parent chain ──────────────────────────────────────────────────────

  get parent(): ContextRegistry | null {
    return this._parent;
  }

  /** Attach or detach a parent registry. Throws on cycle. Re-wires bubbling. */
  setParent(parent: ContextRegistry | null): void {
    if (parent === this._parent) return;
    if (parent && this.wouldCreateCycle(parent)) {
      throw new Error(
        `ContextRegistry(${this.id}): setParent would create a cycle (would-be-parent ${parent.id} is in this registry's ancestor chain or is self)`,
      );
    }
    if (this.parentUnsub) {
      this.parentUnsub();
      this.parentUnsub = null;
    }
    this._parent = parent;
    if (parent) {
      // Subscribe to parent's full event stream; re-fire on self so our
      // subscribers see parent events too. Event.registry stays the original
      // parent id for traceability.
      this.parentUnsub = parent.subscribeInternalWildcard((event) => {
        this.fireBubbledEvent(event);
      });
    }
  }

  private wouldCreateCycle(candidate: ContextRegistry): boolean {
    let cur: ContextRegistry | null = candidate;
    while (cur) {
      if (cur === this) return true;
      cur = cur._parent;
    }
    return false;
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────

  /** Set or replace a layer. Bumps version. Emits 'set' (if new) or 'update'. */
  set(name: string, content: string | ContentPart[], opts: SetLayerOptions = {}): ContextLayer {
    const sizeBefore = this.sizeCharsLocal();
    const previous = this.layers.get(name);
    const now = Date.now();

    const layer: ContextLayer = {
      name,
      content,
      priority: opts.priority ?? previous?.priority ?? 100,
      tags: opts.tags ?? previous?.tags ?? [],
      owner: opts.owner ?? this.defaultOwner,
      version: (previous?.version ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      mergeParent: opts.mergeParent ?? previous?.mergeParent,
      metadata: opts.metadata ?? previous?.metadata,
    };
    this.layers.set(name, layer);

    const sizeAfter = this.sizeCharsLocal();
    this.fireEvent({
      type: previous ? 'update' : 'set',
      name,
      previous,
      current: layer,
      registry: this.id,
      sizeBefore,
      sizeAfter,
      timestamp: now,
    });
    return layer;
  }

  /** Modify a layer in place via a function.
   *  - fn receives the current layer (or undefined if absent)
   *  - fn may return: new content (string | ContentPart[]) OR a full layer shape
   *  - Missing fields inherit from previous layer. */
  patch(
    name: string,
    fn: (prev: ContextLayer | undefined) => string | ContentPart[] | ContextLayer,
  ): ContextLayer {
    const prev = this.layers.get(name);
    const result = fn(prev);
    if (typeof result === 'string' || Array.isArray(result)) {
      return this.set(name, result);
    }
    return this.set(name, result.content, {
      priority: result.priority,
      tags: result.tags,
      owner: result.owner,
      mergeParent: result.mergeParent,
      metadata: result.metadata,
    });
  }

  /** Lookup by name. Does NOT walk parent chain. Use render() for composed views. */
  get(name: string): ContextLayer | undefined {
    return this.layers.get(name);
  }

  has(name: string): boolean {
    return this.layers.has(name);
  }

  /** Remove a layer. Returns true if something was removed. */
  remove(name: string): boolean {
    const prev = this.layers.get(name);
    if (!prev) return false;
    const sizeBefore = this.sizeCharsLocal();
    this.layers.delete(name);
    const sizeAfter = this.sizeCharsLocal();
    this.fireEvent({
      type: 'remove',
      name,
      previous: prev,
      registry: this.id,
      sizeBefore,
      sizeAfter,
      timestamp: Date.now(),
    });
    return true;
  }

  /** List layers, optionally filtered. Does NOT walk parent. */
  list(filter?: { tag?: string; tags?: string[]; owner?: string }): ContextLayer[] {
    let result = [...this.layers.values()];
    if (filter?.tag) result = result.filter((l) => l.tags.includes(filter.tag as string));
    if (filter?.tags)
      result = result.filter((l) => (filter.tags as string[]).some((t) => l.tags.includes(t)));
    if (filter?.owner) result = result.filter((l) => l.owner === filter.owner);
    return result;
  }

  /** All layer names in this registry (not parent). */
  names(): string[] {
    return [...this.layers.keys()];
  }

  // ─── Rendering ─────────────────────────────────────────────────────────

  /** Compose layers into a rendered result.
   *
   *  - If includeParent !== false AND a parent exists, parent's layers are
   *    collected first; then THIS registry's layers overlay on top.
   *  - Same-named collision: child replaces parent (default) OR merges
   *    (if child layer.mergeParent === true).
   *  - Sort: priority ascending → updatedAt ascending → name ascending. */
  render(opts: RenderOptions = {}): RenderResult {
    const collected = this.collectForRender(opts);
    const entries = [...collected.values()].sort(sortLayers);
    const parts: RenderedPart[] = entries.map(({ layer, source }) => ({
      name: layer.name,
      content: layerToText(layer),
      priority: layer.priority,
      tags: layer.tags,
      owner: layer.owner,
      registry: source,
    }));
    const separator = opts.separator ?? this.separator;
    const flat = parts
      .map((p) => p.content)
      .filter((c) => c.length > 0)
      .join(separator);
    return { parts, flat, totalChars: flat.length, rendered: Date.now() };
  }

  /** Convenience: render().flat. */
  flat(opts?: RenderOptions): string {
    return this.render(opts).flat;
  }

  /** Internal recursive collector — merges parent chain, applies filters. */
  private collectForRender(opts: RenderOptions): Map<string, CollectedEntry> {
    const result = new Map<string, CollectedEntry>();
    if (opts.includeParent !== false && this._parent) {
      for (const [name, entry] of this._parent.collectForRender(opts)) {
        result.set(name, entry);
      }
    }
    for (const [name, layer] of this.layers) {
      if (!passesFilter(layer, opts)) continue;
      const existing = result.get(name);
      if (existing && layer.mergeParent) {
        const mergedLayer: ContextLayer = {
          ...layer,
          content: concatContent(existing.layer.content, layer.content),
        };
        result.set(name, { layer: mergedLayer, source: this.id });
      } else {
        result.set(name, { layer, source: this.id });
      }
    }
    return result;
  }

  // ─── Size ──────────────────────────────────────────────────────────────

  /** Total character count of rendered output (with given options). */
  sizeChars(opts?: RenderOptions): number {
    return this.render(opts).totalChars;
  }

  /** Estimated token count. Uses injected TokenCounter when available,
   *  otherwise a 4-chars/token heuristic. */
  sizeTokens(ctx?: { provider?: string; model?: string }, opts?: RenderOptions): number {
    const text = this.flat(opts);
    if (!this.counter) return Math.ceil(text.length / 4);
    return this.counter.estimate(text, ctx);
  }

  /** Local (this-registry-only) char count — used for sizeBefore/sizeAfter
   *  on emitted events. Does NOT walk parent chain. */
  private sizeCharsLocal(): number {
    let total = 0;
    const sep = this.separator.length;
    let first = true;
    for (const layer of this.layers.values()) {
      const text = layerToText(layer);
      if (text.length === 0) continue;
      if (!first) total += sep;
      total += text.length;
      first = false;
    }
    return total;
  }

  // ─── Subscriptions ─────────────────────────────────────────────────────

  /** Subscribe to layer events. Pattern matches layer name:
   *  - exact: 'facts'
   *  - prefix: 'memory.*'
   *  - wildcard: '*' (all events, including bubbled from parent)
   *  Returns unsubscribe. */
  subscribe(pattern: string, handler: RegistryEventHandler): () => void {
    if (pattern === '*') {
      this.wildcardSubs.add(handler);
      return () => {
        this.wildcardSubs.delete(handler);
      };
    }
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1);
      let set = this.prefixSubs.get(prefix);
      if (!set) {
        set = new Set();
        this.prefixSubs.set(prefix, set);
      }
      set.add(handler);
      return () => {
        const s = this.prefixSubs.get(prefix);
        if (s) {
          s.delete(handler);
          if (s.size === 0) this.prefixSubs.delete(prefix);
        }
      };
    }
    let set = this.exactSubs.get(pattern);
    if (!set) {
      set = new Set();
      this.exactSubs.set(pattern, set);
    }
    set.add(handler);
    return () => {
      const s = this.exactSubs.get(pattern);
      if (s) {
        s.delete(handler);
        if (s.size === 0) this.exactSubs.delete(pattern);
      }
    };
  }

  /** Subscribe to every event (equivalent to subscribe('*', ...)). */
  onChange(handler: RegistryEventHandler): () => void {
    return this.subscribe('*', handler);
  }

  /** Subscribe to size changes. Fires whenever a layer changes and produces
   *  a non-zero delta. Delta reflects the EMITTING registry's own size change
   *  — subscribers on composed/child registries should recompute their own
   *  effective size if precise composed-size tracking is required. */
  onSizeChange(handler: SizeChangeHandler): () => void {
    this.sizeSubs.add(handler);
    return () => {
      this.sizeSubs.delete(handler);
    };
  }

  /** Internal: subscribe to all events — used by children to bubble parent
   *  events. Separate from public subscribe('*') so internal bookkeeping
   *  doesn't mix with user state. */
  private subscribeInternalWildcard(handler: RegistryEventHandler): () => void {
    this.wildcardSubs.add(handler);
    return () => {
      this.wildcardSubs.delete(handler);
    };
  }

  /** Emit an event originating from THIS registry. */
  private fireEvent(event: ContextRegistryEvent): void {
    this.dispatchToSubscribers(event);
    if (event.sizeBefore !== event.sizeAfter) {
      const delta = event.sizeAfter - event.sizeBefore;
      for (const h of [...this.sizeSubs]) {
        try {
          h(event.sizeAfter, delta);
        } catch {
          /* swallow */
        }
      }
    }
  }

  /** Emit a bubbled event (originated in an ancestor). We re-publish to our
   *  subscribers, preserving the original event.registry for traceability. */
  private fireBubbledEvent(event: ContextRegistryEvent): void {
    this.dispatchToSubscribers(event);
    if (event.sizeBefore !== event.sizeAfter) {
      const delta = event.sizeAfter - event.sizeBefore;
      for (const h of [...this.sizeSubs]) {
        try {
          h(event.sizeAfter, delta);
        } catch {
          /* swallow */
        }
      }
    }
  }

  private dispatchToSubscribers(event: ContextRegistryEvent): void {
    const handlers: RegistryEventHandler[] = [];
    if (this.wildcardSubs.size > 0) handlers.push(...this.wildcardSubs);
    for (const [prefix, set] of this.prefixSubs) {
      if (event.name.startsWith(prefix)) handlers.push(...set);
    }
    const exactSet = this.exactSubs.get(event.name);
    if (exactSet) handlers.push(...exactSet);
    for (const h of handlers) {
      try {
        h(event);
      } catch {
        /* swallow — handler errors don't break others */
      }
    }
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  /** Serialize to a JSON-safe snapshot. Parent is NOT serialized — caller
   *  re-attaches via setParent() after fromSnapshot. */
  snapshot(): RegistrySnapshot {
    return {
      v: 1,
      id: this.id,
      separator: this.separator,
      layers: [...this.layers.values()].map((l) => ({
        ...l,
        content: Array.isArray(l.content) ? [...l.content] : l.content,
        tags: [...l.tags],
        metadata: l.metadata ? { ...l.metadata } : undefined,
      })),
    };
  }

  /** Reconstruct from a snapshot. Events are NOT emitted for initial restore. */
  static fromSnapshot(snap: RegistrySnapshot, config: ContextRegistryConfig = {}): ContextRegistry {
    const reg = new ContextRegistry({
      ...config,
      id: snap.id,
      separator: snap.separator,
    });
    for (const l of snap.layers) {
      reg.layers.set(l.name, { ...l, tags: [...l.tags] });
    }
    return reg;
  }

  // ─── Introspection ─────────────────────────────────────────────────────

  /** Total handlers across all subscription types. For test leak detection. */
  get handlerCount(): number {
    let n = this.wildcardSubs.size + this.sizeSubs.size;
    for (const set of this.exactSubs.values()) n += set.size;
    for (const set of this.prefixSubs.values()) n += set.size;
    return n;
  }

  /** Detach from parent and clear all subscribers. Idempotent. */
  clear(): void {
    this.setParent(null);
    this.exactSubs.clear();
    this.prefixSubs.clear();
    this.wildcardSubs.clear();
    this.sizeSubs.clear();
  }
}

