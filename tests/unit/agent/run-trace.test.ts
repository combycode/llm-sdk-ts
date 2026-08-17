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
