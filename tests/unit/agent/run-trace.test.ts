/** One agent run must be ONE trace.
 *
 *  The agent built a `runTrace` for its own spans and never handed it to the LLM calls
 *  it made. Those fell through to mint-if-absent in `buildContext` and invented a fresh
 *  `requestId` each time — and since the trace id is `sessionId:requestId`, a single
 *  conversation arrived at the collector as several unrelated traces. Measured against
 *  a real Grafana Tempo endpoint, one turn with one tool call produced SIX.
 *
 *  Nothing about that is visible from inside the library: every span looked fine on its
 *  own. It only shows up when something downstream tries to join them, which is exactly
 *  why it survived until telemetry was pointed at a real backend.
 */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import { TelemetryAdapter } from '../../../src/plugins/telemetry/telemetry';
import type { AgentTool } from '../../../src/agent/types';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ContentPart } from '../../../src/llm/types/messages';
import type { RequestContext } from '../../../src/types/request-context';

const USAGE = { inputTokens: 5, outputTokens: 2, totalTokens: 7, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

const call = (id: string, name: string, args: Record<string, unknown>): ContentPart =>
  ({ type: 'tool_call', id, name, arguments: args }) as unknown as ContentPart;

/** Records the ctx each LLM call received, and emits the events the telemetry adapter
 *  needs to open/close a span — the same pair a real client emits. */
function tracingClient(scripted: Array<ContentPart[]>, hooks: HookBus) {
  const seen: Array<Partial<RequestContext>> = [];
  const queue = [...scripted];
  const client = {
    id: 'mock',
    provider: 'openai',
    model: 'm',
    hooks,
    async complete(_msgs: unknown, opts: { ctx?: Partial<RequestContext> }): Promise<CompletionResponse> {
      const ctx = opts.ctx ?? {};
      seen.push({ ...ctx });
      await hooks.emit('onBeforeSubmit', { ctx } as never);
      const content = queue.shift() ?? [{ type: 'text', text: 'done' } as ContentPart];
      const toolCalls = content.filter((c) => c.type === 'tool_call');
      const res = {
        id: 'r', model: 'm', content, finishReason: toolCalls.length ? 'tool_use' : 'stop',
        usage: USAGE, text: '', toolCalls, thinking: null, media: [], latencyMs: 1, raw: null,
      } as unknown as CompletionResponse;
      await hooks.emit('onCompletion', { provider: 'openai', model: 'm', response: res, ctx } as never);
      return res;
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
  return { client, seen };
}

const echoTool: AgentTool = {
  definition: {
    type: 'function', name: 'echo', description: 'Echo.',
    parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
  },
  execute: async () => 'echoed',
};

describe('a run is one trace', () => {
  it('gives every LLM call in a run the same trace ids', async () => {
    const hooks = new HookBus();
    // Two model calls: the tool-calling turn, then the follow-up after the tool ran.
    const { client, seen } = tracingClient(
      [[call('t1', 'echo', { v: 'x' })], [{ type: 'text', text: 'done' } as ContentPart]],
      hooks,
    );
    const loop = new AgentLoop({ client, hooks, tools: [echoTool] });
    await loop.complete('go');

    expect(seen.length).toBe(2);
    // Before the fix these were two different minted requestIds — two traces.
    expect(seen[0]!.requestId).toBeDefined();
    expect(seen[1]!.requestId).toBe(seen[0]!.requestId!);
    expect(seen[1]!.sessionId).toBe(seen[0]!.sessionId!);
  });

  it('collapses a whole run into a single trace id in the telemetry', async () => {
    const hooks = new HookBus();
    const tel = new TelemetryAdapter(hooks);
    const { client } = tracingClient(
      [[call('t1', 'echo', { v: 'x' })], [{ type: 'text', text: 'done' } as ContentPart]],
      hooks,
    );
    const loop = new AgentLoop({ client, hooks, tools: [echoTool] });
    await loop.complete('go');

    const traces = new Set(tel.snapshot().spans.map((s) => s.traceId));
    expect(traces.size).toBe(1);
  });

  it("lets a caller's own ids win, so an app that owns a request id keeps it", async () => {
    const hooks = new HookBus();
    const { client, seen } = tracingClient([[{ type: 'text', text: 'done' } as ContentPart]], hooks);
    const loop = new AgentLoop({ client, hooks });
    await loop.complete('go', { ctx: { sessionId: 'app-session', requestId: 'app-request' } });

    // The app has better information than we do; overwriting it is how its telemetry
    // stops joining up with ours.
    expect(seen[0]!.sessionId).toBe('app-session');
    expect(seen[0]!.requestId).toBe('app-request');
  });

  it('lets a caller name the conversation, falling back to the history id', async () => {
    const hooks = new HookBus();
    const { client, seen } = tracingClient(
      [[{ type: 'text', text: 'a' } as ContentPart], [{ type: 'text', text: 'b' } as ContentPart]],
      hooks,
    );
    const loop = new AgentLoop({ client, hooks });

    await loop.complete('one', { ctx: { conversationId: 'conv-from-app' } });
    expect(seen[0]!.conversationId).toBe('conv-from-app');

    await loop.complete('two');
    expect(seen[1]!.conversationId).toBe(loop.id);
  });

  it('keeps agent spans and LLM spans together when the caller supplies only a sessionId', async () => {
    // The regression that survived the first fix. The run trace was derived in one
    // place and the LLM ctx in another, so a caller passing HALF the ids split them:
    // `agent.run` kept the agent id while the model calls took the caller's session.
    // Found against a live collector, where the run arrived as two traces.
    const hooks = new HookBus();
    const tel = new TelemetryAdapter(hooks);
    const { client } = tracingClient(
      [[call('t1', 'echo', { v: 'x' })], [{ type: 'text', text: 'done' } as ContentPart]],
      hooks,
    );
    const loop = new AgentLoop({ client, hooks, tools: [echoTool] });
    await loop.complete('go', { ctx: { sessionId: 'app-session' } });

    const spans = tel.snapshot().spans;
    const traces = new Set(spans.map((s) => s.traceId));
    expect(traces.size).toBe(1);
    // …and the agent's own span is in it, not off on the agent id.
    expect(spans.some((s) => s.name === 'agent.run')).toBe(true);
    expect([...traces][0]!.startsWith('app-session:')).toBe(true);
  });

  it('gives every span in a trace a distinct id', async () => {
    // Two LLM calls in one run share the span KEY `llm:${traceId}`. That was harmless
    // while each call had its own trace and became a collision the moment they shared
    // one — the collector merges same-id spans, so a two-call turn showed as one.
    const hooks = new HookBus();
    const tel = new TelemetryAdapter(hooks);
    const { client } = tracingClient(
      [[call('t1', 'echo', { v: 'x' })], [{ type: 'text', text: 'done' } as ContentPart]],
      hooks,
    );
    const loop = new AgentLoop({ client, hooks, tools: [echoTool] });
    await loop.complete('go');

    const ids = tel.snapshot().spans.map((s) => s.spanId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps separate runs in separate traces', async () => {
    const hooks = new HookBus();
    const { client, seen } = tracingClient(
      [[{ type: 'text', text: 'a' } as ContentPart], [{ type: 'text', text: 'b' } as ContentPart]],
      hooks,
    );
    const loop = new AgentLoop({ client, hooks });
    await loop.complete('one');
    await loop.complete('two');

    // Collapsing a run into one trace must not collapse the whole agent into one.
    expect(seen[1]!.requestId).not.toBe(seen[0]!.requestId!);
  });
});

/** …and one run must be one trace INSIDE the caller's trace.
 *
 *  Adopting a `traceparent` was implemented on the telemetry adapter and tested by
 *  feeding the hooks directly — where it passed. It did not work: `beginRun` built the
 *  run trace as `{ sessionId, requestId }` and dropped the header, so only the LLM calls
 *  (built from the caller's ctx) joined the app's trace while `agent.run`, every
 *  `tool.call` and any nested agent rooted a second one. Live run, not a test, again.
 *
 *  So these exercise the loop, not the hooks.
 */
describe('a run joins the caller’s trace', () => {
  const APP_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  const APP_SPAN = '00f067aa0ba902b7';
  const TRACEPARENT = `00-${APP_TRACE}-${APP_SPAN}-01`;

  it('hands the traceparent to every LLM call in the run', async () => {
    const hooks = new HookBus();
    const { client, seen } = tracingClient(
      [[call('t1', 'echo', { v: 'x' })], [{ type: 'text', text: 'done' } as ContentPart]],
      hooks,
    );
    const loop = new AgentLoop({ client, hooks, tools: [echoTool] });
    await loop.complete('go', { ctx: { traceparent: TRACEPARENT } });

    expect(seen.length).toBe(2);
    for (const ctx of seen) expect(ctx.traceparent).toBe(TRACEPARENT);
  });

  it('puts the agent’s own span under the app’s span, not in a trace of its own', async () => {
    const hooks = new HookBus();
    const tel = new TelemetryAdapter(hooks);
    const { client } = tracingClient(
      [[call('t1', 'echo', { v: 'x' })], [{ type: 'text', text: 'done' } as ContentPart]],
      hooks,
    );
    const loop = new AgentLoop({ client, hooks, tools: [echoTool] });
    await loop.complete('go', { ctx: { traceparent: TRACEPARENT } });

    const otlp = tel.toOtlpTraces() as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, string>> }> }>;
    };
    const spans = otlp.resourceSpans[0]!.scopeSpans[0]!.spans;

    // Every span, not just the ones built from the caller's ctx. This is the assertion
    // the hook-level test could not make.
    for (const s of spans) expect(s.traceId).toBe(APP_TRACE);

    const run = spans.find((s) => s.name === 'agent.run')!;
    expect(run.parentSpanId).toBe(APP_SPAN);
  });

  it('hangs the tool call under the run, and the run’s model calls under the run', async () => {
    const hooks = new HookBus();
    const tel = new TelemetryAdapter(hooks);
    const { client } = tracingClient(
      [[call('t1', 'echo', { v: 'x' })], [{ type: 'text', text: 'done' } as ContentPart]],
      hooks,
    );
    const loop = new AgentLoop({ client, hooks, tools: [echoTool] });
    await loop.complete('go', { ctx: { traceparent: TRACEPARENT } });

    const spans = tel.snapshot().spans;
    const run = spans.find((s) => s.name === 'agent.run')!;
    const tool = spans.find((s) => s.name === 'tool.call')!;
    expect(tool.parentSpanId).toBe(run.spanId);
    for (const llm of spans.filter((s) => s.name === 'llm.request')) {
      expect(llm.parentSpanId).toBe(run.spanId);
    }
  });

  it('puts an agent nested in a tool under that tool call, and keeps the outer run intact', async () => {
    // C2-inside-C1's-tool: a second run on the SAME trace. The parent was a single slot
    // per trace, so the inner run overwrote it and then deleted it on close — leaving
    // the rest of the outer run with no parent at all.
    const hooks = new HookBus();
    const tel = new TelemetryAdapter(hooks);
    const { client } = tracingClient(
      [[call('t1', 'nest', { v: 'x' })], [{ type: 'text', text: 'outer done' } as ContentPart]],
      hooks,
    );
    const nestingTool: AgentTool = {
      definition: {
        type: 'function', name: 'nest', description: 'Runs a second agent.',
        parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
      },
      execute: async (_args: unknown, toolCtx: { trace?: Partial<RequestContext> }) => {
        const inner = tracingClient([[{ type: 'text', text: 'inner done' } as ContentPart]], hooks);
        const c2 = new AgentLoop({ client: inner.client, hooks });
        // The tool executor gets the run's trace; handing it down is all a nested agent
        // needs to stay in the same trace.
        await c2.complete('research', { ctx: toolCtx.trace });
        return 'nested';
      },
    };
    const c1 = new AgentLoop({ client, hooks, tools: [nestingTool] });
    await c1.complete('go', { ctx: { traceparent: TRACEPARENT } });

    const spans = tel.snapshot().spans;
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);

    const runs = spans.filter((s) => s.name === 'agent.run');
    expect(runs.length).toBe(2);
    const tool = spans.find((s) => s.name === 'tool.call')!;
    const outer = runs.find((r) => r.spanId === tool.parentSpanId)!;
    const inner = runs.find((r) => r !== outer)!;

    expect(outer.parentSpanId).toBe(APP_SPAN);
    // The research happened inside the tool call, and that is where it belongs.
    expect(inner.parentSpanId).toBe(tool.spanId);

    // The outer run's LAST model call is emitted after the inner run closed. It must
    // still find its parent — this is the assertion the single-slot version failed.
    const outerLlms = spans.filter((s) => s.name === 'llm.request' && s.parentSpanId === outer.spanId);
    expect(outerLlms.length).toBe(2);
  });

  it('still roots its own trace when the caller gives no traceparent', async () => {
    const hooks = new HookBus();
    const tel = new TelemetryAdapter(hooks);
    const { client } = tracingClient([[{ type: 'text', text: 'done' } as ContentPart]], hooks);
    const loop = new AgentLoop({ client, hooks });
    await loop.complete('go');

    // A caller outside any trace must still get usable telemetry.
    const run = tel.snapshot().spans.find((s) => s.name === 'agent.run')!;
    expect(run.parentSpanId).toBeUndefined();
  });
});
