/** Two things a trace could not tell you about an agent run.
 *
 *  **Which agent ran a tool.** `execute_tool` spans carried `gen_ai.agent.id`
 *  and no name, while the `invoke_agent` spans beside them were named — so a
 *  backend grouped tool calls under an opaque id and the agent's own spans
 *  under a label, and joining them was the reader's problem.
 *
 *  **What the run cost.** Token usage went onto the individual chat spans and
 *  into process-wide counters. Neither answers "how much did THIS run spend",
 *  which is the question someone looking at one trace is asking; it had to be
 *  summed by hand from the children.
 *
 *  The name is read back off the run's own span rather than threaded through
 *  `ToolCallStartContext`: widening a public hook context to carry a label only
 *  telemetry wants is the worse trade. Usage is accumulated per TRACE, because
 *  `RequestContext` has no run id and the agent span already shares a trace
 *  with the chat spans underneath it.
 */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { TelemetryAdapter } from '../../../src/plugins/telemetry/telemetry';
import type { TraceEvent } from '../../../src/plugins/telemetry/telemetry';

/** Collect the trace events an adapter exports while a run is driven through
 *  it. `onTrace` is the subscription a real consumer uses, so the test sees
 *  exactly what a backend would. */
function rig() {
  const spans: TraceEvent[] = [];
  const hooks = new HookBus();
  new TelemetryAdapter(hooks, { onTrace: (e) => spans.push(e) });
  // Match on the span-name PREFIX: an exported agent span is named
  // `invoke_agent {label}` when the run had one, and `invoke_agent` when not.
  return { hooks, spans, find: (name: string) => spans.find((s) => s.name.startsWith(name)) };
}

// A trace id is formed from `sessionId:requestId` (or a W3C traceparent), not
// from a `traceId` field — so the context has to carry the ids the adapter
// actually reads, or every span lands on a different trace.
const TRACE = { sessionId: 's-1', requestId: 'q-1' };

describe('gen_ai.agent.name on a tool span', () => {
  it('is the label the run was opened with', async () => {
    const { hooks, spans } = rig();
    await hooks.emit('onRunStart', {
      runId: 'r1',
      agentId: 'a1',
      label: 'triage',
      model: 'gpt-5.4-nano',
      trace: TRACE,
    } as never);
    await hooks.emit('onToolCallStart', {
      runId: 'r1',
      agentId: 'a1',
      step: 1,
      callId: 'c1',
      toolName: 'search',
      arguments: {},
      trace: TRACE,
    } as never);
    await hooks.emit('onToolCallComplete', {
      runId: 'r1',
      agentId: 'a1',
      step: 1,
      callId: 'c1',
      toolName: 'search',
      arguments: {},
      result: 'ok',
      resultSizeBytes: 2,
      trace: TRACE,
    } as never);

    const tool = spans.find((s) => s.type === 'tool');
    expect(tool?.attributes['gen_ai.agent.name']).toBe('triage');
    // The id is still there; this adds to it rather than replacing it.
    expect(tool?.attributes['gen_ai.agent.id']).toBe('a1');
  });

  it('is absent rather than invented when the run had no label', async () => {
    const { hooks, spans } = rig();
    await hooks.emit('onRunStart', { runId: 'r1', agentId: 'a1', trace: TRACE } as never);
    await hooks.emit('onToolCallStart', {
      runId: 'r1',
      agentId: 'a1',
      step: 1,
      callId: 'c1',
      toolName: 'search',
      arguments: {},
      trace: TRACE,
    } as never);
    await hooks.emit('onToolCallComplete', {
      runId: 'r1',
      agentId: 'a1',
      step: 1,
      callId: 'c1',
      toolName: 'search',
      arguments: {},
      result: 'ok',
      resultSizeBytes: 2,
      trace: TRACE,
    } as never);

    const tool = spans.find((s) => s.type === 'tool');
    expect(tool?.attributes['gen_ai.agent.name']).toBeUndefined();
  });

  it('does not break a tool call made outside any run', async () => {
    // A bare client can call a tool with no agent span open at all.
    const { hooks, spans } = rig();
    await hooks.emit('onToolCallStart', {
      runId: 'nope',
      agentId: 'a1',
      step: 1,
      callId: 'c1',
      toolName: 'search',
      arguments: {},
      trace: TRACE,
    } as never);
    await hooks.emit('onToolCallComplete', {
      runId: 'nope',
      agentId: 'a1',
      step: 1,
      callId: 'c1',
      toolName: 'search',
      arguments: {},
      result: 'ok',
      resultSizeBytes: 2,
      trace: TRACE,
    } as never);
    expect(spans.find((s) => s.type === 'tool')?.attributes['gen_ai.agent.name']).toBeUndefined();
  });
});

describe('per-run token usage on the agent span', () => {
  const completion = (inputTokens: number, outputTokens: number) =>
    ({
      provider: 'openai',
      model: 'gpt-5.4-nano',
      response: { model: 'gpt-5.4-nano', usage: { inputTokens, outputTokens } },
      request: { estimatedInputTokens: 0, inputChars: 0, messageCount: 1, hasTools: false },
      ctx: {},
      trace: TRACE,
    }) as never;

  it('sums every call the run made', async () => {
    const { hooks, find } = rig();
    await hooks.emit('onRunStart', { runId: 'r1', agentId: 'a1', trace: TRACE } as never);
    await hooks.emit('onCompletion', completion(10, 3));
    await hooks.emit('onCompletion', completion(20, 7));
    await hooks.emit('onRunComplete', { runId: 'r1', agentId: 'a1', reason: 'stop', trace: TRACE } as never);

    const agent = find('invoke_agent');
    expect(agent?.attributes['gen_ai.usage.input_tokens']).toBe(30);
    expect(agent?.attributes['gen_ai.usage.output_tokens']).toBe(10);
  });

  it('reports what a FAILED run spent, which is when it matters most', async () => {
    const { hooks, find } = rig();
    await hooks.emit('onRunStart', { runId: 'r1', agentId: 'a1', trace: TRACE } as never);
    await hooks.emit('onCompletion', completion(15, 4));
    await hooks.emit('onRunError', {
      runId: 'r1',
      agentId: 'a1',
      phase: 'tool',
      error: new Error('boom'),
      trace: TRACE,
    } as never);

    const agent = find('invoke_agent');
    expect(agent?.status).toBe('error');
    expect(agent?.attributes['gen_ai.usage.input_tokens']).toBe(15);
  });

  it('forgets the run afterwards, so the map cannot grow forever', async () => {
    // A long-lived process must not keep one entry per run it ever served.
    const { hooks, spans } = rig();
    for (const runId of ['r1', 'r2']) {
      await hooks.emit('onRunStart', { runId, agentId: 'a1', trace: TRACE } as never);
      await hooks.emit('onCompletion', completion(5, 1));
      await hooks.emit('onRunComplete', { runId, agentId: 'a1', reason: 'stop', trace: TRACE } as never);
    }
    // The second run sees ITS five tokens, not ten: the first run's total was
    // dropped when it closed.
    const second = spans.filter((s) => s.type === 'agent')[1];
    expect(second?.attributes['gen_ai.usage.input_tokens']).toBe(5);
  });

  it('says nothing when the run made no calls', async () => {
    const { hooks, find } = rig();
    await hooks.emit('onRunStart', { runId: 'r1', agentId: 'a1', trace: TRACE } as never);
    await hooks.emit('onRunComplete', { runId: 'r1', agentId: 'a1', reason: 'stop', trace: TRACE } as never);
    expect(find('invoke_agent')?.attributes).not.toHaveProperty('gen_ai.usage.input_tokens');
  });
});
