/** `toOtlpTraces()` has to produce something a real OTLP endpoint will accept.
 *
 *  It previously produced something that only LOOKED like OTLP: `traceId: "s:r"`,
 *  `spanId: "llm:s:r"`, `kind: "llm"`, and every attribute value stringified. A
 *  collector rejects the ids outright, and a backend that does ingest it cannot sum
 *  `gen_ai.usage.input_tokens` because the tokens arrive as text.
 *
 *  The internal model is deliberately NOT changed by any of this — readable ids and
 *  the domain `kind` are what the sandbox groups by — so these tests also pin that
 *  `snapshot()` still returns the human-readable shape.
 *
 *  Attribute names come from the OTel GenAI semantic conventions, where
 *  `gen_ai.provider.name` and `gen_ai.operation.name` are REQUIRED. We were sending
 *  `gen_ai.provider` and `gen_ai.model`, which are not names any backend knows, so
 *  the spans did not register as GenAI at all.
 */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import { TelemetryAdapter, toOtlpId, toOtlpValue } from '../../../../src/plugins/telemetry/telemetry';

type OtlpSpan = {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
};

const otlpSpans = (tel: TelemetryAdapter): OtlpSpan[] =>
  (tel.toOtlpTraces() as { resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }> }).resourceSpans[0]!
    .scopeSpans[0]!.spans;

const attr = (span: OtlpSpan, key: string) => span.attributes.find((a) => a.key === key)?.value;

async function feedRequest(bus: HookBus, trace: Record<string, string>, model = 'gpt-5.4-nano') {
  await bus.emit('onBeforeSubmit', { ctx: trace } as never);
  await bus.emit('onRequestStart', {
    provider: 'openai', model, queueName: 'q', url: 'https://api/x', method: 'POST',
    attempt: 0, idempotencyKey: 'k', streaming: false, trace,
  } as never);
  await bus.emit('onRequestComplete', {
    provider: 'openai', model, queueName: 'q', status: 200, headers: {},
    latencyMs: 42, attempt: 0, bodySize: 0, streaming: false, trace,
  } as never);
  await bus.emit('onCompletion', {
    provider: 'openai', model,
    response: { model: `${model}-2026-08-01`, usage: { inputTokens: 10, outputTokens: 5 } },
    ctx: trace,
  } as never);
}

describe('OTLP ids', () => {
  it('emits 16-byte trace ids and 8-byte span ids as hex', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRequest(bus, { sessionId: 's', requestId: 'r' });

    for (const span of otlpSpans(tel)) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('keeps the readable ids in snapshot(), which is what the UI groups by', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRequest(bus, { sessionId: 's', requestId: 'r' });

    // The conversion is an EDGE concern; the in-memory model stays ours.
    expect(tel.snapshot().spans.every((s) => s.traceId === 's:r')).toBe(true);
    expect(tel.snapshot().spans.some((s) => s.name === 'llm.request')).toBe(true);
  });

  it('is deterministic, so a trace split across exports still joins up', () => {
    expect(toOtlpId('s:r', 16)).toBe(toOtlpId('s:r', 16));
    expect(toOtlpId('s:r', 16)).not.toBe(toOtlpId('s:r2', 16));
  });

  it('gives every span a distinct id, including repeated point events', async () => {
    // The case that actually collided: point spans keyed by something that repeats.
    // `mcp:connect:${server}` is the same string on every reconnect, and
    // `media:${traceId}` is the same for two images in one run. A duplicate span id
    // within a trace is invalid OTLP, and the backend keeps one and drops the rest —
    // silently, so the run just looks like it did less work than it did.
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const trace = { sessionId: 's', requestId: 'r' };

    await bus.emit('onMcpConnect', { server: 'deepwiki', transport: 'http', toolCount: 3 } as never);
    await bus.emit('onMcpConnect', { server: 'deepwiki', transport: 'http', toolCount: 3 } as never);
    await bus.emit('onMediaGenerated', { mediaType: 'image', count: 1, trace } as never);
    await bus.emit('onMediaGenerated', { mediaType: 'image', count: 1, trace } as never);

    const ids = otlpSpans(tel).map((s) => `${s.traceId}:${s.spanId}`);
    expect(ids.length).toBe(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('keeps ids of different traces apart', async () => {
    const a = new HookBus();
    const telA = new TelemetryAdapter(a);
    await feedRequest(a, { sessionId: 's', requestId: 'r1' });
    const b = new HookBus();
    const telB = new TelemetryAdapter(b);
    await feedRequest(b, { sessionId: 's', requestId: 'r2' });

    const idA = otlpSpans(telA).map((s) => s.spanId);
    const idB = otlpSpans(telB).map((s) => s.spanId);
    expect(idA.some((id) => idB.includes(id))).toBe(false);
  });

  it('never emits an all-zero id, which a collector drops', () => {
    // Whatever the input, the output must stay a valid id.
    for (const input of ['', '0', 'a', 's:r']) {
      expect(toOtlpId(input, 16)).not.toMatch(/^0+$/);
      expect(toOtlpId(input, 8)).not.toMatch(/^0+$/);
    }
  });
});

describe('OTLP span kind + name', () => {
  it('maps the domain kind onto the int enum', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRequest(bus, { sessionId: 's', requestId: 'r' });

    // 3 = CLIENT. A string here is not a legal SpanKind.
    for (const span of otlpSpans(tel)) {
      expect(typeof span.kind).toBe('number');
      expect(span.kind).toBe(3);
    }
  });

  it('names GenAI spans "{operation} {model}" per the convention', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRequest(bus, { sessionId: 's', requestId: 'r' });

    const names = otlpSpans(tel).map((s) => s.name);
    expect(names).toContain('chat gpt-5.4-nano');
    // A span with no GenAI attributes keeps its own name — the convention does not
    // apply to an HTTP span.
    expect(names).toContain('http.request');
  });
});

describe('OTLP attribute values', () => {
  it('sends token counts as intValue so a backend can sum them', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRequest(bus, { sessionId: 's', requestId: 'r' });

    const llm = otlpSpans(tel).find((s) => s.name.startsWith('chat '))!;
    // OTLP/JSON encodes 64-bit ints as strings inside intValue — the point is the
    // KEY, not the quoting: `stringValue` here means no aggregation.
    expect(attr(llm, 'gen_ai.usage.input_tokens')).toEqual({ intValue: '10' });
    expect(attr(llm, 'gen_ai.usage.output_tokens')).toEqual({ intValue: '5' });
  });

  it('types each value by what it is', () => {
    expect(toOtlpValue(42)).toEqual({ intValue: '42' });
    expect(toOtlpValue(1.5)).toEqual({ doubleValue: 1.5 });
    expect(toOtlpValue(true)).toEqual({ boolValue: true });
    expect(toOtlpValue('x')).toEqual({ stringValue: 'x' });
    expect(toOtlpValue({ a: 1 })).toEqual({ stringValue: '{"a":1}' });
    // NaN/Infinity are not representable; they must not become a broken number.
    expect(toOtlpValue(Number.NaN)).toEqual({ stringValue: 'NaN' });
  });
});

describe('GenAI semantic conventions', () => {
  it('uses the REQUIRED attribute names', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRequest(bus, { sessionId: 's', requestId: 'r' });

    const llm = tel.snapshot().spans.find((s) => s.name === 'llm.request')!;
    expect(llm.attributes['gen_ai.provider.name']).toBe('openai');
    expect(llm.attributes['gen_ai.operation.name']).toBe('chat');
    expect(llm.attributes['gen_ai.request.model']).toBe('gpt-5.4-nano');
    // The model that actually answered can differ from the one requested.
    expect(llm.attributes['gen_ai.response.model']).toBe('gpt-5.4-nano-2026-08-01');

    // The old, unrecognised names must be gone — leaving them would double-report.
    expect('gen_ai.provider' in llm.attributes).toBe(false);
    expect('gen_ai.model' in llm.attributes).toBe(false);
  });

  it('carries the conversation id when the run has one', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRequest(bus, { sessionId: 's', requestId: 'r', conversationId: 'conv-7' });

    const llm = tel.snapshot().spans.find((s) => s.name === 'llm.request')!;
    expect(llm.attributes['gen_ai.conversation.id']).toBe('conv-7');
  });

  it('omits the conversation id for a bare client call rather than inventing one', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await feedRequest(bus, { sessionId: 's', requestId: 'r' });

    const llm = tel.snapshot().spans.find((s) => s.name === 'llm.request')!;
    expect('gen_ai.conversation.id' in llm.attributes).toBe(false);
  });
});
