/** HookBus — typed pub/sub for SDK instrumentation.
 *
 *  Subsystems (network engine, llm client, agent loop, server, plugins) emit
 *  hook events; consumers (logger, cache, cost, context guard, ...) subscribe.
 *
 *  Distinct from AgentBus:
 *    - HookBus carries SDK-internal instrumentation. Type-safe per event name.
 *    - AgentBus carries cross-module business events with pattern matching
 *      and correlation. See `agent-bus.ts`.
 *
 *  Failure mode: handlers throwing inside `emit()` propagate. We do NOT
 *  swallow — emitters need to know if a critical handler (like ContextGuard
 *  abort) failed. Plugins that should never break the request must catch
 *  their own errors. */

import type { HookHandler, HookMap, HookName } from './hook-map';

/** Catch-all handler: receives the event name + context for EVERY emit. */
export type AnyHookHandler = (name: HookName, ctx: unknown) => void | Promise<void>;

export class HookBus {
  // reason: handlers are keyed by name but stored heterogeneously — each entry is
  // typed at the call site via on<K>(), but the Map value must hold all K variants.
  // Using `unknown` here would break arr.indexOf(handler) when unsubscribing, since
  // HookHandler<K> is not assignable to (ctx: unknown) => ... due to contravariance.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers = new Map<string, Array<(ctx: any) => void | Promise<void>>>();
  private anyHandlers: AnyHookHandler[] = [];

  /** Register a catch-all handler invoked for every event (telemetry tap).
   *  Returns an unsubscribe function. */
  onAny(handler: AnyHookHandler): () => void {
    this.anyHandlers.push(handler);
    return () => {
      const idx = this.anyHandlers.indexOf(handler);
      if (idx >= 0) this.anyHandlers.splice(idx, 1);
    };
  }

  /** Register a handler. Returns unsubscribe function. */
  on<K extends HookName>(name: K, handler: HookHandler<K>): () => void {
    let list = this.handlers.get(name);
    if (!list) {
      list = [];
      this.handlers.set(name, list);
    }
    list.push(handler);
    return () => {
      const arr = this.handlers.get(name);
      if (!arr) return;
      const idx = arr.indexOf(handler);
      if (idx >= 0) arr.splice(idx, 1);
      if (arr.length === 0) this.handlers.delete(name);
    };
  }

  /** Register a one-time handler. */
  once<K extends HookName>(name: K, handler: HookHandler<K>): () => void {
    const unsub = this.on(name, (ctx) => {
      unsub();
      return handler(ctx);
    });
    return unsub;
  }

  /** Remove all handlers for a hook, or all hooks (incl. catch-all) if no name. */
  off(name?: HookName): void {
    if (name) this.handlers.delete(name);
    else {
      this.handlers.clear();
      this.anyHandlers = [];
    }
  }

  /** Emit asynchronously. Handlers run in registration order; awaited sequentially.
   *  Propagates any handler error to the caller. */
  async emit<K extends HookName>(name: K, ctx: HookMap[K]): Promise<void> {
    const list = this.handlers.get(name);
    if (list) for (const handler of list) await handler(ctx);
    for (const any of this.anyHandlers) await any(name, ctx);
  }

  /** Emit synchronously. For hot paths (per-chunk stream events). Async handlers
   *  start but are NOT awaited; their resolution timing is undefined. Use only
   *  when the emitter cannot block. */
  emitSync<K extends HookName>(name: K, ctx: HookMap[K]): void {
    const list = this.handlers.get(name);
    if (list) for (const handler of list) handler(ctx);
    for (const any of this.anyHandlers) any(name, ctx);
  }

  /** Whether any handlers are registered for a hook name. */
  has(name: HookName): boolean {
    const list = this.handlers.get(name);
    return !!list && list.length > 0;
  }

  /** Diagnostic: total handlers across all names. Useful for leak detection
   *  in tests (engine.destroy() should bring this back to 0 if no external
   *  subscribers remain). */
  get handlerCount(): number {
    let n = this.anyHandlers.length;
    for (const list of this.handlers.values()) n += list.length;
    return n;
  }
}
