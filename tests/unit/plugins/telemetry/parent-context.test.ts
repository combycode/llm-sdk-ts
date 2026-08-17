/** The library must be able to run INSIDE somebody else's trace.
 *
 *  An application owns the span where a client request arrives — the library never sees
 *  that boundary and cannot invent it. Until it could adopt a parent, its spans always
 *  rooted a trace of their own, so a business chain and the model calls it triggered
 *  reached the backend as two unrelated traces with no way to join them.
 *
 *  Two separate things are checked here, because either one alone is useless:
 *    - the app's TRACE is adopted (same trace id, unhashed)
 *    - the app's SPAN is the parent (a tree, not two roots side by side)
 */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import { TelemetryAdapter, parseTraceparent } from '../../../../src/plugins/telemetry/telemetry';

const APP_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const APP_SPAN = '00f067aa0ba902b7';
const TRACEPARENT = `00-${APP_TRACE}-${APP_SPAN}-01`;

type OtlpSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string };
const otlp = (tel: TelemetryAdapter): OtlpSpan[] =>
  (tel.toOtlpTraces() as { resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }> })
    .resourceSpans[0]!.scopeSpans[0]!.spans;

async function feedRun(bus: HookBus, trace: Record<string, string>) {
  await bus.emit('onRunStart', { runId: 'run-1', agentId: 'a1', model: 'm', trace } as never);
  await bus.emit('onBeforeSubmit', { ctx: trace } as never);
  await bus.emit('onCompletion', {
    provider: 'openai', model: 'm',
    response: { usage: { inputTokens: 3, outputTokens: 1 } },
    ctx: trace,
  } as never);
  await bus.emit('onRunComplete', { runId: 'run-1', agentId: 'a1', reason: 'done', trace } as never);
}

describe('parseTraceparent', () => {
  it('accepts a well-formed header', () => {
    expect(parseTraceparent(TRACEPARENT)).toEqual({ traceId: APP_TRACE, spanId: APP_SPAN });
  });

  it('rejects malformed and all-zero ids rather than routing telemetry somewhere wrong', () => {
    for (const bad of [
      undefined,
      '',
      'garbage',
      `00-${APP_TRACE}-${APP_SPAN}`, // missing flags
      `00-${'0'.repeat(32)}-${APP_SPAN}-01`, // all-zero trace, forbidden by the spec
      `00-${APP_TRACE}-${'0'.repeat(16)}-01`, // all-zero span
      `00-${APP_TRACE.slice(0, 31)}-${APP_SPAN}-01`, // short trace
    ]) {
      expect(parseTraceparent(bad as string | undefined)).toBeNull();
    }
  });
});

describe('adopting the app’s trace', () => {
  it('joins the caller’s trace instead of rooting its own', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRun(bus, { sessionId: 's', requestId: 'r', traceparent: TRACEPARENT });

    const spans = otlp(tel);
    expect(spans.length).toBeGreaterThan(0);
    // Verbatim, not hashed: hashing would land in a different trace and defeat the point.
    for (const s of spans) expect(s.traceId).toBe(APP_TRACE);
  });

  it('hangs the run under the app’s span', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRun(bus, { sessionId: 's', requestId: 'r', traceparent: TRACEPARENT });

    const run = otlp(tel).find((s) => s.name === 'invoke_agent')!;
    expect(run.parentSpanId).toBe(APP_SPAN);
  });

  it('nests work under the run, not flat under the app', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRun(bus, { sessionId: 's', requestId: 'r', traceparent: TRACEPARENT });

    const spans = otlp(tel);
    const run = spans.find((s) => s.name === 'invoke_agent')!;
    const llm = spans.find((s) => s.name.startsWith('chat ') || s.name === 'llm.request')!;
    // An LLM call made during a run belongs to the run. Attaching it straight to the
    // app's span would flatten the nesting the tree exists to show.
    expect(llm.parentSpanId).toBe(run.spanId);
    expect(llm.parentSpanId).not.toBe(APP_SPAN);
  });

  it('still works with no traceparent — its own trace, no parent', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRun(bus, { sessionId: 's', requestId: 'r' });

    const spans = otlp(tel);
    for (const s of spans) expect(s.traceId).not.toBe(APP_TRACE);
    const run = spans.find((s) => s.name === 'invoke_agent')!;
    expect(run.parentSpanId).toBeUndefined();
  });

  it('ignores a malformed traceparent rather than dropping the telemetry', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRun(bus, { sessionId: 's', requestId: 'r', traceparent: 'not-a-traceparent' });

    // Falls back to our own trace: a bad header from an upstream caller must not cost
    // the run its telemetry.
    expect(otlp(tel).length).toBeGreaterThan(0);
  });

  it('does not keep a finished run as the parent of later work', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRun(bus, { sessionId: 's', requestId: 'r1', traceparent: TRACEPARENT });
    // A second, unrelated run on its own trace must not inherit the first run's span.
    await feedRun(bus, { sessionId: 's', requestId: 'r2' });

    const second = otlp(tel).filter((s) => s.traceId !== APP_TRACE);
    const run = second.find((s) => s.name === 'invoke_agent')!;
    expect(run.parentSpanId).toBeUndefined();
  });
});

describe('only containers become parents', () => {
  it('does not let an open LLM span adopt the HTTP attempt underneath it', async () => {
    // A leaf span must never sit on the parent stack. `llm.request` is open while its
    // HTTP attempts run, so if leaves were containers the attempt would hang off it —
    // and because its span key is shared across concurrent calls on one trace, a missed
    // close would leave it parenting everything that followed for the trace's lifetime.
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const trace = { sessionId: 's', requestId: 'r', traceparent: TRACEPARENT };

    await bus.emit('onRunStart', { runId: 'run-1', agentId: 'a1', model: 'm', trace } as never);
    await bus.emit('onBeforeSubmit', { ctx: trace } as never);
    await bus.emit('onRequestStart', { ctx: trace, attempt: 0, url: 'https://x/y' } as never);
    await bus.emit('onRequestComplete', { ctx: trace, attempt: 0, status: 200 } as never);
    await bus.emit('onCompletion', {
      provider: 'openai', model: 'm',
      response: { usage: { inputTokens: 3, outputTokens: 1 } },
      ctx: trace,
    } as never);
    await bus.emit('onRunComplete', { runId: 'run-1', agentId: 'a1', reason: 'done', trace } as never);

    const spans = tel.snapshot().spans;
    const llm = spans.find((s) => s.name === 'llm.request')!;
    const http = spans.find((s) => s.name === 'http.request')!;
    const run = spans.find((s) => s.name === 'agent.run')!;
    expect(http.parentSpanId).not.toBe(llm.spanId);
    expect(http.parentSpanId).toBe(run.spanId);
  });
});
