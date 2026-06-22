/** Shared shape for the reentrancy context used by AgentBus.
 *
 *  Two implementations satisfy it:
 *    - async-context.ts          → Node/Bun, backed by AsyncLocalStorage
 *      (full isolation across awaits and concurrent emits).
 *    - async-context.browser.ts  → browser, a single shared flag held for the
 *      duration of handler dispatch (no node:async_hooks). The package "browser"
 *      field swaps the former for the latter at bundle time. */
export interface HandlerContext {
  /** Run `fn` with the store set to `value`. Returns whatever `fn` returns. */
  run<R>(value: boolean, fn: () => R): R;
  /** The current store value, or undefined when outside any `run`. */
  getStore(): boolean | undefined;
}
