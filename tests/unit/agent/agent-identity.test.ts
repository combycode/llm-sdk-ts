/** An agent should be identifiable in a trace.
 *
 *  Without a label, telemetry has only the generated agent id: every run exports as a bare
 *  `invoke_agent`, and the ids differ per process, so you cannot tell which of your agents
 *  ran, nor compare the same agent across runs. `label` is what turns a span into
 *  `invoke_agent briefing`; `source` says which part of the host system it belongs to; and
 *  `attributes` carries whatever those two do not.
 */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import { TelemetryAdapter } from '../../../src/plugins/telemetry/telemetry';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ContentPart } from '../../../src/llm/types/messages';

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

function mockClient(hooks: HookBus): LLMClient {
  return {
    id: 'mock', provider: 'openai', model: 'm', hooks,
    async complete(_msgs: unknown, opts: { ctx?: Record<string, unknown> }): Promise<CompletionResponse> {
      const ctx = opts.ctx ?? {};
      await hooks.emit('onBeforeSubmit', { ctx } as never);
      const res = {
        id: 'r', model: 'm', content: [{ type: 'text', text: 'done' } as ContentPart],
        finishReason: 'stop', usage: USAGE, text: 'done', toolCalls: [], thinking: null,
        media: [], latencyMs: 1, raw: null,
      } as unknown as CompletionResponse;
      await hooks.emit('onCompletion', { provider: 'openai', model: 'm', response: res, ctx } as never);
      return res;
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
}

const otlpNames = (tel: TelemetryAdapter): string[] =>
  (tel.toOtlpTraces() as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }> })
    .resourceSpans[0]!.scopeSpans[0]!.spans.map((s) => s.name);

const runSpan = (tel: TelemetryAdapter) => tel.snapshot().spans.find((s) => s.name === 'agent.run')!;

describe('agent identity in telemetry', () => {
  it('names the exported span after the label', async () => {
    const hooks = new HookBus();
    const tel = new TelemetryAdapter(hooks);
    const loop = new AgentLoop({ client: mockClient(hooks), hooks, label: 'briefing' });
    await loop.complete('go');

    expect(otlpNames(tel)).toContain('invoke_agent briefing');
    expect(runSpan(tel).attributes['gen_ai.agent.name']).toBe('briefing');
  });

  it('carries the source as our own attribute', async () => {
    const hooks = new HookBus();
    const tel = new TelemetryAdapter(hooks);
    const loop = new AgentLoop({ client: mockClient(hooks), hooks, label: 'brief', source: 'customer' });
    await loop.complete('go');

    // `agent.source`, not `gen_ai.agent.source`: the conventions have no term for this,
    // and inventing a gen_ai name would put a word in the spec's mouth.
    expect(runSpan(tel).attributes['agent.source']).toBe('customer');
    expect(runSpan(tel).attributes['gen_ai.agent.source']).toBeUndefined();
  });

  it('stamps the host attribute bag onto the run', async () => {
    const hooks = new HookBus();
    const tel = new TelemetryAdapter(hooks);
    const loop = new AgentLoop({
      client: mockClient(hooks), hooks, label: 'brief',
      attributes: { 'app.tenant': 'acme', 'app.tier': 2, 'app.beta': true },
    });
    await loop.complete('go');

    const attrs = runSpan(tel).attributes;
    expect(attrs['app.tenant']).toBe('acme');
    expect(attrs['app.tier']).toBe(2);
    expect(attrs['app.beta']).toBe(true);
  });

  it('does not let the bag overwrite the span’s identity', async () => {
    const hooks = new HookBus();
    const tel = new TelemetryAdapter(hooks);
    const loop = new AgentLoop({
      client: mockClient(hooks), hooks, label: 'brief',
      // A caller reusing a convention key must not be able to relabel the operation —
      // that would make the span lie about what it is.
      attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.agent.name': 'imposter' } as never,
    });
    await loop.complete('go');

    const attrs = runSpan(tel).attributes;
    expect(attrs['gen_ai.operation.name']).toBe('invoke_agent');
    expect(attrs['gen_ai.agent.name']).toBe('brief');
  });

  it('still works unlabelled, exporting the bare operation', async () => {
    const hooks = new HookBus();
    const tel = new TelemetryAdapter(hooks);
    const loop = new AgentLoop({ client: mockClient(hooks), hooks });
    await loop.complete('go');

    expect(otlpNames(tel)).toContain('invoke_agent');
    expect(runSpan(tel).attributes['gen_ai.agent.name']).toBeUndefined();
    // The id is always there, so an unlabelled agent is still distinguishable.
    expect(runSpan(tel).attributes['gen_ai.agent.id']).toBe(loop.id);
  });

  it('reaches an onTrace subscriber, not just the OTLP export', async () => {
    const hooks = new HookBus();
    const tel = new TelemetryAdapter(hooks);
    const seen: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    tel.onTrace({ types: ['agent'] }, (e) => seen.push(e));
    const loop = new AgentLoop({ client: mockClient(hooks), hooks, label: 'brief', source: 'customer' });
    await loop.complete('go');

    expect(seen[0]!.name).toBe('invoke_agent brief');
    expect(seen[0]!.attributes['agent.source']).toBe('customer');
  });
});
