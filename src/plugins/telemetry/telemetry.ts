/** TelemetryAdapter — a single tap (HookBus.onAny) that turns the SDK's events
 *  into the three OpenTelemetry signals, with NO `@opentelemetry` dependency:
 *
 *    - TRACES   spans opened/closed from start/complete event pairs, correlated
 *               by `traceId = sessionId:requestId`.
 *    - METRICS  event-driven counters/gauges (cost, tokens, retries, queue depth,
 *               latency samples) — updated ON events, not polled.
 *    - LOGS     the full event stream (name + category + traceId + raw ctx).
 *
 *  An in-memory store backs the sandbox sidebar; `toOtlpTraces()` shapes spans
 *  into OTLP-compatible JSON for a real OTel exporter to forward. */

import type { HookBus } from '../../bus/hook-bus';
import type { HookName } from '../../bus/hook-map';

// ─── Telemetry sanitization constants ─────────────────────────────────────────

/** Replacement token for redacted sensitive values. */
const REDACTED = '***REDACTED***';

/** Query-parameter names whose values must never appear in telemetry. */
const SENSITIVE_QUERY_PARAMS = new Set(['key', 'api_key', 'access_token', 'token']);

/** Header names whose values must never appear in telemetry (lower-cased). */
const SENSITIVE_HEADERS = new Set(['authorization', 'x-goog-api-key', 'x-api-key', 'api-key']);

/** Maximum characters retained from LLMError.raw in telemetry storage.
 *  Raw provider response bodies can be arbitrarily large (full HTML error pages,
 *  streaming partial bodies, etc.). Cap them before they reach event storage or
 *  any ZIP/transcript export. */
const MAX_ERROR_RAW_CHARS = 512;

// ─── OTLP wire conformance ───────────────────────────────────────────────────
//
// The in-memory model is OURS: readable span ids (`mcp:tool:server:name:ts`), a
// domain `kind` the sandbox sidebar groups by, and a `traceId` of
// `sessionId:requestId` a human can grep for. None of that is legal OTLP, and
// rewriting it would break every consumer of `snapshot()` to satisfy a wire format
// they never look at. So the conversion happens at the EDGE, in `toOtlpTraces()`.
//
// What the spec requires, against what was going out before:
//   trace id     16 bytes hex           was `s:r`
//   span id       8 bytes hex           was `llm:s:r`
//   kind         int enum (CLIENT=3)    was the string 'llm'
//   attributes   typed AnyValue         was String(v) for everything — so token
//                                       counts arrived as strings and would not
//                                       aggregate in Prometheus

/** OTel SpanKind enum. GenAI inference and outbound HTTP are CLIENT calls; agent and
 *  tool work runs in-process, so INTERNAL. */
const OTLP_SPAN_KIND = { internal: 1, client: 3 } as const;

const OTLP_KIND_BY_SPAN: Record<SpanKind, number> = {
  llm: OTLP_SPAN_KIND.client,
  http: OTLP_SPAN_KIND.client,
  mcp: OTLP_SPAN_KIND.client,
  media: OTLP_SPAN_KIND.client,
  agent: OTLP_SPAN_KIND.internal,
  tool: OTLP_SPAN_KIND.internal,
  other: OTLP_SPAN_KIND.internal,
};

/** FNV-1a, one 32-bit word per seed. Deterministic, synchronous, dependency-free —
 *  `crypto.subtle.digest` is async and would force the whole export async for an id
 *  nobody verifies cryptographically. */
function fnv1a32(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Derive a conformant hex id from one of our readable ids. `bytes` is 16 for a trace
 *  id, 8 for a span id.
 *
 *  Deterministic on purpose: the same logical trace maps to the same OTLP id on every
 *  export and in every process, so a trace stitched together from two exports — or
 *  from two services sharing a sessionId — still joins up in the backend. */
export function toOtlpId(input: string, bytes: 8 | 16): string {
  let out = '';
  for (let i = 0; i < bytes / 4; i++) {
    out += fnv1a32(input, (0x811c9dc5 + i * 0x9e3779b9) >>> 0)
      .toString(16)
      .padStart(8, '0');
  }
  // An all-zero id is invalid OTLP and gets dropped by the collector.
  return /^0+$/.test(out) ? `${out.slice(0, -1)}1` : out;
}

/** One attribute in OTLP's AnyValue shape, keeping numbers numeric. Integers go out as
 *  `intValue` carrying a STRING, which is how OTLP/JSON encodes 64-bit integers; send
 *  them as plain strings instead and no backend can sum them. */
export function toOtlpValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (value === null || value === undefined) return { stringValue: '' };
  return { stringValue: typeof value === 'object' ? JSON.stringify(value) : String(value) };
}

/** The span name the SPEC asks for: `"{gen_ai.operation.name} {gen_ai.request.model}"`,
 *  e.g. `chat gpt-5.4-nano`. Applied only on export — the internal name stays
 *  `llm.request`, which is what the sandbox groups by and what tests assert.
 *
 *  Falls back to the internal name for spans that carry no GenAI attributes (http,
 *  mcp, tool), where the convention does not apply. */
function otlpSpanName(span: { name: string; attributes: Record<string, unknown> }): string {
  const op = span.attributes['gen_ai.operation.name'];
  const model = span.attributes['gen_ai.request.model'];
  return typeof op === 'string' && typeof model === 'string' ? `${op} ${model}` : span.name;
}

export type SpanKind = 'llm' | 'http' | 'media' | 'agent' | 'tool' | 'mcp' | 'other';

export interface Span {
  traceId: string;
  spanId: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'unset' | 'ok' | 'error';
  attributes: Record<string, unknown>;
}

export interface TelemetryEvent {
  seq: number;
  time: number;
  name: HookName;
  category: string;
  traceId?: string;
  ctx: unknown;
}

export interface TelemetryMetrics {
  // counters
  requests: number;
  errors: number;
  retries: number;
  rateLimitHits: number;
  completions: number;
  mediaGenerated: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  // gauges (current)
  inFlight: number;
  queueDepth: number;
  // latency summary (ms)
  latency: { count: number; min: number; max: number; avg: number };
}

const CATEGORY: Partial<Record<string, string>> = {
  // Network
  onEnqueue: 'network',
  onDequeue: 'network',
  onQueueTimeout: 'network',
  onRequestStart: 'network',
  onRequestComplete: 'network',
  onStreamChunk: 'network',
  onRetry: 'network',
  onRateLimitHit: 'network',
  onRateLimitUpdate: 'network',
  onModelError: 'network',
  // Network realtime (WebSocket)
  onRealtimeOpen: 'realtime',
  onRealtimeFrame: 'realtime',
  onRealtimeClose: 'realtime',
  onRealtimeError: 'realtime',
  // LLM
  onClientCreate: 'llm',
  onClientDestroy: 'llm',
  onMessageResolve: 'llm',
  onBeforeSubmit: 'llm',
  onCompletion: 'llm',
  // Agent
  onAgentCreate: 'agent',
  onAgentDestroy: 'agent',
  onRunStart: 'agent',
  onStepStart: 'agent',
  onStepComplete: 'agent',
  onRunComplete: 'agent',
  onRunError: 'agent',
  onGuardrailTriggered: 'agent',
  onApprovalRequested: 'agent',
  onApprovalResolved: 'agent',
  // Tool (agent-layer tool calls)
  onToolCallStart: 'tool',
  onToolCallComplete: 'tool',
  onToolCallError: 'tool',
  // Internal tools (plugin)
  onInternalToolCallStart: 'tool',
  onInternalToolCallComplete: 'tool',
  onInternalToolCallError: 'tool',
  // Server
  onServerRequest: 'server',
  onServerResponse: 'server',
  onAuthFail: 'server',
  // Cost
  onCostEntry: 'cost',
  onBudgetWarning: 'cost',
  onBudgetExceeded: 'cost',
  // Context
  onContextMeasure: 'context',
  // Media
  onMediaGenerated: 'media',
  onMediaError: 'media',
  // MCP
  onMcpConnect: 'mcp',
  onMcpToolCall: 'mcp',
  onMcpError: 'mcp',
  // Errors / warnings
  onWarning: 'error',
  onInternalError: 'error',
};

/** Pull `sessionId`/`requestId` out of any event ctx (`.trace`, `.ctx`, or flat). */
function traceIdsOf(ctx: unknown): { sessionId?: string; requestId?: string; conversationId?: string } {
  const c = ctx as Record<string, unknown>;
  const t = (c?.trace ?? c?.ctx ?? c) as Record<string, unknown> | undefined;
  return {
    sessionId: t?.sessionId as string | undefined,
    requestId: t?.requestId as string | undefined,
    // `gen_ai.conversation.id` in the semantic conventions — the thread a turn
    // belongs to, which is what lets a backend group turns into one conversation.
    // AgentLoop sets it from the history id; a bare client call has none.
    conversationId: t?.conversationId as string | undefined,
  };
}

const traceKey = (ids: { sessionId?: string; requestId?: string }): string | undefined =>
  ids.requestId ? `${ids.sessionId ?? '?'}:${ids.requestId}` : undefined;

/** OpenTelemetry Resource — identifies the SERVICE producing this telemetry, so
 *  a shared backend can separate streams from different apps and attribute cost
 *  per service (`sum by service.name`). Stamped on every span/metric/log. */
export interface TelemetryResource {
  /** Primary grouping key, e.g. "billing-api". OTel default: "unknown_service". */
  serviceName: string;
  /** Optional namespace/group, e.g. "prod" or a team. */
  serviceNamespace?: string;
  /** Unique instance (pod/host/process); a good default is the engine sessionId. */
  serviceInstanceId?: string;
  serviceVersion?: string;
  /** Arbitrary resource attributes (deployment.environment, cloud.region, …). */
  attributes?: Record<string, string>;
}

export interface TelemetryAdapterOptions {
  /** Cap on retained events (ring buffer). Default 2000. */
  maxEvents?: number;
  /** Service identity stamped on all exported telemetry. */
  resource?: TelemetryResource;
  /** Whether provider error TEXT may be stored in telemetry. Default `true`
   *  (unchanged behaviour, and the same default as the OpenAI Agents SDK's
   *  `trace_include_sensitive_data`).
   *
   *  A provider's `error.message` / `error.raw` can echo request content back —
   *  a moderation refusal quotes the prompt, a validation error names the offending
   *  field and value. URLs and headers are always redacted regardless; this switch
   *  governs the free-text payload. Set `false` when telemetry leaves your trust
   *  boundary (a shared collector, a vendor APM) and the message is replaced by a
   *  fixed `[redacted]` string while name/code/status are kept for triage. */
  includeSensitiveData?: boolean;
}

export class TelemetryAdapter {
  readonly events: TelemetryEvent[] = [];
  readonly spans: Span[] = [];
  readonly metrics: TelemetryMetrics = {
    requests: 0,
    errors: 0,
    retries: 0,
    rateLimitHits: 0,
    completions: 0,
    mediaGenerated: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    inFlight: 0,
    queueDepth: 0,
    latency: { count: 0, min: 0, max: 0, avg: 0 },
  };

  /** Service identity stamped on exported telemetry. */
  readonly resource: TelemetryResource;

  private seq = 0;
  /** Discriminator for POINT spans (media, mcp connect/tool), whose natural keys are
   *  not unique — the same server reconnects, a run emits two images, two tool calls
   *  land in one millisecond. A duplicate span id inside a trace is invalid OTLP and
   *  the backend silently keeps only one. */
  private spanSeq = 0;
  private latSum = 0;
  private readonly open = new Map<string, Span>();
  private readonly maxEvents: number;
  private readonly includeSensitiveData: boolean;
  private readonly unsub: () => void;

  constructor(hooks: HookBus, opts: TelemetryAdapterOptions = {}) {
    this.maxEvents = opts.maxEvents ?? 2000;
    this.includeSensitiveData = opts.includeSensitiveData ?? true;
    this.resource = opts.resource ?? { serviceName: 'unknown_service' };
    this.unsub = hooks.onAny((name, ctx) => this.handle(name, ctx));
  }

  /** Stop tapping the bus. */
  destroy(): void {
    this.unsub();
  }

  private handle(name: HookName, ctx: unknown): void {
    const ids = traceIdsOf(ctx);
    const traceId = traceKey(ids);

    this.events.push({
      seq: this.seq++,
      time: Date.now(),
      name,
      category: CATEGORY[name] ?? 'other',
      traceId,
      ctx: sanitizeEventCtx(name, ctx, this.includeSensitiveData),
    });
    if (this.events.length > this.maxEvents) this.events.shift();

    const c = ctx as Record<string, unknown>;
    switch (name) {
      case 'onBeforeSubmit':
        if (traceId) this.openSpan(`llm:${traceId}`, traceId, 'llm.request', 'llm', {});
        break;
      case 'onCompletion': {
        this.metrics.completions++;
        const usage = (c.response as { usage?: Record<string, number> })?.usage;
        if (usage) {
          this.metrics.inputTokens += usage.inputTokens ?? 0;
          this.metrics.outputTokens += usage.outputTokens ?? 0;
        }
        if (traceId) {
          // OTel GenAI semantic conventions. `gen_ai.provider.name` and
          // `gen_ai.operation.name` are REQUIRED by the spec; we previously sent
          // `gen_ai.provider` / `gen_ai.model`, which are not attribute names any
          // backend recognises, so the spans arrived unrecognised as GenAI at all.
          const responseModel = (c.response as { model?: string } | undefined)?.model;
          const attrs = {
            'gen_ai.provider.name': c.provider,
            'gen_ai.operation.name': 'chat',
            'gen_ai.request.model': c.model,
            // The model that actually answered, which can differ from the one asked
            // for (an alias resolving to a dated snapshot, a router picking a peer).
            'gen_ai.response.model': responseModel,
            'gen_ai.conversation.id': ids.conversationId,
            'gen_ai.usage.input_tokens': usage?.inputTokens,
            'gen_ai.usage.output_tokens': usage?.outputTokens,
          };
          const key = `llm:${traceId}`;
          if (this.open.has(key)) {
            // complete(): span was opened on onBeforeSubmit.
            this.closeSpan(key, 'ok', attrs);
          } else {
            // stream(): no onBeforeSubmit — synthesize the llm span spanning the
            // request's HTTP span (so it has a real duration).
            const http = [...this.spans].reverse().find((s) => s.traceId === traceId && s.kind === 'http');
            const start = http?.startTime ?? Date.now();
            const end = Date.now();
            this.spans.push({
              traceId,
              spanId: key,
              name: 'llm.request',
              kind: 'llm',
              startTime: start,
              endTime: end,
              durationMs: end - start,
              status: 'ok',
              attributes: clean(attrs),
            });
          }
        }
        break;
      }
      case 'onRequestStart': {
        this.metrics.requests++;
        this.metrics.inFlight++;
        if (traceId)
          this.openSpan(`http:${traceId}:${c.attempt ?? 0}`, traceId, 'http.request', 'http', {
            'http.method': c.method,
            'http.url': typeof c.url === 'string' ? sanitizeUrl(c.url) : c.url,
            'llm.queue': c.queueName,
          });
        break;
      }
      case 'onRequestComplete':
        this.metrics.inFlight = Math.max(0, this.metrics.inFlight - 1);
        this.recordLatency(c.latencyMs as number);
        if (traceId)
          this.closeSpan(`http:${traceId}:${c.attempt ?? 0}`, (c.status as number) < 400 ? 'ok' : 'error', {
            'http.status_code': c.status,
          });
        break;
      case 'onEnqueue':
        this.metrics.queueDepth = (c.queueLength as number) ?? this.metrics.queueDepth;
        break;
      case 'onDequeue':
        // queueDepth is a GAUGE: onEnqueue raises it, onDequeue lowers it. The
        // dequeue event already carries the post-dequeue length, so mirror it
        // here — otherwise the gauge only ever climbs and freezes at its peak.
        this.metrics.queueDepth = (c.queueLength as number) ?? this.metrics.queueDepth;
        break;
      case 'onRetry':
        this.metrics.retries++;
        break;
      case 'onRateLimitHit':
        this.metrics.rateLimitHits++;
        break;
      case 'onModelError':
        this.metrics.errors++;
        break;
      case 'onCostEntry':
        this.metrics.costUsd += ((c.entry as { cost?: { total?: number } })?.cost?.total ?? 0) as number;
        break;
      case 'onMediaGenerated':
        this.metrics.mediaGenerated += (c.count as number) ?? 1;
        if (traceId) {
          // Media is reported as a single completed event → a point span.
          const now = Date.now();
          this.spans.push({
            traceId,
            // One run can generate several images; `media:${traceId}` would give them
            // all the same span id, which is invalid within a trace.
            spanId: `media:${traceId}:${this.spanSeq++}`,
            name: 'media.generate',
            kind: 'media',
            startTime: now,
            endTime: now,
            durationMs: 0,
            status: 'ok',
            attributes: clean({ 'media.type': c.mediaType, 'media.count': c.count }),
          });
        }
        break;
      // ─── Agent spans ───────────────────────────────────────────────────
      case 'onRunStart': {
        const runId = c.runId as string | undefined;
        if (runId) {
          this.openSpan(`agent:${runId}`, runId, 'agent.run', 'agent', {
            'agent.id': c.agentId,
            'agent.model': c.model,
          });
        }
        break;
      }
      case 'onRunComplete': {
        const runId = c.runId as string | undefined;
        if (runId) {
          this.closeSpan(`agent:${runId}`, (c.reason as string) === 'error' ? 'error' : 'ok', {
            'agent.reason': c.reason,
          });
        }
        break;
      }
      case 'onRunError': {
        const runId = c.runId as string | undefined;
        if (runId) {
          this.closeSpan(`agent:${runId}`, 'error', {
            'agent.phase': c.phase,
            'agent.error': (c.error as Error)?.message,
          });
        }
        break;
      }
      // ─── Tool spans ────────────────────────────────────────────────────
      case 'onToolCallStart': {
        const callId = c.callId as string | undefined;
        if (callId) {
          this.openSpan(`tool:${callId}`, callId, 'tool.call', 'tool', {
            'tool.name': c.toolName,
            'agent.id': c.agentId,
          });
        }
        break;
      }
      case 'onToolCallComplete': {
        const callId = c.callId as string | undefined;
        if (callId) {
          this.closeSpan(`tool:${callId}`, 'ok', {
            'tool.name': c.toolName,
            'tool.latency_ms': c.latencyMs,
          });
        }
        break;
      }
      case 'onToolCallError': {
        const callId = c.callId as string | undefined;
        if (callId) {
          this.closeSpan(`tool:${callId}`, 'error', {
            'tool.name': c.toolName,
            'tool.error': (c.error as Error)?.message,
          });
        }
        break;
      }
      // ─── MCP spans ─────────────────────────────────────────────────────
      case 'onMcpConnect': {
        // Point span: connect is already done when this fires.
        const server = c.server as string | undefined;
        if (server) {
          const now = Date.now();
          this.spans.push({
            traceId: server,
            // `${server}` alone repeats on every reconnect, and a duplicate span id
            // within a trace is invalid OTLP — the backend keeps one and drops the
            // rest. The counter is monotonic where a timestamp is not: two connects
            // inside the same millisecond would still collide.
            spanId: `mcp:connect:${server}:${this.spanSeq++}`,
            name: 'mcp.connect',
            kind: 'mcp',
            startTime: now,
            endTime: now,
            durationMs: 0,
            status: 'ok',
            attributes: clean({
              'mcp.server': server,
              'mcp.transport': c.transport,
              'mcp.tool_count': c.toolCount,
            }),
          });
        }
        break;
      }
      case 'onMcpToolCall': {
        // Tool call already completed when this fires → point span.
        const server = c.server as string | undefined;
        const tool = c.tool as string | undefined;
        if (server && tool) {
          const now = Date.now();
          const lat = c.latencyMs as number | undefined;
          this.spans.push({
            traceId: server,
            // A timestamp is not a unique key: two tool calls in the same millisecond
            // share it. The counter is.
            spanId: `mcp:tool:${server}:${tool}:${this.spanSeq++}`,
            name: 'mcp.tool_call',
            kind: 'mcp',
            startTime: now - (lat ?? 0),
            endTime: now,
            durationMs: lat ?? 0,
            status: (c.isError as boolean) ? 'error' : 'ok',
            attributes: clean({
              'mcp.server': server,
              'mcp.tool': tool,
              'mcp.is_error': c.isError,
            }),
          });
        }
        break;
      }
    }
  }

  private openSpan(
    key: string,
    traceId: string,
    spanName: string,
    kind: SpanKind,
    attributes: Record<string, unknown>,
  ): Span {
    const span: Span = {
      traceId,
      spanId: key,
      name: spanName,
      kind,
      startTime: Date.now(),
      status: 'unset',
      attributes,
    };
    this.open.set(key, span);
    return span;
  }

  private closeSpan(key: string, status: 'ok' | 'error', attributes: Record<string, unknown>): void {
    const span = this.open.get(key);
    if (!span) return;
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = status;
    Object.assign(span.attributes, clean(attributes));
    this.open.delete(key);
    this.spans.push(span);
  }

  private recordLatency(ms: number): void {
    if (typeof ms !== 'number') return;
    const l = this.metrics.latency;
    l.count++;
    this.latSum += ms;
    l.min = l.count === 1 ? ms : Math.min(l.min, ms);
    l.max = Math.max(l.max, ms);
    l.avg = this.latSum / l.count;
  }

  /** OTLP resource attributes (service.name + extras) — stamped on all exports. */
  private resourceAttributes(): Array<{ key: string; value: { stringValue: string } }> {
    const r = this.resource;
    const out = [{ key: 'service.name', value: { stringValue: r.serviceName } }];
    if (r.serviceNamespace) out.push({ key: 'service.namespace', value: { stringValue: r.serviceNamespace } });
    if (r.serviceInstanceId) out.push({ key: 'service.instance.id', value: { stringValue: r.serviceInstanceId } });
    if (r.serviceVersion) out.push({ key: 'service.version', value: { stringValue: r.serviceVersion } });
    for (const [k, v] of Object.entries(r.attributes ?? {})) {
      out.push({ key: k, value: { stringValue: String(v) } });
    }
    return out;
  }

  /** Snapshot: completed spans, event log, current metrics. */
  snapshot(): { spans: Span[]; events: TelemetryEvent[]; metrics: TelemetryMetrics } {
    return { spans: [...this.spans], events: [...this.events], metrics: { ...this.metrics } };
  }

  /** A debug bundle as a JSON string, with large strings (base64 blobs) trimmed
   *  — for "save the session to a file" download. */
  serialize(): string {
    const bundle = {
      resource: this.resource,
      exportedAt: this.events.at(-1)?.time ?? 0,
      metrics: this.metrics,
      spans: this.spans,
      events: this.events,
    };
    return JSON.stringify(bundle, trimReplacer, 2);
  }

  /** Shape completed spans into OTLP-compatible JSON (resourceSpans) for an
   *  external OpenTelemetry exporter — no SDK dependency here. */
  toOtlpTraces(): unknown {
    return {
      resourceSpans: [
        {
          resource: { attributes: this.resourceAttributes() },
          scopeSpans: [
            {
              scope: { name: 'combycode.telemetry' },
              spans: this.spans.map((s) => ({
                traceId: toOtlpId(s.traceId, 16),
                // Scoped by trace: two conversations can each hold a span keyed
                // `llm:…`, and colliding their ids would merge unrelated traces.
                spanId: toOtlpId(`${s.traceId}|${s.spanId}`, 8),
                name: otlpSpanName(s),
                startTimeUnixNano: Math.round(s.startTime * 1e6),
                endTimeUnixNano: Math.round((s.endTime ?? s.startTime) * 1e6),
                kind: OTLP_KIND_BY_SPAN[s.kind] ?? OTLP_SPAN_KIND.internal,
                status: { code: s.status === 'error' ? 2 : s.status === 'ok' ? 1 : 0 },
                attributes: Object.entries(s.attributes).map(([key, value]) => ({
                  key,
                  value: toOtlpValue(value),
                })),
              })),
            },
          ],
        },
      ],
    };
  }
}

function clean(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/** Cap and redact an LLMError's .raw field for telemetry storage.
 *  Returns a plain object with safe structural fields and .raw bounded to
 *  MAX_ERROR_RAW_CHARS. Exported fields: name, message, code, status, raw.
 *  Arbitrary attached properties (provider, kind, custom data) are NOT spread,
 *  so they never leak into telemetry. Does NOT mutate the original error. */
function sanitizeErrorForTelemetry(
  error: unknown,
  includeSensitiveData: boolean,
): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { value: includeSensitiveData ? String(error) : REDACTED };
  }
  const e = error as Error & { code?: unknown; status?: unknown; raw?: unknown };
  // `name`, `code` and `status` are provider-defined identifiers, never request
  // content — they stay so a redacted trace is still triageable. `message`/`raw`
  // can echo the prompt back, so they are the parts that get dropped.
  const out: Record<string, unknown> = {
    name: e.name,
    message: includeSensitiveData ? e.message : REDACTED,
  };
  if (e.code !== undefined) out.code = e.code;
  if (e.status !== undefined) out.status = e.status;
  if (!includeSensitiveData) return out;
  if (e.raw !== undefined) {
    const rawStr = typeof e.raw === 'string' ? e.raw : JSON.stringify(e.raw);
    const capped =
      rawStr.length > MAX_ERROR_RAW_CHARS
        ? `${rawStr.slice(0, MAX_ERROR_RAW_CHARS)}...[truncated ${rawStr.length - MAX_ERROR_RAW_CHARS} chars]`
        : rawStr;
    out.raw = sanitizeUrl(capped);
  }
  return out;
}

/** Sanitize event ctx before storing: redact URL query params and headers
 *  in event types that carry them, so secrets never reach telemetry storage. */
function sanitizeEventCtx(name: HookName, ctx: unknown, includeSensitiveData = true): unknown {
  if (name !== 'onRequestStart' && name !== 'onRequestComplete' && name !== 'onModelError') {
    return ctx;
  }
  const c = ctx as Record<string, unknown>;
  const out: Record<string, unknown> = { ...c };
  if (typeof out.url === 'string') out.url = sanitizeUrl(out.url);
  if (out.headers !== null && typeof out.headers === 'object') {
    out.headers = sanitizeHeaders(out.headers as Record<string, string>);
  }
  if (name === 'onModelError' && out.error !== undefined) {
    out.error = sanitizeErrorForTelemetry(out.error, includeSensitiveData);
  }
  return out;
}

/** Redact sensitive query parameters from a URL string.
 *  Replaces values of params in SENSITIVE_QUERY_PARAMS with REDACTED. */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const key of SENSITIVE_QUERY_PARAMS) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url;
  }
}

/** Redact sensitive header values, returning a new record. */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}

/** JSON.stringify replacer that truncates huge strings (base64 media blobs) so
 *  an exported debug bundle stays small + readable. Also unwraps Error objects:
 *  `message`/`stack` are non-enumerable, so a raw `JSON.stringify(error)` drops
 *  the most useful field — the actual provider message (e.g. a 400 reason).
 *
 *  Only safe, non-sensitive Error fields are exported: name, message, code, cause.
 *  Arbitrary attached props (which could carry secrets) are NOT spread. */
export function trimReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    const e = value as Error & { code?: unknown; cause?: unknown };
    const out: Record<string, unknown> = { name: e.name, message: e.message };
    if (e.code !== undefined) out.code = e.code;
    // cause is safe only if it's a string or primitive (not a nested object with unknown props)
    if (e.cause !== undefined && (typeof e.cause !== 'object' || e.cause === null)) {
      out.cause = e.cause;
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 512) {
    return `${value.slice(0, 256)}... (${value.length} chars trimmed)`;
  }
  return value;
}
