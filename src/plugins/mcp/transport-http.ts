/** Streamable-HTTP MCP transport — each call is a POST through the engine's
 *  `fetch` (so it rides the central queue + network telemetry, never side-fetch).
 *  Cross-env (works in the browser when the server allows CORS). Handles a
 *  single request/response per call: the response body is either one JSON-RPC
 *  message (`application/json`) or an SSE batch (`text/event-stream`). The
 *  long-lived server->client GET stream reconnects with backoff + Last-Event-ID
 *  for resumption. */

import type { EngineFetch, EngineFetchStream, SSEEvent } from '../../network/types';
import { McpError, McpErrorCode } from './jsonrpc';
import {
  MCP_METHOD_HEADER,
  MCP_NAME_BEARING_METHODS,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION_HEADER,
  encodeMcpHeaderValue,
  isModernMcpVersion,
} from './protocol-version';
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

/** Resumption budget for a dropped long-lived stream. Bounded on purpose: an
 *  unbounded retry against a server that is simply gone is indistinguishable from a hang,
 *  and the caller is told the subscription ended either way. */
const MAX_RESUME_ATTEMPTS = 5;
const RESUME_BACKOFF_MS = 500;

export class HttpTransport extends BaseJsonRpcTransport implements McpTransport {
  private nextHttpId = 0;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  /** Handshake until negotiation says otherwise — an un-negotiated connection must behave exactly
   *  as it did before 2026 support existed. */
  private era: 'handshake' | 'modern' = 'handshake';
  private eventAbort: AbortController | null = null;
  private lastEventId: string | null = null;
  /** Live `subscriptions/listen` streams, so `close()` can tear them down. Without this a closed
   *  client would leave the POST hanging until the server gave up on it. */
  private readonly streamAborts = new Set<AbortController>();

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

  setEra(era: 'handshake' | 'modern'): void {
    this.era = era;
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
    const routing = this.routingHeaders(method, params);
    let res = await this.post(message, routing);
    if (res.headers['mcp-session-id']) this.sessionId = res.headers['mcp-session-id'];

    // 401 -> re-auth and retry once.
    if (res.status === 401 && this.deps.onUnauthorized && (await this.deps.onUnauthorized())) {
      res = await this.post(message, routing);
      if (res.headers['mcp-session-id']) this.sessionId = res.headers['mcp-session-id'];
    }

    if (res.status >= 400) {
      // A 4xx MAY still carry a JSON-RPC error body, and for negotiation that body is the whole
      // point: -32022 is what tells us which versions the server speaks. Collapsing every 4xx into
      // ConnectionClosed threw that away, so a modern-only server looked like a dead connection.
      const errBody = pickResponse(res.headers['content-type'] ?? '', res.text, id);
      if (errBody?.error) throw new McpError(errBody.error);
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
    for (const abort of this.streamAborts) abort.abort();
    this.streamAborts.clear();
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

  /** Open a long-lived request whose RESPONSE BODY is the event stream.
   *
   *  This is how `subscriptions/listen` works on Streamable HTTP: unlike an ordinary call, the POST
   *  does not return a single JSON-RPC message — the server holds the response open and writes
   *  notification frames as they occur, closing it only when the subscription ends. So it goes
   *  through `fetchStream` (streaming response) rather than the buffered `post()` path, which would
   *  surface the frames only after the stream closed.
   *
   *  Frames are routed exactly like the GET channel's, so the client sees no difference between the
   *  two. The eventual JSON-RPC response has no pending entry to settle — its only meaning is "the
   *  stream ended", which is reported through `onEnd`. */
  override async sendLongLivedRequest(
    method: string,
    params?: unknown,
    onEnd?: (error?: unknown) => void,
  ): Promise<number> {
    const id = this.allocateId();
    const message = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    const abort = new AbortController();
    this.streamAborts.add(abort);

    const stream = this.deps.fetchStream(
      {
        url: this.config.url,
        method: 'POST',
        headers: await this.authedHeaders({
          // BOTH media types, exactly as an ordinary POST sends: a modern server answers
          // `text/event-stream` alone with **406 Not Acceptable** and an empty body, so the
          // subscription was rejected before it began and `listen()` handed back a stream
          // that could never deliver. Verified against mcp-py 2.0.0 Streamable HTTP
          // (2026-08-09): 406 with this header, 200 + frames with both.
          accept: 'application/json, text/event-stream',
          ...this.routingHeaders(method, params),
        }),
        body: message,
        provider: 'mcp',
        model: this.config.name ?? 'server',
        signal: abort.signal,
      },
      { queueName: this.deps.queueName ? `${this.deps.queueName}/events` : undefined },
    );

    // Consume in the background: the caller gets the id immediately and receives frames through
    // the normal incoming path. Awaiting here would block until the subscription ENDED.
    void (async () => {
      let failure: unknown;
      /** Last id seen on THIS stream — the resumption cursor. Kept separately from the
       *  shared `lastEventId`, which the standalone GET stream also writes. */
      let cursor: string | undefined;

      /** Drain one stream. Returns true if it delivered anything (used to reset backoff). */
      const drain = async (s: AsyncIterable<SSEEvent>): Promise<boolean> => {
        let delivered = false;
        for await (const ev of s) {
          if (abort.signal.aborted) break;
          if (ev.id) {
            this.lastEventId = ev.id;
            cursor = ev.id;
          }
          if (!ev.data) continue;
          delivered = true;
          let msg: import('./base-transport').InboundMessage;
          try {
            msg = JSON.parse(ev.data) as import('./base-transport').InboundMessage;
          } catch {
            continue; // comment / keep-alive frame
          }
          await this.routeIncoming(msg);
        }
        return delivered;
      };

      try {
        await drain(stream);

        // The stream ended without the request completing. If the server gave us event ids
        // we can ask it to replay what we missed — reconnect with `Last-Event-ID`, exactly
        // as the reference client does. Without this a single blip permanently kills a
        // subscription, and on the 2026-07-28 wire `subscriptions/listen` is the ONLY
        // notification channel, so "permanently" means the caller stops seeing changes.
        for (let attempt = 0; cursor && !abort.signal.aborted && attempt < MAX_RESUME_ATTEMPTS; ) {
          await new Promise((r) => setTimeout(r, RESUME_BACKOFF_MS * 2 ** attempt));
          if (abort.signal.aborted) break;
          try {
            const resumed = this.deps.fetchStream(
              {
                url: this.config.url,
                method: 'GET',
                headers: await this.authedHeaders({
                  accept: 'text/event-stream',
                  'last-event-id': cursor,
                }),
                body: undefined,
                provider: 'mcp',
                model: this.config.name ?? 'server',
                signal: abort.signal,
              },
              { queueName: this.deps.queueName ? `${this.deps.queueName}/events` : undefined },
            );
            // A reconnect that delivered frames earns a fresh budget; one that opened and
            // died immediately counts against it, so a flapping server still terminates.
            attempt = (await drain(resumed)) ? 0 : attempt + 1;
          } catch (e) {
            failure = e;
            attempt += 1;
          }
        }
      } catch (e) {
        // A rejected subscription (4xx) or a dropped connection. Reported rather than swallowed:
        // a caller holding a subscription that silently stopped delivering has no way to find out.
        if (!abort.signal.aborted) failure = e;
      } finally {
        this.streamAborts.delete(abort);
        // Always settle: whether we resumed and later gave up, or never could, the caller
        // must learn the subscription is over instead of waiting on a dead stream forever.
        onEnd?.(failure);
      }
    })();

    return id;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.config.headers,
    };
    // The 2026-07-28 wire is stateless: there is no session to identify, and sending a stale
    // `Mcp-Session-Id` invites a header/body mismatch (-32020).
    if (this.sessionId && this.era === 'handshake') h['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) h[MCP_PROTOCOL_VERSION_HEADER] = this.protocolVersion;
    return h;
  }

  /** Modern-era routing headers: `Mcp-Method` on every request, plus `Mcp-Name` carrying the
   *  method's subject (tool name / prompt name / resource URI) so a gateway can route and
   *  authorize without parsing the body. No-op on the handshake wire. */
  private routingHeaders(method: string, params?: unknown): Record<string, string> {
    // Driven by the version this request DECLARES, not by the negotiated era: the
    // `server/discover` probe already says `MCP-Protocol-Version: 2026-07-28`, and a modern
    // server rejects a request whose `Mcp-Method` does not match its body — including a
    // missing one. Era is only set after discover succeeds, so keying on it left the probe
    // itself half-modern. Found against mcp-py 2.0.0 Streamable HTTP (2026-08-09).
    const modern = this.era === 'modern' || isModernMcpVersion(this.protocolVersion ?? '');
    if (!modern) return {};
    const h: Record<string, string> = { [MCP_METHOD_HEADER]: method };
    const key = MCP_NAME_BEARING_METHODS[method];
    if (key && params && typeof params === 'object') {
      const value = (params as Record<string, unknown>)[key];
      if (typeof value === 'string') h[MCP_NAME_HEADER] = encodeMcpHeaderValue(value);
    }
    return h;
  }

  /** Base headers + any OAuth bearer + per-call extras. */
  private async authedHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const auth = this.deps.getAuthHeaders ? await this.deps.getAuthHeaders() : {};
    return { ...this.headers(), ...auth, ...extra };
  }

  private async post(
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; headers: Record<string, string>; text: string }> {
    const res = await this.deps.fetch(
      {
        url: this.config.url,
        method: 'POST',
        headers: await this.authedHeaders(extraHeaders),
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
/** The media-type ESSENCE of a Content-Type: type/subtype, lowercased, parameters stripped.
 *
 *  A substring test misroutes anything that merely *contains* the token — `application/json` with a
 *  vendor parameter mentioning it, or a hypothetical `application/vnd.text/event-stream+json` —
 *  while still needing to cope with the ordinary `text/event-stream; charset=utf-8`. Comparing the
 *  essence handles both. Matches the fix upstream shipped in mcp-ts 1.30. */
export function mediaTypeEssence(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

function pickResponse(contentType: string, text: string, id: number): JsonRpcResponse | null {
  const messages: JsonRpcResponse[] = [];
  if (mediaTypeEssence(contentType) === 'text/event-stream') {
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
