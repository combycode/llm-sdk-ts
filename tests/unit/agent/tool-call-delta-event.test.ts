/** The model's tool-call arguments, as they stream in.
 *
 *  The deltas reached the loop and died there: they were accumulated into the
 *  call's argument buffer and dropped, so a consumer had no way to show arguments
 *  forming. `tool_call_start` only fires once they are complete, which for a long
 *  argument list is exactly the wait a streaming UI exists to avoid.
 *
 *  They are now forwarded as well as accumulated — a second reader, not a
 *  handover, since the loop still needs the whole string to parse at
 *  `tool_call_end`. The complete, PARSED arguments still arrive on
 *  `tool_call_start`, which remains the event to act on; a partial fragment is raw
 *  JSON text and usually not parseable, so it is for rendering, not for deciding.
 */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import type { AgentStreamEvent, AgentTool } from '../../../src/agent/types';
import type { LLMClient } from '../../../src/llm/client';
import type { StreamEvent } from '../../../src/llm/types/stream';

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

const response = (text: string) => ({
  id: 'r1',
  model: 'mock-model',
  content: [{ type: 'text' as const, text }],
  finishReason: 'stop',
  usage: USAGE,
  text,
  toolCalls: [],
  thinking: null,
  media: [],
  latencyMs: 1,
  raw: null,
});

/** Streams a tool call whose arguments arrive in fragments, then an answer. */
function fragmentedClient(): LLMClient {
  let turn = 0;
  return {
    id: 'mock',
    provider: 'mock',
    model: 'mock-model',
    api: 'completions',
    mode: 'foreground',
    batchable: false,
    hooks: new HookBus(),
    complete: async () => response('ok'),
    stream: async function* (): AsyncIterable<StreamEvent> {
      turn += 1;
      if (turn === 1) {
        yield { type: 'tool_call_start', id: 'c1', name: 'search' } as StreamEvent;
        yield { type: 'tool_call_delta', id: 'c1', arguments: '{"q":"quarterly ' } as StreamEvent;
        yield { type: 'tool_call_delta', id: 'c1', arguments: 'report"}' } as StreamEvent;
        yield { type: 'tool_call_end', id: 'c1' } as StreamEvent;
        yield { type: 'done', response: response('') } as unknown as StreamEvent;
        return;
      }
      yield { type: 'text', text: 'done' } as StreamEvent;
      yield { type: 'done', response: response('done') } as unknown as StreamEvent;
    },
    destroy() {},
  } as unknown as LLMClient;
}

const search: AgentTool = {
  definition: { name: 'search', description: 'Search', parameters: {} },
  execute: async () => 'results',
};

async function drain(): Promise<AgentStreamEvent[]> {
  const agent = new AgentLoop({
    client: fragmentedClient(),
    tools: [search],
    system: 's',
  } as never);
  const events: AgentStreamEvent[] = [];
  for await (const ev of agent.stream('find it')) events.push(ev);
  return events;
}

describe('tool_call_delta reaches the agent stream', () => {
  it('forwards each fragment in order', async () => {
    const deltas = (await drain()).filter((e) => e.type === 'tool_call_delta');
    expect(deltas.map((d) => (d as { arguments: string }).arguments)).toEqual([
      '{"q":"quarterly ',
      'report"}',
    ]);
  });

  it('stamps the step it belongs to, on a LATER step too', async () => {
    // Step 0 cannot prove this: `makeStepState()` defaults to 0, so on the first
    // step a loop that forgot to pass the number looks identical. Two tool-calling
    // steps in a row is the only arrangement that distinguishes them.
    let turn = 0;
    const twoToolSteps = {
      id: 'mock',
      provider: 'mock',
      model: 'mock-model',
      api: 'completions',
      mode: 'foreground',
      batchable: false,
      hooks: new HookBus(),
      complete: async () => response('ok'),
      stream: async function* (): AsyncIterable<StreamEvent> {
        turn += 1;
        if (turn <= 2) {
          const id = `c${turn}`;
          yield { type: 'tool_call_start', id, name: 'search' } as StreamEvent;
          yield { type: 'tool_call_delta', id, arguments: `{"q":"${turn}"}` } as StreamEvent;
          yield { type: 'tool_call_end', id } as StreamEvent;
          yield { type: 'done', response: response('') } as unknown as StreamEvent;
          return;
        }
        yield { type: 'text', text: 'done' } as StreamEvent;
        yield { type: 'done', response: response('done') } as unknown as StreamEvent;
      },
      destroy() {},
    } as unknown as LLMClient;

    const agent = new AgentLoop({ client: twoToolSteps, tools: [search], system: 's' } as never);
    const steps: number[] = [];
    for await (const ev of agent.stream('find it')) {
      if (ev.type === 'tool_call_delta') steps.push((ev as { step: number }).step);
    }
    expect(steps).toEqual([0, 1]);
  });

  it('carries the call id, so a consumer can group fragments', async () => {
    const deltas = (await drain()).filter((e) => e.type === 'tool_call_delta');
    expect(deltas.every((d) => (d as { callId: string }).callId === 'c1')).toBe(true);
  });

  it('still delivers the complete parsed arguments on tool_call_start', async () => {
    // The deltas are for rendering. `tool_call_start` is the event to act on, and
    // it is unchanged.
    const start = (await drain()).find((e) => e.type === 'tool_call_start');
    expect((start as { arguments: Record<string, unknown> }).arguments).toEqual({
      q: 'quarterly report',
    });
  });

  it('arrives BEFORE the start, which is the point', async () => {
    // If the deltas arrived after the complete call they would be useless: the
    // whole value is seeing the arguments while the model is still writing them.
    const events = await drain();
    const firstDelta = events.findIndex((e) => e.type === 'tool_call_delta');
    const start = events.findIndex((e) => e.type === 'tool_call_start');
    expect(firstDelta).toBeGreaterThanOrEqual(0);
    expect(firstDelta).toBeLessThan(start);
  });

  it('emits none for a step that calls no tools', async () => {
    // A consumer that does not want these needs no change: they are absent unless
    // a provider actually streams fragments.
    const agent = new AgentLoop({
      client: {
        id: 'mock',
        provider: 'mock',
        model: 'mock-model',
        api: 'completions',
        mode: 'foreground',
        batchable: false,
        hooks: new HookBus(),
        complete: async () => response('ok'),
        stream: async function* () {
          yield { type: 'text', text: 'hi' } as StreamEvent;
          yield { type: 'done', response: response('hi') } as unknown as StreamEvent;
        },
        destroy() {},
      } as unknown as LLMClient,
      system: 's',
    } as never);
    const events: AgentStreamEvent[] = [];
    for await (const ev of agent.stream('hi')) events.push(ev);
    expect(events.filter((e) => e.type === 'tool_call_delta')).toHaveLength(0);
  });
});
