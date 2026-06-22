/** Node/Bun reentrancy context — backed by AsyncLocalStorage.
 *
 *  AsyncLocalStorage propagates through awaits, so a reentrant emit (made from
 *  inside a handler, even after the handler suspended) sees the store while a
 *  genuinely concurrent external emit does not. This is what lets AgentBus tell
 *  "nested" from "concurrent external" with full correctness on the server.
 *
 *  The browser build never loads this file: the package "browser" field maps it
 *  to ./async-context.browser.ts, which has no node:async_hooks dependency. */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { HandlerContext } from './async-context.types';

export const handlerContext: HandlerContext = new AsyncLocalStorage<boolean>();
