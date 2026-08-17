/** Exported spans must speak the OTel GenAI conventions.
 *
 *  `agent.run` and `tool.call` are names only we understand. A backend that reads the
 *  conventions can recognise `execute_tool search` as a tool call and chart it without
 *  anyone writing a mapping — and avoiding bespoke per-backend mappings is the entire
 *  reason to do this. (The alternative on offer was a vendor SDK that installs 688
 *  packages and 542 MB, including four of the provider SDKs this library replaces.)
 *
 *  Rules taken from the spec, not from memory —
 *  open-telemetry/semantic-conventions-genai, docs/gen-ai/gen-ai-agent-spans.md:
 *    "Span name SHOULD be `invoke_agent {gen_ai.agent.name}` if `gen_ai.agent.name` is
 *     readily available."
 *    "Span name SHOULD be `execute_tool {gen_ai.tool.name}`." / "Span kind SHOULD be INTERNAL."
 *
 *  The rename is applied at EXPORT only: the internal names stay, because the sandbox
 *  groups by them and a span's identity should not shift with its attributes.
 */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import { TelemetryAdapter } from '../../../../src/plugins/telemetry/telemetry';

type OtlpSpan = { name: string; kind: number; attributes: Array<{ key: string; value: Record<string, unknown> }> };

const otlp = (tel: TelemetryAdapter): OtlpSpan[] =>
  (tel.toOtlpTraces() as { resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }> })
    .resourceSpans[0]!.scopeSpans[0]!.spans;

const attr = (span: OtlpSpan, key: string): unknown =>
  span.attributes.find((a) => a.key === key)?.value.stringValue;

const trace = { sessionId: 's', requestId: 'r' };

async function runWithTool(bus: HookBus) {
  await bus.emit('onRunStart', { runId: 'run-1', agentId: 'agent-7', model: 'gpt-5.4-nano', trace } as never);
  await bus.emit('onToolCallStart', {
    runId: 'run-1', agentId: 'agent-7', step: 0, callId: 'call-1', toolName: 'search', arguments: {}, trace,
  } as never);
  await bus.emit('onToolCallComplete', {
    runId: 'run-1', agentId: 'agent-7', step: 0, callId: 'call-1', toolName: 'search', latencyMs: 5, trace,
  } as never);
  await bus.emit('onRunComplete', { runId: 'run-1', agentId: 'agent-7', reason: 'done', trace } as never);
}

describe('exported span names follow the conventions', () => {
  it('exports a tool call as `execute_tool {name}`, INTERNAL', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await runWithTool(bus);

    const span = otlp(tel).find((s) => s.name.startsWith('execute_tool'))!;
    expect(span).toBeDefined();
    expect(span.name).toBe('execute_tool search');
    expect(span.kind).toBe(1); // INTERNAL, per the spec
    expect(attr(span, 'gen_ai.operation.name')).toBe('execute_tool');
    expect(attr(span, 'gen_ai.tool.name')).toBe('search');
    expect(attr(span, 'gen_ai.tool.call.id')).toBe('call-1');
  });

  it('exports an agent run as `invoke_agent`, carrying the agent id', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await runWithTool(bus);

    const span = otlp(tel).find((s) => s.name.startsWith('invoke_agent'))!;
    expect(span).toBeDefined();
    // Bare, with no trailing subject: the SDK has agent IDs, not human names, and the
    // spec only asks for the subject when it is readily available. An id in the name
    // would read as a name and be wrong.
    expect(span.name).toBe('invoke_agent');
    expect(attr(span, 'gen_ai.operation.name')).toBe('invoke_agent');
    expect(attr(span, 'gen_ai.agent.id')).toBe('agent-7');
    expect(attr(span, 'gen_ai.request.model')).toBe('gpt-5.4-nano');
  });

  it('names the agent span after the agent once a name is available', async () => {
    // Forward-looking: when agents carry a label, the name must fill in on its own
    // rather than needing another change here.
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await runWithTool(bus);

    const span = tel.snapshot().spans.find((s) => s.name === 'agent.run')!;
    span.attributes['gen_ai.agent.name'] = 'briefing';
    expect(otlp(tel).find((s) => s.name.startsWith('invoke_agent'))!.name).toBe('invoke_agent briefing');
  });

  it('keeps the internal names unchanged, so the sandbox and snapshot still group', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await runWithTool(bus);

    const names = tel.snapshot().spans.map((s) => s.name);
    expect(names).toContain('agent.run');
    expect(names).toContain('tool.call');
  });

  it('leaves spans outside the conventions alone', async () => {
    // http/mcp spans have no gen_ai.operation.name and must keep their own names
    // rather than being forced into a vocabulary that has no term for them.
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    await bus.emit('onRequestStart', { ctx: trace, attempt: 0, url: 'https://x/y' } as never);
    await bus.emit('onRequestComplete', { ctx: trace, attempt: 0, status: 200 } as never);

    expect(otlp(tel).find((s) => s.name === 'http.request')).toBeDefined();
  });
});
