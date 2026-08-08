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
  // ─── 2026-07-28 revision (verified against mcp-py 2.0.0 `mcp_types/jsonrpc.py`) ───
  /** A routing header disagrees with the request body. */
  HeaderMismatch: -32020,
  /** The server requires a client capability this client did not declare. */
  MissingRequiredClientCapability: -32021,
  /** The server does not speak the requested revision; `data.supported` lists the ones it does.
   *  The ONE error carrying era information, so negotiation reads it specifically. */
  UnsupportedProtocolVersion: -32022,
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
