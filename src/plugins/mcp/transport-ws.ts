/** WebSocket MCP transport — JSON-RPC messages as text frames over a duplex
 *  socket (naturally bidirectional). Uses the engine's `connect` so it shares
 *  the engine's WebSocket factory + hooks. Cross-env (browser + Node/Bun). */

import type { EngineConnect, RealtimeConnection, RealtimeFrame } from '../../network/types';
import { McpError, McpErrorCode } from './jsonrpc';
import type { McpTransport } from './transport';
import { BaseJsonRpcTransport } from './base-transport';

export interface McpWsConfig {
  /** ws:// or wss:// MCP endpoint. */
  url: string;
  protocols?: string | string[];
  headers?: Record<string, string>;
  name?: string;
}

export interface WsTransportDeps {
  connect: EngineConnect;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const WS_OPEN = 1;

export class WsTransport extends BaseJsonRpcTransport implements McpTransport {
  private conn: RealtimeConnection | null = null;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: McpWsConfig,
    private readonly deps: WsTransportDeps,
  ) {
    super();
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  setProtocolVersion(): void {
    // ws has no per-message headers — nothing to record.
  }

  listen(): void {
    // already duplex — server->client frames flow through onFrame.
  }

  async start(): Promise<void> {
    const conn = this.deps.connect({
      url: this.config.url,
      protocols: this.config.protocols,
      headers: this.config.headers,
      provider: 'mcp',
      model: this.config.name ?? 'server',
    });
    this.conn = conn;
    conn.on('message', (f: RealtimeFrame) => this.onFrame(f));
    conn.on('error', () => this.failAll(new McpError({ code: McpErrorCode.ConnectionClosed, message: 'MCP ws error' })));
    conn.on('close', () => this.failAll(new McpError({ code: McpErrorCode.ConnectionClosed, message: 'MCP ws closed' })));

    await new Promise<void>((resolve, reject) => {
      if (conn.readyState === WS_OPEN) return resolve();
      const timer = setTimeout(
        () => reject(new McpError({ code: McpErrorCode.RequestTimeout, message: 'MCP ws open timed out' })),
        this.timeoutMs,
      );
      conn.on('open', () => {
        clearTimeout(timer);
        resolve();
      });
      conn.on('error', () => {
        clearTimeout(timer);
        reject(new McpError({ code: McpErrorCode.ConnectionClosed, message: 'MCP ws failed to open' }));
      });
    });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const conn = this.conn;
    if (!conn) throw new McpError({ code: McpErrorCode.ConnectionClosed, message: 'MCP ws transport not started' });
    const id = this.allocateId();
    return new Promise<unknown>((resolve, reject) => {
      this.registerPending(id, resolve, reject, this.timeoutMs, method);
      conn.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }));
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.conn?.send(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }));
  }

  async close(): Promise<void> {
    this.failAll(new McpError({ code: McpErrorCode.ConnectionClosed, message: 'MCP transport closed' }));
    const conn = this.conn;
    this.conn = null;
    conn?.close();
  }

  // ─── internal ───────────────────────────────────────────────────────────

  protected sendMessage(obj: unknown): void {
    this.conn?.send(JSON.stringify(obj));
  }

  private onFrame(frame: RealtimeFrame): void {
    const text = 'text' in frame ? frame.text : new TextDecoder().decode(frame.binary);
    let msg: import('./base-transport').InboundMessage;
    try {
      msg = JSON.parse(text) as import('./base-transport').InboundMessage;
    } catch {
      return;
    }
    this.routeIncoming(msg);
  }
}
