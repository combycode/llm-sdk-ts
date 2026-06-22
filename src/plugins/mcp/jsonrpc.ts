/** JSON-RPC 2.0 error codes + the error type the MCP client throws on a
 *  protocol-level failure (distinct from a tool-level `isError` result). */

import type { JsonRpcError } from './types';

export const McpErrorCode = {
  ConnectionClosed: -32000,
  RequestTimeout: -32001,
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** A JSON-RPC / transport level error (server unreachable, error response,
 *  timeout). Tool execution failures arrive as a normal result with
 *  `isError: true` and are NOT thrown. */
export class McpError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(err: JsonRpcError) {
    super(err.message);
    this.name = 'McpError';
    this.code = err.code;
    this.data = err.data;
  }
}
