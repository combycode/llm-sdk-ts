/** Stopping a run stops the WORK, and a nested run belongs to the run above it.
 *
 *  Two halves of one omission.
 *
 *  `stop()` reached the in-flight LLM request and nothing else. A tool already
 *  running kept running: its fetch completed, its side effects landed, and the
 *  loop that had already stopped threw the result away. Cancelling only the
 *  cheap half of the work is not cancelling.
 *
 *  And `delegate()` / `handoff()` called `agent.complete(task)` with nothing, so
 *  a sub-agent inherited neither. Stop the parent and the child carried on
 *  answering a question nobody would read, on a trace of its own, so the two
 *  halves of one request could not be joined — which is the whole point of a
 *  trace id.
 */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import { delegate, nestedRunOptions } from '../../../src/helpers/delegate';
import { handoff } from '../../../src/helpers/handoff';
import type { AgentTool, ToolExecutionContext } from '../../../src/agent/types';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ContentPart, ToolCallPart } from '../../../src/llm/types/messages';

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function reply(parts: ContentPart[], finishReason: string) {
  return {
    content: parts,
    finishReason,
    toolCalls: parts.filter((p): p is ToolCallPart => p.type === 'tool_call'),
    usage: USAGE,
  };
}

const callFor = (name: string) =>
  reply([{ type: 'tool_call', id: 'c1', name, arguments: { task: 'summarise' } }], 'tool_use');
const done = (text: string) => reply([{ type: 'text', text }], 'stop');

/** A client that answers from a queue and records the options it was given. */
function mockClient(queue: Array<ReturnType<typeof reply>>) {
  const seenOptions: Array<Record<string, unknown>> = [];
  const pending = [...queue];
  const client = {
    id: 'mock',
    provider: 'mock',
    model: 'mock-model',
    hooks: new HookBus(),
    api: 'completions',
    mode: 'foreground',
    batchable: false,
    complete: async (_input: unknown, options: Record<string, unknown> = {}) => {
      seenOptions.push(options);
      const next = pending.shift();
      if (!next) throw new Error('mock client exhausted');
      return {
        id: 'r',
        model: 'mock-model',
        media: [],
        text: '',
        thinking: null,
        latencyMs: 1,
        raw: null,
        ...next,
      } as CompletionResponse;
    },
  } as unknown as LLMClient;
  return { client, seenOptions };
}

// ───────────────────────────────────────── stop() reaches a running tool

describe('a tool sees the run being stopped', () => {
  it('aborts the signal it was handed', async () => {
    let sawAbort = false;
    const slow: AgentTool = {
      definition: { name: 'slow', description: 'Takes a while', parameters: {} },
      execute: (_args, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true;
            resolve('cancelled');
          });
        }),
    };
    const { client } = mockClient([
      reply([{ type: 'tool_call', id: 'c1', name: 'slow', arguments: {} }], 'tool_use'),
      done('stopped'),
    ]);
    const loop = new AgentLoop({ client, tools: [slow] });

    const running = loop.complete('go');
    // Let the tool start before asking the run to stop.
    await new Promise((r) => setTimeout(r, 5));
    loop.stop();
    await running;

    expect(sawAbort).toBe(true);
  });

  it('says WHICH happened, because a tool cleans up differently for each', async () => {
    // A timeout is the tool's own problem to report; a stop is the caller
    // changing their mind. Same signal, so the reason has to carry it.
    let reason: unknown;
    const slow: AgentTool = {
      definition: { name: 'slow', description: 'Takes a while', parameters: {} },
      execute: (_args, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            reason = ctx.signal.reason;
            resolve('cancelled');
          });
        }),
    };
    const { client } = mockClient([
      reply([{ type: 'tool_call', id: 'c1', name: 'slow', arguments: {} }], 'tool_use'),
      done('done'),
    ]);
    // A 5ms tool timeout, never stopped: the reason must name the timeout.
    const loop = new AgentLoop({ client, tools: [slow], toolTimeout: 5 });
    await loop.complete('go');

    expect(String(reason)).toContain('timed out');
    expect(String(reason)).toContain('slow');
  });

  it('leaves a tool that finishes in time entirely alone', async () => {
    let aborted = false;
    const quick: AgentTool = {
      definition: { name: 'quick', description: 'Fast', parameters: {} },
      execute: async (_args, ctx) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
        });
        return 'ok';
      },
    };
    const { client } = mockClient([
      reply([{ type: 'tool_call', id: 'c1', name: 'quick', arguments: {} }], 'tool_use'),
      done('fine'),
    ]);
    const loop = new AgentLoop({ client, tools: [quick] });
    const res = await loop.complete('go');

    expect(res.text).toBe('fine');
    expect(aborted).toBe(false);
  });
});

// ─────────────────────────────── a caller's signal does not disable stop()

describe('a caller’s signal becomes part of the run’s, not a replacement for it', () => {
  it('reaches the request while it is in flight', async () => {
    // The caller's signal used to REPLACE the loop's, so passing one silently
    // disabled `stop()` — and a parent agent handing down its cancellation is
    // the most likely caller of all. `beginRun` links it into the run's own
    // controller, so BOTH work, and everything downstream reads one signal.
    const outer = new AbortController();
    let seen: AbortSignal | undefined;
    let inFlight: () => void = () => {};
    const started = new Promise<void>((r) => {
      inFlight = r;
    });

    const client = {
      id: 'mock',
      provider: 'mock',
      model: 'mock-model',
      hooks: new HookBus(),
      api: 'completions',
      mode: 'foreground',
      batchable: false,
      complete: (_i: unknown, o: { signal?: AbortSignal } = {}) =>
        new Promise((resolve) => {
          seen = o.signal;
          inFlight();
          // Answers only when abandoned, so the assertion is that it WAS.
          o.signal?.addEventListener('abort', () =>
            resolve({ ...done('abandoned'), id: 'r', model: 'm', media: [], text: 'abandoned', thinking: null, latencyMs: 1, raw: null } as CompletionResponse),
          );
        }),
    } as unknown as LLMClient;

    const loop = new AgentLoop({ client });
    const running = loop.complete('go', { signal: outer.signal });
    await started;
    expect(seen?.aborted).toBe(false);

    outer.abort(new Error('caller changed their mind'));
    expect(seen?.aborted).toBe(true);
    expect(String(seen?.reason)).toContain('changed their mind');
    await running;
  });

  it('and so does the loop’s own stop(), for the same request', async () => {
    let seen: AbortSignal | undefined;
    let inFlight: () => void = () => {};
    const started = new Promise<void>((r) => {
      inFlight = r;
    });
    const client = {
      id: 'mock',
      provider: 'mock',
      model: 'mock-model',
      hooks: new HookBus(),
      api: 'completions',
      mode: 'foreground',
      batchable: false,
      complete: (_i: unknown, o: { signal?: AbortSignal } = {}) =>
        new Promise((resolve) => {
          seen = o.signal;
          inFlight();
          o.signal?.addEventListener('abort', () =>
            resolve({ ...done('stopped'), id: 'r', model: 'm', media: [], text: 'stopped', thinking: null, latencyMs: 1, raw: null } as CompletionResponse),
          );
        }),
    } as unknown as LLMClient;

    const loop = new AgentLoop({ client });
    const running = loop.complete('go', { signal: new AbortController().signal });
    await started;
    loop.stop();
    expect(seen?.aborted).toBe(true);
    await running;
  });
});

// ────────────────────────────────────────────── what a nested run inherits

describe('nestedRunOptions', () => {
  const ctx: ToolExecutionContext = {
    step: 2,
    callId: 'call_9',
    signal: new AbortController().signal,
    metrics: new Map(),
    trace: { sessionId: 'sess_1', requestId: 'run_1', traceparent: '00-abc-def-01' },
  };

  it('passes the caller’s cancellation down', () => {
    expect(nestedRunOptions(ctx).signal).toBe(ctx.signal);
  });

  it('passes the WHOLE trace, not a field or two of it', () => {
    // `beginRun` resolves sessionId/requestId together, and a caller supplying
    // only one of them is recorded there as having split a run across two traces.
    const out = nestedRunOptions(ctx).ctx;
    expect(out.sessionId).toBe('sess_1');
    expect(out.requestId).toBe('run_1');
    expect(out.traceparent).toBe('00-abc-def-01');
  });

  it('names the call that delegated, so the sub-run hangs off it', () => {
    expect(nestedRunOptions(ctx).ctx.callId).toBe('call_9');
  });
});

describe('delegate and handoff hand both down', () => {
  /** A parent whose only tool is the sub-agent. Returns what the CHILD saw. */
  async function runNested(makeTool: (child: AgentLoop) => AgentTool) {
    const childClient = mockClient([done('summary')]);
    const child = new AgentLoop({ client: childClient.client });

    const parentClient = mockClient([callFor('helper'), done('relayed')]);
    const parent = new AgentLoop({ client: parentClient.client, tools: [makeTool(child)] });

    const res = await parent.complete('delegate it');
    return { res, childSaw: childClient.seenOptions, parentSaw: parentClient.seenOptions };
  }

  it('delegate: the child request carries a live signal', async () => {
    const { childSaw } = await runNested((child) => delegate('helper', 'Summarise', child));
    expect(childSaw[0]?.signal).toBeDefined();
    expect((childSaw[0]?.signal as AbortSignal).aborted).toBe(false);
  });

  it('delegate: the child joins the parent’s trace', async () => {
    const { childSaw, parentSaw } = await runNested((child) =>
      delegate('helper', 'Summarise', child),
    );
    const childCtx = childSaw[0]?.ctx as Record<string, unknown>;
    const parentCtx = parentSaw[0]?.ctx as Record<string, unknown>;
    expect(childCtx.sessionId).toBe(parentCtx.sessionId);
    expect(childCtx.requestId).toBe(parentCtx.requestId);
    // And it is attributed to the call that delegated, not to the parent at large.
    expect(childCtx.callId).toBe('c1');
  });

  it('handoff: the same, since the difference is only its return shape', async () => {
    const { childSaw, parentSaw } = await runNested((child) =>
      handoff('helper', 'Summarise', child),
    );
    expect(childSaw[0]?.signal).toBeDefined();
    const childCtx = childSaw[0]?.ctx as Record<string, unknown>;
    expect(childCtx.requestId).toBe((parentSaw[0]?.ctx as Record<string, unknown>).requestId);
    expect(childCtx.callId).toBe('c1');
  });

  it('stopping the parent aborts the child WHILE it is running', async () => {
    // The point of inheriting the signal. The child has to be in flight for this
    // to mean anything: once the parent run ends, its controller is gone and the
    // chain is torn down, which is correct and is why this waits for the child
    // to be mid-request before stopping.
    let childSignal: AbortSignal | undefined;
    let childStarted: () => void = () => {};
    const started = new Promise<void>((r) => {
      childStarted = r;
    });

    const childClient = {
      id: 'child',
      provider: 'mock',
      model: 'mock-model',
      hooks: new HookBus(),
      api: 'completions',
      mode: 'foreground',
      batchable: false,
      complete: (_i: unknown, o: { signal?: AbortSignal } = {}) =>
        new Promise((resolve) => {
          childSignal = o.signal;
          childStarted();
          // Answers only when abandoned — so the assertion is that it WAS.
          o.signal?.addEventListener('abort', () =>
            resolve({ ...done('abandoned'), id: 'r', model: 'm', media: [], text: 'abandoned', thinking: null, latencyMs: 1, raw: null } as CompletionResponse),
          );
        }),
    } as unknown as LLMClient;

    const child = new AgentLoop({ client: childClient });
    const parentClient = mockClient([callFor('helper'), done('relayed')]);
    const parent = new AgentLoop({
      client: parentClient.client,
      tools: [delegate('helper', 'Summarise', child)],
    });

    const running = parent.complete('delegate it');
    await started;
    expect(childSignal?.aborted).toBe(false);

    parent.stop();
    expect(childSignal?.aborted).toBe(true);
    await running;
  });
});

describe('the chain holds at any depth', () => {
  it('a tool three agents deep hears the TOP caller give up', async () => {
    // The reason the caller's signal is linked into the run's controller rather
    // than combined at each use: every loop's own signal then already carries
    // its caller's, so no site downstream has to remember to combine anything.
    let deepSignal: AbortSignal | undefined;
    let reached: () => void = () => {};
    const arrived = new Promise<void>((r) => {
      reached = r;
    });

    const deepTool: AgentTool = {
      definition: { name: 'dig', description: 'Work', parameters: {} },
      execute: (_args, ctx) =>
        new Promise((resolve) => {
          deepSignal = ctx.signal;
          reached();
          ctx.signal.addEventListener('abort', () => resolve('abandoned'));
        }),
    };

    const grandchild = new AgentLoop({
      client: mockClient([
        reply([{ type: 'tool_call', id: 'c1', name: 'dig', arguments: {} }], 'tool_use'),
        done('deep'),
      ]).client,
      tools: [deepTool],
    });
    const child = new AgentLoop({
      client: mockClient([callFor('deeper'), done('mid')]).client,
      tools: [delegate('deeper', 'Go deeper', grandchild)],
    });
    const top = new AgentLoop({
      client: mockClient([callFor('helper'), done('top')]).client,
      tools: [delegate('helper', 'Delegate', child)],
    });

    const running = top.complete('go');
    await arrived;
    expect(deepSignal?.aborted).toBe(false);

    top.stop();
    expect(deepSignal?.aborted).toBe(true);
    await running;
  });
});
