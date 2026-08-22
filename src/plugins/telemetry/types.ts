/** Telemetry types.
 *
 *  Split out of `telemetry.ts` so the adapter file is implementation and this one
 *  is contract — matching how the rest of the codebase is laid out, and making
 *  the public surface of the plugin readable without paging through 1,200 lines.
 */

import type { HookName } from '../../bus/hook-map';

export type SpanKind = 'llm' | 'http' | 'media' | 'agent' | 'tool' | 'mcp' | 'other';

export interface Span {
  traceId: string;
  spanId: string;
  /** The span this one runs under. Without it every span is a sibling and a backend
   *  draws a flat list instead of a tree — so a run reads as "9 things happened", not
   *  "a turn, which called a tool, which asked a second model".
   *
   *  Resolved in this order: the innermost container span still open on this trace
   *  (`agent.run` / `tool.call`), else the app's span from a supplied `traceparent`,
   *  else none — this span is the root. */
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'unset' | 'ok' | 'error';
  attributes: Record<string, unknown>;
}

/** What kind of work an event describes. `message` is conversation content, which is not
 *  a span — it is the thing you want in a debug store and NOT in your metrics backend,
 *  which is exactly why it filters separately. */
export type TraceEventType =
  | 'agent'
  | 'tool'
  | 'llm'
  | 'http'
  | 'mcp'
  | 'media'
  | 'message'
  | 'other';

/** One piece of work, carrying enough of the tree that a consumer can push it straight
 *  into their own tracer without reconstructing anything. */
export interface TraceEvent {
  type: TraceEventType;
  /** The app's trace when it supplied a `traceparent`, else ours. */
  traceId: string;
  spanId: string;
  /** Already resolved past anything this subscriber filtered out — see `survivingParent`. */
  parentSpanId?: string;
  /** The conventional name (`chat gpt-5.4-nano`, `execute_tool search`). */
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'unset' | 'ok' | 'error';
  attributes: Record<string, unknown>;
}

/** Declarative on purpose, rather than a predicate: knowing the types up front lets a
 *  filtered-out event cost nothing, where a predicate would force us to build the payload
 *  just to let the caller throw it away. */
export interface TraceFilter {
  types?: readonly TraceEventType[];
}

export type TraceHandler = (event: TraceEvent) => void;

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
  /** Which event types to hand to `onTrace`. Omitted → everything.
   *
   *  Filtering SPLICES the tree rather than punching holes in it: drop `http` and the
   *  spans under it re-parent to the nearest surviving ancestor. Dropping without that
   *  leaves orphans, and a backend draws an orphan as a second root — worse than not
   *  filtering at all. */
  types?: readonly TraceEventType[];
  /** Whether conversation content rides along on `message` events. Default `'none'`:
   *  prompts and completions are the debugging gold AND the PII, so sending them is a
   *  decision to make on purpose rather than inherit. `'full'` adds the Opt-In
   *  `gen_ai.input.messages` / `gen_ai.output.messages` attributes; `'none'` still
   *  reports the shape (counts and sizes), which is enough to spot a runaway prompt. */
  content?: 'none' | 'full';
  /** Fraction of TRACES to emit, 0..1. Default 1.
   *
   *  Per trace, never per span: sampling spans independently shreds every tree it touches
   *  — a tool call with no run, a model call with no tool. The decision is a hash of the
   *  trace id, so it is stable across processes and two services sharing a trace agree
   *  without coordinating.
   *
   *  This is HEAD sampling: the choice is made when the trace first appears, before we
   *  know whether it ends in an error. Keeping all errors needs tail sampling, which
   *  needs buffering; do that in your collector, which is built for it. */
  sample?: number;
  /** Convenience for the common case of a single sink — same as calling `onTrace`. */
  onTrace?: TraceHandler;
}
