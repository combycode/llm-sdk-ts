/** Shared JSON-RPC dispatch logic for MCP transports (stdio, WebSocket, HTTP).
 *
 * Owns:
 *   - `pending` map + `nextId` counter (client-initiated requests)
 *   - `handlers` field + `setHandlers()`
 *   - `routeIncoming(msg)` — dispatch: response | server-request | notification
 *   - `resolveResponse(msg)` — settle a pending promise from a response message
 *   - `handleRequest(msg)` — call `handlers.onRequest` and send back the result
 *   - `failAll(err)` — reject all in-flight pending requests
 *   - `allocateId()` — return the next monotonic request id
 *   - `registerPending(id, resolve, reject, timeoutMs, method)` — set up timer
 *
 * Each concrete transport implements:
 *   - `protected abstract sendMessage(obj: unknown): void | Promise<void>`
 *     Write a serialised JSON-RPC object back to the peer.
 *   - The medium-specific lifecycle (connect / close / listen) and inbound
 *     parsing, which ends with a call to `this.routeIncoming(parsedMsg)`.
 */

import { McpError, McpErrorCode } from './jsonrpc';
import type { IncomingMcpHandlers } from './transport';

/** A loosely-typed inbound JSON-RPC message (response, request, or notification). */
export interface InboundMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

export abstract class BaseJsonRpcTransport {
  protected nextId = 0;
  protected handlers: IncomingMcpHandlers = {};
  protected readonly pending = new Map<number, Pending>();
  /** Long-lived requests (`subscriptions/listen`) awaiting their end-of-stream response. Kept apart
   *  from `pending` because these must NOT time out. */
  protected readonly longLived = new Map<number, ((error?: unknown) => void) | undefined>();

  setHandlers(handlers: IncomingMcpHandlers): void {
    this.handlers = handlers;
  }

  /** Write a serialised JSON-RPC object back to the peer. */
  protected abstract sendMessage(obj: unknown): void | Promise<void>;

  /** Allocate the next monotonic request id. */
  protected allocateId(): number {
    return this.nextId++;
  }

  /** Send a request that is NOT expected to answer promptly, and return its id.
   *
   *  `subscriptions/listen` (2026-07-28) is long-lived by design: the response arrives only when
   *  the server tears the subscription down, while notifications flow in the meantime. Routing it
   *  through `request()` would arm the normal timeout and kill a perfectly healthy subscription, so
   *  no pending entry is registered — the eventual response is dropped, its only meaning being
   *  "the stream ended".
   *
   *  The caller correlates frames itself via the returned id. Duplex transports (stdio, WebSocket)
   *  support this; a request/response transport must override and reject. */
  async sendLongLivedRequest(
    method: string,
    params?: unknown,
    onEnd?: (error?: unknown) => void,
  ): Promise<number> {
    const id = this.allocateId();
    // Registered with NO timeout: the response settles only when the server tears the subscription
    // down, which is exactly the `onEnd` signal. Without an entry here that response would be an
    // unmatched message and the caller would never learn the stream had ended.
    this.longLived.set(id, onEnd);
    await this.sendMessage({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    return id;
  }

  /** Settle a long-lived request from its (late) response. Returns whether one was waiting. */
  protected resolveLongLived(id: number | string, error?: unknown): boolean {
    const onEnd = this.longLived.get(id as number);
    if (onEnd === undefined && !this.longLived.has(id as number)) return false;
    this.longLived.delete(id as number);
    onEnd?.(error);
    return true;
  }

  /** Register a pending request and arm its timeout. */
  protected registerPending(
    id: number,
    resolve: (v: unknown) => void,
    reject: (e: unknown) => void,
    timeoutMs: number,
    method: string,
  ): void {
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new McpError({ code: McpErrorCode.RequestTimeout, message: `MCP request '${method}' timed out` }));
    }, timeoutMs);
    this.pending.set(id, { resolve, reject, timer });
  }

  /** Dispatch a parsed inbound message to the correct handler. */
  protected routeIncoming(msg: InboundMessage): void {
    if (msg.id !== undefined && msg.method === undefined) {
      this.resolveResponse(msg);
    } else if (msg.method !== undefined && msg.id !== undefined) {
      void this.handleRequest(msg);
    } else if (msg.method !== undefined) {
      this.handlers.onNotification?.(msg.method, msg.params);
    }
  }

  /** Settle a pending client-initiated request from its response message. */
  protected resolveResponse(msg: InboundMessage): void {
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) {
      // A long-lived request answers only when the server ends the subscription, so its response
      // arrives with no pending entry. That is the end-of-stream signal, not a stray message.
      this.resolveLongLived(msg.id, msg.error ? new McpError(msg.error) : undefined);
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new McpError(msg.error));
    else p.resolve(msg.result);
  }

  /** Handle a server-initiated request: call the registered handler and send
   *  the result (or an error) back via `sendMessage`. */
  protected async handleRequest(msg: InboundMessage): Promise<void> {
    const id = msg.id;
    if (!this.handlers.onRequest) {
      await this.sendMessage({ jsonrpc: '2.0', id, error: { code: McpErrorCode.MethodNotFound, message: 'no request handler' } });
      return;
    }
    try {
      const result = await this.handlers.onRequest(msg.method as string, msg.params);
      await this.sendMessage({ jsonrpc: '2.0', id, result: result ?? {} });
    } catch (e) {
      const error =
        e instanceof McpError
          ? { code: e.code, message: e.message, data: e.data }
          : { code: McpErrorCode.InternalError, message: (e as Error)?.message ?? String(e) };
      await this.sendMessage({ jsonrpc: '2.0', id, error });
    }
  }

  /** Reject all in-flight pending requests with the given error. */
  protected failAll(err: McpError): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    // Subscriptions die with the connection too — otherwise a caller keeps a handle to a stream
    // that will never deliver again and is never told.
    for (const onEnd of this.longLived.values()) onEnd?.(err);
    this.longLived.clear();
  }
}
