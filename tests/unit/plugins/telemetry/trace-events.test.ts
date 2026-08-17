/** The event surface: the SDK hands over events, the consumer decides where they go.
 *
 *  This library is one part of a larger system. The traces an operator cares about are
 *  the business ones — order confirmed, worker selected — and our HTTP retries are detail
 *  to unfold only when something is wrong. So `onTrace` lets a consumer take the levels
 *  they want and feed them into the pipeline they already run.
 *
 *  Two of these tests exist because the naive version of this feature is broken:
 *    - filtering must SPLICE the tree, not punch holes in it
 *    - sampling must be per TRACE, not per span
 *  Get either wrong and the output looks plausible while being unusable, which is the
 *  failure mode this whole area keeps producing.
 */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import { TelemetryAdapter, type TraceEvent } from '../../../../src/plugins/telemetry/telemetry';

const trace = { sessionId: 's', requestId: 'r' };

/** A run that calls one tool, with an HTTP attempt under the model call. */
async function feedRun(bus: HookBus, t: Record<string, string> = trace) {
  await bus.emit('onRunStart', { runId: 'run-1', agentId: 'a1', model: 'm', userMessage: 'hello there', trace: t } as never);
  await bus.emit('onToolCallStart', { runId: 'run-1', agentId: 'a1', step: 0, callId: 'c1', toolName: 'search', arguments: {}, trace: t } as never);
  await bus.emit('onBeforeSubmit', { ctx: t } as never);
  await bus.emit('onRequestStart', { ctx: t, attempt: 0, url: 'https://x/y' } as never);
  await bus.emit('onRequestComplete', { ctx: t, attempt: 0, status: 200 } as never);
  await bus.emit('onCompletion', {
    provider: 'openai', model: 'm',
    response: { model: 'm', text: 'the answer', usage: { inputTokens: 3, outputTokens: 1 } },
    ctx: t,
  } as never);
  await bus.emit('onToolCallComplete', { runId: 'run-1', agentId: 'a1', step: 0, callId: 'c1', toolName: 'search', latencyMs: 2, trace: t } as never);
  await bus.emit('onRunComplete', { runId: 'run-1', agentId: 'a1', reason: 'done', trace: t } as never);
}

const collect = (tel: TelemetryAdapter, filter?: { types: string[] }) => {
  const seen: TraceEvent[] = [];
  if (filter) tel.onTrace(filter as never, (e) => seen.push(e));
  else tel.onTrace((e) => seen.push(e));
  return seen;
};

describe('onTrace', () => {
  it('hands over every event when nothing is filtered', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const seen = collect(tel);
    await feedRun(bus);

    const types = new Set(seen.map((e) => e.type));
    expect(types).toContain('agent');
    expect(types).toContain('tool');
    expect(types).toContain('llm');
    expect(types).toContain('http');
  });

  it('emits nothing once unsubscribed', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const seen: TraceEvent[] = [];
    const stop = tel.onTrace((e) => seen.push(e));
    stop();
    await feedRun(bus);

    expect(seen).toHaveLength(0);
  });

  it('carries the tree, so a consumer never has to rebuild it', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const seen = collect(tel);
    await feedRun(bus);

    const run = seen.find((e) => e.type === 'agent')!;
    const tool = seen.find((e) => e.type === 'tool')!;
    const llm = seen.find((e) => e.type === 'llm')!;
    expect(tool.parentSpanId).toBe(run.spanId);
    expect(llm.parentSpanId).toBe(tool.spanId);
    expect(run.traceId).toBe(tool.traceId);
  });

  it('gives each event a conventional name', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const seen = collect(tel);
    await feedRun(bus);

    expect(seen.find((e) => e.type === 'tool')!.name).toBe('execute_tool search');
    expect(seen.find((e) => e.type === 'agent')!.name).toBe('invoke_agent');
  });
});

describe('filtering splices the tree instead of orphaning it', () => {
  it('re-parents past the levels a subscriber dropped', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    // Ask for business-level work only: no llm, no http.
    const seen = collect(tel, { types: ['agent', 'tool'] });
    await feedRun(bus);

    expect(seen.map((e) => e.type).sort()).toEqual(['agent', 'tool']);
    const run = seen.find((e) => e.type === 'agent')!;
    const tool = seen.find((e) => e.type === 'tool')!;
    // The tool's real parent survived, so nothing moved.
    expect(tool.parentSpanId).toBe(run.spanId);
    expect(run.parentSpanId).toBeUndefined();
  });

  it('re-parents a survivor whose real parent was filtered out', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    // Drop the tool level: the LLM call under it must attach to the RUN, not dangle at
    // a span this subscriber never receives — a backend draws a dangling parent as a
    // second root, which is worse than not filtering.
    const seen = collect(tel, { types: ['agent', 'llm'] });
    await feedRun(bus);

    const run = seen.find((e) => e.type === 'agent')!;
    const llm = seen.find((e) => e.type === 'llm')!;
    expect(llm.parentSpanId).toBe(run.spanId);
  });

  it('roots an event whose whole ancestry was filtered out', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const seen = collect(tel, { types: ['http'] });
    await feedRun(bus);

    const http = seen.find((e) => e.type === 'http')!;
    expect(http).toBeDefined();
    expect(http.parentSpanId).toBeUndefined();
  });

  it('gives two subscribers each a tree correct for its own filter', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const wide = collect(tel);
    const narrow = collect(tel, { types: ['agent', 'llm'] });
    await feedRun(bus);

    // Same span, two different correct answers — re-parenting is per sink, not global.
    const wideLlm = wide.find((e) => e.type === 'llm')!;
    const narrowLlm = narrow.find((e) => e.type === 'llm')!;
    expect(wideLlm.spanId).toBe(narrowLlm.spanId);
    expect(wideLlm.parentSpanId).not.toBe(narrowLlm.parentSpanId);
    expect(narrowLlm.parentSpanId).toBe(narrow.find((e) => e.type === 'agent')!.spanId);
  });
});

describe('sampling is per trace', () => {
  it('keeps or drops a whole trace, never half of one', async () => {
    // A trace that survives must arrive complete. Sampling spans independently would
    // shred every tree it touched: a tool call with no run, a model call with no tool.
    let kept = 0;
    let dropped = 0;
    for (let i = 0; i < 40; i++) {
      const bus = new HookBus();
      const tel = new TelemetryAdapter(bus, { sample: 0.5 });
      const seen = collect(tel);
      await feedRun(bus, { sessionId: 's', requestId: `r${i}` });
      if (seen.length === 0) dropped++;
      else {
        kept++;
        // Complete: the run, its tool and its model call all present.
        const types = new Set(seen.map((e) => e.type));
        expect(types).toContain('agent');
        expect(types).toContain('tool');
        expect(types).toContain('llm');
      }
    }
    // Both outcomes actually occur, so the check above is not vacuous.
    expect(kept).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
  });

  it('decides the same way for the same trace in any process', async () => {
    // Hashed, not random: two services sharing a trace id must agree without talking,
    // or a distributed trace arrives with holes where the other service dropped it.
    const decide = async (rate: number) => {
      const bus = new HookBus();
      const tel = new TelemetryAdapter(bus, { sample: rate });
      const seen = collect(tel);
      await feedRun(bus);
      return seen.length > 0;
    };
    const first = await decide(0.5);
    for (let i = 0; i < 5; i++) expect(await decide(0.5)).toBe(first);
  });

  it('emits everything at the default rate and nothing at zero', async () => {
    const bus1 = new HookBus();
    const all = collect(new TelemetryAdapter(bus1));
    await feedRun(bus1);
    expect(all.length).toBeGreaterThan(0);

    const bus2 = new HookBus();
    const none = collect(new TelemetryAdapter(bus2, { sample: 0 }));
    await feedRun(bus2);
    expect(none).toHaveLength(0);
  });
});

describe('conversation content', () => {
  it('reports the shape but not the text by default', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const seen = collect(tel, { types: ['message'] });
    await feedRun(bus);

    const input = seen.find((e) => e.attributes['message.direction'] === 'input')!;
    expect(input).toBeDefined();
    expect(input.attributes['message.chars']).toBe('hello there'.length);
    // Prompts are the PII. Sending them is a decision, not a default.
    expect(input.attributes['gen_ai.input.messages']).toBeUndefined();
  });

  it('includes the messages when asked, under the Opt-In spec attribute', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus, { content: 'full' });
    const seen = collect(tel, { types: ['message'] });
    await feedRun(bus);

    const input = seen.find((e) => e.attributes['message.direction'] === 'input')!;
    expect(input.attributes['gen_ai.input.messages']).toEqual([{ role: 'user', content: 'hello there' }]);

    const output = seen.find((e) => e.attributes['message.direction'] === 'output')!;
    expect(output.attributes['gen_ai.output.messages']).toEqual([
      { role: 'assistant', content: 'the answer' },
    ]);
  });

  it('hangs a message off the span it belongs to', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus);
    const seen = collect(tel);
    await feedRun(bus);

    const run = seen.find((e) => e.type === 'agent')!;
    const input = seen.find((e) => e.type === 'message' && e.attributes['message.direction'] === 'input')!;
    expect(input.parentSpanId).toBe(run.spanId);
  });

  it('stays out of the span stream, so a metrics backend never sees prompts', async () => {
    const bus = new HookBus();
    const tel = new TelemetryAdapter(bus, { content: 'full' });
    await feedRun(bus);

    // Content rides on `message` events only. Filter them out and the exported spans
    // carry no conversation text at all — that separation is the point of the type.
    expect(JSON.stringify(tel.toOtlpTraces())).not.toContain('hello there');
    expect(tel.snapshot().spans.some((s) => 'gen_ai.input.messages' in s.attributes)).toBe(false);
  });
});
