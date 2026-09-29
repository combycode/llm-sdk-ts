/** A streamed run that the consumer walks away from is still a run that happened.
 *
 *  `break` out of `for await` closes the generator: it resumes at the `yield` it
 *  is parked on and unwinds. Everything that used to sit AFTER the try/finally —
 *  the final response, the report, `onRunComplete`, closing the span — was
 *  therefore skipped entirely. The run left no trace, and the case where that
 *  matters most is the one where somebody stopped listening because something
 *  looked wrong. */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import type { LLMClient } from '../../../src/llm/client';
import type { AgentTool } from '../../../src/agent/types';

const usage = {
  inputTokens: 1, outputTokens: 1, totalTokens: 2,
  cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
};

/** Never stops asking for a tool, so the consumer is the only thing that can
 *  end the run. */
function endlessClient() {
  let step = 0;
  return {
    provider: 'openai',
    model: 'mock-model',
    api: 'responses',
    async *stream() {
      step++;
      const id = `c${step}`;
      yield { type: 'text' as const, text: `step ${step} ` };
      yield { type: 'tool_call_start' as const, id, name: 'ping' };
      yield { type: 'tool_call_delta' as const, id, arguments: '{}' };
      yield { type: 'usage' as const, usage };
      yield { type: 'done' as const, finishReason: 'tool_use' };
    },
    destroy() {},
  } as unknown as LLMClient;
}

const ping: AgentTool = {
  definition: { type: 'function', name: 'ping', description: 'x', parameters: { type: 'object', properties: {} } },
  execute: async () => 'pong',
};

async function runAndBreakAfter(events: number) {
  const hooks = new HookBus();
  const completions: Array<{ reason: string }> = [];
  hooks.on('onRunComplete', (c) => {
    completions.push(c as unknown as { reason: string });
  });
  const loop = new AgentLoop({ client: endlessClient(), tools: [ping], hooks });

  let seen = 0;
  for await (const _ of loop.stream('go')) {
    if (++seen >= events) break;
  }
  return { loop, completions };
}

describe('a consumer that stops reading', () => {
  it('still gets onRunComplete', async () => {
    const { completions } = await runAndBreakAfter(3);
    expect(completions).toHaveLength(1);
  });

  it('is reported as aborted, not as done', async () => {
    const { completions } = await runAndBreakAfter(3);
    expect(completions[0]!.reason).toBe('aborted');
  });

  it('leaves a report behind', async () => {
    const { loop } = await runAndBreakAfter(3);
    expect(loop.lastReport).toBeDefined();
    expect(loop.lastReport?.reason).toBe('aborted');
  });

  it('releases the loop, so the agent can run again', async () => {
    const { loop } = await runAndBreakAfter(3);
    // `_running` is what makes a second run throw "already running". An aborted
    // run that never cleared it would wedge the agent for good.
    const events: string[] = [];
    for await (const ev of loop.stream('again')) {
      events.push(ev.type);
      if (events.length >= 2) break;
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it('keeps whatever text had already streamed', async () => {
    const { loop } = await runAndBreakAfter(4);
    expect(loop.lastReport?.finalText).toContain('step 1');
  });
});

describe('a run that ends on its own terms', () => {
  const answering = () =>
    ({
      provider: 'openai',
      model: 'mock-model',
      api: 'responses',
      async *stream() {
        yield { type: 'text' as const, text: 'done' };
        yield { type: 'usage' as const, usage };
        yield { type: 'done' as const, finishReason: 'stop' };
      },
      destroy() {},
    }) as unknown as LLMClient;

  it('is still reported as done', async () => {
    const hooks = new HookBus();
    const reasons: string[] = [];
    hooks.on('onRunComplete', (c) => {
      reasons.push((c as unknown as { reason: string }).reason);
    });
    const loop = new AgentLoop({ client: answering(), tools: [ping], hooks });
    for await (const _ of loop.stream('go')) {
      /* drain fully */
    }
    expect(reasons).toEqual(['done']);
    expect(loop.lastReport?.reason).toBe('done');
  });

  it('emits its done event, which an aborted run never reaches', async () => {
    const loop = new AgentLoop({ client: answering(), tools: [ping] });
    const types: string[] = [];
    for await (const ev of loop.stream('go')) types.push(ev.type);
    expect(types[types.length - 1]).toBe('done');
  });
});
