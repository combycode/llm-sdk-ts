/** Streamable-HTTP MCP transport — each call is a POST through the engine's
 *  `fetch` (so it rides the central queue + network telemetry, never side-fetch).
 *  Cross-env (works in the browser when the server allows CORS). Handles a
 *  single request/response per call: the response body is either one JSON-RPC
 *  message (`application/json`) or an SSE batch (`text/event-stream`). The
 *  long-lived server->client GET stream reconnects with backoff + Last-Event-ID
 *  for resumption. */

import type { EngineFetch, EngineFetchStream } from '../../network/types';
import { McpError, McpErrorCode } from './jsonrpc';
import type { McpTransport } from './transport';
import type { JsonRpcResponse, McpHttpConfig } from './types';
import { BaseJsonRpcTransport } from './base-transport';

export interface HttpTransportDeps {
  fetch: EngineFetch;
  /** Streaming fetch for the server->client GET SSE channel. */
  fetchStream: EngineFetchStream;
  queueName?: string;
  timeoutMs?: number;
  /** Authorization headers (Bearer) to attach to every request. */
  getAuthHeaders?: () => Promise<Record<string, string>>;
  /** Called on a 401; return true to retry the request once (after re-auth). */
  onUnauthorized?: () => Promise<boolean>;
}

export class HttpTransport extends BaseJsonRpcTransport implements McpTransport {
  private nextHttpId = 0;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private eventAbort: AbortController | null = null;
  private lastEventId: string | null = null;

  constructor(
    private readonly config: McpHttpConfig,
    private readonly deps: HttpTransportDeps,
  ) {
    super();
  }

  async start(): Promise<void> {
    // No-op: the session is established by the `initialize` request.
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  /** Open the server->client GET SSE stream (best-effort: a 405 means the server
   *  is request/response only). Reconnects with backoff + Last-Event-ID until
   *  close(). Runs in the background. */
  listen(): void {
    if (this.eventAbort) return;
    const abort = new AbortController();
    this.eventAbort = abort;
    void this.eventLoop(abort.signal);
  }

  private async eventLoop(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      const opened = await this.runEventStream(signal);
      if (signal.aborted) break;
      // Never opened on the first try -> the server has no GET channel (405); stop.
      if (!opened && attempt === 0) break;
      attempt = opened ? 0 : attempt + 1; // reset backoff after a healthy session
      if (attempt > 5) break;
      const backoff = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  /** Run one GET SSE session. Returns whether the stream opened (vs 405/error). */
  private async runEventStream(signal: AbortSignal): Promise<boolean> {
    let opened = false;
    try {
      const stream = this.deps.fetchStream(
        {
          url: this.config.url,
          method: 'GET',
          headers: await this.authedHeaders({
            accept: 'text/event-stream',
            ...(this.lastEventId ? { 'last-event-id': this.lastEventId } : {}),
          }),
          body: undefined,
          provider: 'mcp',
          model: this.config.name ?? 'server',
          signal,
        },
        { queueName: this.deps.queueName ? `${this.deps.queueName}/events` : undefined },
      );
      for await (const ev of stream) {
        opened = true;
        if (signal.aborted) break;
        if (ev.id) this.lastEventId = ev.id; // for resumption on reconnect
        if (!ev.data) continue;
        let msg: import('./base-transport').InboundMessage;
        try {
          msg = JSON.parse(ev.data) as import('./base-transport').InboundMessage;
        } catch {
          continue;
        }
        await this.routeIncoming(msg);
      }
    } catch {
      // stream ended / aborted / 405 — handled by the reconnect loop.
    }
    return opened;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextHttpId++;
    const message = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    let res = await this.post(message);
    if (res.headers['mcp-session-id']) this.sessionId = res.headers['mcp-session-id'];

    // 401 -> re-auth and retry once.
    if (res.status === 401 && this.deps.onUnauthorized && (await this.deps.onUnauthorized())) {
      res = await this.post(message);
      if (res.headers['mcp-session-id']) this.sessionId = res.headers['mcp-session-id'];
    }

    if (res.status >= 400) {
      throw new McpError({ code: McpErrorCode.ConnectionClosed, message: `MCP HTTP ${res.status} for '${method}'` });
    }
    const msg = pickResponse(res.headers['content-type'] ?? '', res.text, id);
    if (!msg) {
      throw new McpError({ code: McpErrorCode.InternalError, message: `MCP: no JSON-RPC response for '${method}'` });
    }
    if (msg.error) throw new McpError(msg.error);
    return msg.result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  async close(): Promise<void> {
    this.eventAbort?.abort();
    this.eventAbort = null;
    if (!this.sessionId) return;
    try {
      await this.deps.fetch(
        {
          url: this.config.url,
          method: 'DELETE',
          headers: await this.authedHeaders(),
          body: undefined,
          provider: 'mcp',
          model: this.config.name ?? 'server',
          responseType: 'text',
        },
        { queueName: this.deps.queueName },
      );
    } catch {
      /* best-effort: server may not support session termination (405) */
    }
    this.sessionId = null;
  }

  // ─── internal ───────────────────────────────────────────────────────────

  /** Send a JSON-RPC response back via POST (used by handleRequest from base). */
  protected sendMessage(obj: unknown): Promise<void> {
    return this.post(obj).then(() => undefined);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.config.headers,
    };
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) h['mcp-protocol-version'] = this.protocolVersion;
    return h;
  }

  /** Base headers + any OAuth bearer + per-call extras. */
  private async authedHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const auth = this.deps.getAuthHeaders ? await this.deps.getAuthHeaders() : {};
    return { ...this.headers(), ...auth, ...extra };
  }

  private async post(body: unknown): Promise<{ status: number; headers: Record<string, string>; text: string }> {
    const res = await this.deps.fetch(
      {
        url: this.config.url,
        method: 'POST',
        headers: await this.authedHeaders(),
        body,
        provider: 'mcp',
        model: this.config.name ?? 'server',
        responseType: 'text',
        timeout: this.deps.timeoutMs,
      },
      { queueName: this.deps.queueName },
    );
    return {
      status: res.status,
      headers: (res.headers ?? {}) as Record<string, string>,
      text: (res.body as string) ?? '',
    };
  }
}

/** Extract the JSON-RPC response matching `id` from a JSON or SSE body. */
function pickResponse(contentType: string, text: string, id: number): JsonRpcResponse | null {
  const messages: JsonRpcResponse[] = [];
  if (contentType.toLowerCase().includes('text/event-stream')) {
    for (const frame of text.split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      if (!data) continue;
      try {
        messages.push(JSON.parse(data) as JsonRpcResponse);
      } catch {
        /* skip non-JSON frame (comments / keep-alives) */
      }
    }
  } else {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcResponse[];
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
    } catch {
      return null;
    }
  }
  return messages.find((m) => m.id === id) ?? null;
}
