/** Browser reentrancy context — a single shared flag, no node:async_hooks.
 *
 *  AsyncLocalStorage does not exist in browsers. We keep one module-scoped flag
 *  and hold it for the WHOLE duration of handler dispatch (including while the
 *  async handler loop is suspended), restoring it when dispatch fully settles.
 *
 *  Trade-off vs. the Node AsyncLocalStorage impl: a genuinely concurrent
 *  top-level emit that arrives while a handler is suspended sees the flag set
 *  and runs inline instead of FIFO-queued. That softly weakens global ordering
 *  but never deadlocks — acceptable for browser, single-user usage. Reentrant
 *  (nested) emits, the case that matters for correctness, are detected exactly. */

import type { HandlerContext } from './async-context.types';

let current: boolean | undefined;

export const handlerContext: HandlerContext = {
  run<R>(value: boolean, fn: () => R): R {
    const prev = current;
    current = value;
    let result: R;
    try {
      result = fn();
    } catch (err) {
      current = prev;
      throw err;
    }
    // Hold the flag across the async lifetime, then restore.
    if (result != null && typeof (result as { then?: unknown }).then === 'function') {
      return (result as unknown as Promise<unknown>).finally(() => {
        current = prev;
      }) as unknown as R;
    }
    current = prev;
    return result;
  },
  getStore(): boolean | undefined {
    return current;
  },
};
