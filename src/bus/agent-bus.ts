/** AgentBus — cross-module event bus for agent systems.
 *
 *  Distinct from HookBus:
 *    - HookBus carries SDK-internal instrumentation (onCompletion, onContextMeasure,
 *      onToolCallStart, ...). Strongly typed per-event.
 *    - AgentBus carries business events between agent modules and the app layer
 *      (ask.permission, log.progress, notify, lifecycle.*). Open envelope,
 *      user-declared kinds, pattern matching on kind names.
 *
 *  Pattern matching rules for `on(kindPattern, handler)`:
 *    - Exact match:   'ask.permission' matches only 'ask.permission'
 *    - Prefix match:  'ask.*' matches 'ask.permission', 'ask.choice', 'ask.anything'
 *    - Wildcard:      '*' matches everything
 *
 *  Correlation IDs link request events to reply events:
 *    bus.emit({ kind: 'ask.permission', correlationId: 'q1', payload: {...} });
 *    bus.onReply('q1', (replyEvent) => ...);
 *    // Elsewhere:
 *    bus.reply('q1', { kind: 'ask.answer', source: 'user', payload: { granted: true } });
 *
 *  Ordering guarantees (by design — see orchestrator decomposition spec):
 *    - Top-level `emit()` calls are processed FIFO globally. Two parallel
 *      `emit(A)` and `emit(B)` complete in submission order.
 *    - Reentrant `emit()` (called from within a handler) runs depth-first:
 *      the nested event's handlers complete before the next sibling handler
 *      of the outer event runs. This preserves causal order and avoids
 *      deadlock when a handler awaits its own nested emit. */

import { handlerContext } from './async-context';

export interface AgentEvent {
  /** Stable unique id assigned by emit() if not supplied. Used by Journal,
   *  Aggregator, ResumeManager to reference specific events. */
  id: string;
  /** Logical identity of the emitter (usually a module id). */
  source: string;
  /** Dot-delimited kind, e.g. 'ask.permission', 'log.progress', 'lifecycle.created'. */
  kind: string;
  /** Kind-specific payload. Caller and listener agree on shape by convention. */
  payload: unknown;
  /** Milliseconds since epoch — filled in by emit() if not provided. */
  timestamp: number;
  /** Optional correlation ID linking a reply or progress update to its origin. */
  correlationId?: string;
  /** Optional id of the parent event (set by callers when they emit from
   *  within a handler and want to record the causal link). The bus does not
   *  populate this automatically — callers opt in. */
  causedBy?: string;
}

/** Emit form — id and timestamp filled in by bus if absent. */
export type AgentEventInput = Omit<AgentEvent, 'id' | 'timestamp'> & {
  id?: string;
  timestamp?: number;
};

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

export interface SubscribeOptions {
  /** Optional subscriber identity. Stored on the subscription so future
   *  components (Wiring, Journal, Aggregator) can record which subscriber
   *  processed which event. The bus itself does not introspect it today. */
  name?: string;
}

interface SubscriberEntry {
  handler: AgentEventHandler;
  name?: string;
}

interface QueueEntry {
  event: AgentEvent;
  resolve: () => void;
  reject: (err: Error) => void;
}

/** Generate a short event id. Used when the caller doesn't supply one. */
function newEventId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `evt_${hex}`;
}

/** `handlerContext` marks "we are currently inside a handler frame". Reentrant
 *  emits (called from a handler, possibly across awaits) inherit this context;
 *  external emits do not. This is how we tell "nested" from "concurrent
 *  external" when both happen while a slow handler is suspended. Imported from
 *  ./async-context so the browser build can swap AsyncLocalStorage for a
 *  no-node:async_hooks fallback via the package "browser" field. */

/** Lightweight, asynchronous, pattern-matched event bus. */
export class AgentBus {
  /** Pattern → subscribers. Exact patterns and prefix patterns stored separately for speed. */
  private exact = new Map<string, Set<SubscriberEntry>>();
  private prefix = new Map<string, Set<SubscriberEntry>>(); // key is prefix WITHOUT trailing .*
  private wildcard = new Set<SubscriberEntry>();
  /** correlationId → reply subscribers. Cleared when handler unsubscribes. */
  private replies = new Map<string, Set<SubscriberEntry>>();

  /** FIFO queue for top-level emits. Reentrant emits bypass the queue. */
  private queue: QueueEntry[] = [];
  private draining = false;

  /** Subscribe to events whose kind matches the pattern.
   *  - 'foo.bar'  → exact
   *  - 'foo.*'    → prefix 'foo.' (matches 'foo.bar', 'foo.baz.qux', etc.)
   *  - '*'        → all
   *  Returns unsubscribe function. */
  on(kindPattern: string, handler: AgentEventHandler, options?: SubscribeOptions): () => void {
    const entry: SubscriberEntry = { handler, name: options?.name };

    if (kindPattern === '*') {
      this.wildcard.add(entry);
      return () => {
        this.wildcard.delete(entry);
      };
    }
    if (kindPattern.endsWith('.*')) {
      const prefix = kindPattern.slice(0, -1); // keep the trailing dot: 'foo.*' → 'foo.'
      let set = this.prefix.get(prefix);
      if (!set) {
        set = new Set();
        this.prefix.set(prefix, set);
      }
      set.add(entry);
      return () => {
        const s = this.prefix.get(prefix);
        if (s) {
          s.delete(entry);
          if (s.size === 0) this.prefix.delete(prefix);
        }
      };
    }
    let set = this.exact.get(kindPattern);
    if (!set) {
      set = new Set();
      this.exact.set(kindPattern, set);
    }
    set.add(entry);
    return () => {
      const s = this.exact.get(kindPattern);
      if (s) {
        s.delete(entry);
        if (s.size === 0) this.exact.delete(kindPattern);
      }
    };
  }

  /** Subscribe to all events carrying this correlation ID. Returns unsubscribe. */
  onReply(
    correlationId: string,
    handler: AgentEventHandler,
    options?: SubscribeOptions,
  ): () => void {
    const entry: SubscriberEntry = { handler, name: options?.name };
    let set = this.replies.get(correlationId);
    if (!set) {
      set = new Set();
      this.replies.set(correlationId, set);
    }
    set.add(entry);
    return () => {
      const s = this.replies.get(correlationId);
      if (s) {
        s.delete(entry);
        if (s.size === 0) this.replies.delete(correlationId);
      }
    };
  }

  /** Publish an event. Top-level calls are queued and processed FIFO globally;
   *  reentrant calls (from inside a handler) run depth-first.
   *  Resolves once all handlers for this event have completed. */
  async emit(input: AgentEventInput): Promise<void> {
    const event: AgentEvent = {
      id: input.id ?? newEventId(),
      source: input.source,
      kind: input.kind,
      payload: input.payload,
      timestamp: input.timestamp ?? Date.now(),
      correlationId: input.correlationId,
      causedBy: input.causedBy,
    };

    if (handlerContext.getStore() === true) {
      // Reentrant call from inside a handler frame — run inline so nested
      // handlers can `await bus.emit(...)` without deadlocking against the
      // FIFO queue. AsyncLocalStorage propagates through awaits, so this
      // stays true even if the handler suspended; external callers don't
      // have the store set.
      return this.processEvent(event);
    }

    // Top-level call — enqueue and let drain() process FIFO.
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ event, resolve, reject });
      void this.drain();
    });
  }

  /** Convenience: publish a reply carrying the given correlationId.
   *  Ensures correlationId is set (caller can't forget it). */
  async reply(correlationId: string, input: Omit<AgentEventInput, 'correlationId'>): Promise<void> {
    return this.emit({ ...input, correlationId });
  }

  /** Number of registered handlers (sum across exact + prefix + wildcard + reply).
   *  Useful for leak detection in tests. */
  get handlerCount(): number {
    let n = this.wildcard.size;
    for (const set of this.exact.values()) n += set.size;
    for (const set of this.prefix.values()) n += set.size;
    for (const set of this.replies.values()) n += set.size;
    return n;
  }

  /** Remove all handlers. Use during teardown. */
  clear(): void {
    this.exact.clear();
    this.prefix.clear();
    this.wildcard.clear();
    this.replies.clear();
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (!entry) continue;
        try {
          await this.processEvent(entry.event);
          entry.resolve();
        } catch (err) {
          entry.reject(err as Error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async processEvent(event: AgentEvent): Promise<void> {
    // Collect matching subscribers in a stable order: wildcard → prefix → exact → correlation
    const subs: SubscriberEntry[] = [];
    if (this.wildcard.size > 0) subs.push(...this.wildcard);
    for (const [prefix, set] of this.prefix) {
      if (event.kind.startsWith(prefix)) subs.push(...set);
    }
    const exactSet = this.exact.get(event.kind);
    if (exactSet) subs.push(...exactSet);
    if (event.correlationId) {
      const replySet = this.replies.get(event.correlationId);
      if (replySet) subs.push(...replySet);
    }

    // Run all handlers inside the "we're inside a handler" async context, so
    // any reentrant emit() they make is detected and short-circuits the queue.
    await handlerContext.run(true, async () => {
      for (const sub of subs) {
        try {
          await sub.handler(event);
        } catch (err) {
          // Handler errors must not break other handlers. Re-emit as system
          // event so observers can log; we don't rethrow — event emission is
          // not transactional.
          await this.emitInternalError(event, err as Error);
        }
      }
    });
  }

  private async emitInternalError(originalEvent: AgentEvent, error: Error): Promise<void> {
    // Emit a system error event but avoid recursion — use a direct internal path
    // so this error event doesn't itself try to invoke a broken handler.
    const sysEvent: AgentEvent = {
      id: newEventId(),
      source: 'agent-bus',
      kind: 'system.handler-error',
      payload: { originalKind: originalEvent.kind, error: error.message, stack: error.stack },
      timestamp: Date.now(),
      causedBy: originalEvent.id,
    };
    // Only wildcard + exact 'system.handler-error' listeners receive this. Prefix
    // matching on 'system.*' would still fire (intentional — observability tools
    // subscribe to system.* to see errors).
    const subs: SubscriberEntry[] = [];
    if (this.wildcard.size > 0) subs.push(...this.wildcard);
    for (const [prefix, set] of this.prefix) {
      if (sysEvent.kind.startsWith(prefix)) subs.push(...set);
    }
    const exactSet = this.exact.get(sysEvent.kind);
    if (exactSet) subs.push(...exactSet);
    for (const sub of subs) {
      try {
        await sub.handler(sysEvent);
      } catch {
        /* swallow — don't cascade */
      }
    }
  }
}
