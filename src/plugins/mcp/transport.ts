/** A transport carries JSON-RPC messages to/from an MCP server over a wire
 *  (stdio or Streamable HTTP). It is BIDIRECTIONAL: besides our requests, it
 *  routes incoming server->client requests (sampling/elicitation/roots/ping)
 *  and notifications (logging, *_changed, progress) to the registered handlers.
 *  The McpClient speaks methods; the transport speaks the wire + correlation. */

/** Handlers for messages the server initiates toward us. */
export interface IncomingMcpHandlers {
  /** Server->client request — return the result, or throw McpError. */
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  /** Server->client notification (no reply). */
  onNotification?: (method: string, params: unknown) => void;
}

export interface McpTransport {
  /** Open the connection (spawn the process / no-op for HTTP). */
  start(): Promise<void>;
  /** Send a request and resolve its `result`; throws McpError on a JSON-RPC error. */
  request(method: string, params?: unknown): Promise<unknown>;
  /** Fire-and-forget notification (no response). */
  notify(method: string, params?: unknown): Promise<void>;
  /** Register handlers for server-initiated messages. */
  setHandlers(handlers: IncomingMcpHandlers): void;
  /** Record the negotiated protocol version (HTTP sets a header; stdio ignores). */
  setProtocolVersion?(version: string): void;
  /** Open the server->client channel (HTTP GET SSE stream). Stdio is already
   *  duplex, so this is a no-op there. Call after the initialize handshake. */
  listen?(): Promise<void> | void;
  /** Close the connection (kill the process / DELETE the HTTP session). */
  close(): Promise<void>;
}
