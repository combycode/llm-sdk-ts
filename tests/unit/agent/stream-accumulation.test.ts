/** accumulateStreamEvent — how a stream of deltas becomes a step.
 *
 *  This is where a streamed tool call is REASSEMBLED, and it is the single most
 *  dangerous function to port loosely: a `tool_call_start` carries the name and
 *  id, and the arguments arrive later as a run of `tool_call_delta` fragments.
 *  Lose the deltas and you still get a tool call with a correct name and `{}`
 *  arguments — a call that looks right in every log and does the wrong thing.
 *  So every assertion below checks the ARGUMENTS, not just that a call appeared.
 *
 *  The other trap is `tool_call_end` with a missing or mismatched id, which some
 *  providers send: the accumulator has to fall back to "the first entry not yet
 *  emitted" rather than dropping the call. */

import { describe, expect, it } from 'bun:test';
import {
  accumulateStreamEvent,
  finalizeUnendedToolCalls,
  makeStepState,
} from '../../../src/agent/loop-internals';
import type { StreamEvent } from '../../../src/llm/types/stream';
import { emptyUsage } from '../../../src/llm/types/response';

const feed = (events: StreamEvent[]) => {
  const state = makeStepState();
  const yielded = events.map((e) => accumulateStreamEvent(e, state));
  return { state, yielded };
};

describe('accumulateStreamEvent — text and thinking', () => {
  it('answer text accumulates into stepText and is forwarded', () => {
    const { state, yielded } = feed([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ] as StreamEvent[]);
    expect(state.stepText).toBe('Hello');
    expect(state.stepCommentary).toBe('');
    expect(yielded).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ]);
  });

  it('commentary is kept OUT of stepText but still forwarded, phase intact', () => {
    const { state, yielded } = feed([
      { type: 'text', text: 'thinking aloud', phase: 'commentary' },
      { type: 'text', text: 'the answer' },
    ] as StreamEvent[]);
    expect(state.stepCommentary).toBe('thinking aloud');
    expect(state.stepText).toBe('the answer');
    expect(yielded[0]).toEqual({ type: 'text', text: 'thinking aloud', phase: 'commentary' });
    // No phase on a plain token — the key must be ABSENT, not `phase: undefined`.
    expect(yielded[1]).toEqual({ type: 'text', text: 'the answer' });
    expect('phase' in (yielded[1] as object)).toBe(false);
  });

  it('thinking deltas accumulate AND are forwarded as thinking events', () => {
    const { state, yielded } = feed([
      { type: 'thinking', text: 'step 1. ' },
      { type: 'thinking', text: 'step 2.' },
    ] as StreamEvent[]);
    expect(state.stepThinking).toBe('step 1. step 2.');
    expect(yielded).toEqual([
      { type: 'thinking', text: 'step 1. ' },
      { type: 'thinking', text: 'step 2.' },
    ]);
    // Reasoning must never leak into the answer text.
    expect(state.stepText).toBe('');
  });
});

describe('accumulateStreamEvent — tool call reassembly', () => {
  it('start + deltas + end produces a call with its ARGUMENTS, not just its name', () => {
    const { state, yielded } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'get_weather' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"city":' },
      { type: 'tool_call_delta', id: 'c1', arguments: '"Berlin"}' },
      { type: 'tool_call_end', id: 'c1' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'get_weather', arguments: { city: 'Berlin' } },
    ]);
    // None of the tool-call plumbing is forwarded to the agent stream.
    expect(yielded).toEqual([null, null, null, null]);
  });

  it('two interleaved tool calls keep their own argument buffers', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'a', name: 'alpha' },
      { type: 'tool_call_start', id: 'b', name: 'beta' },
      { type: 'tool_call_delta', id: 'a', arguments: '{"x":1' },
      { type: 'tool_call_delta', id: 'b', arguments: '{"y":2' },
      { type: 'tool_call_delta', id: 'a', arguments: '}' },
      { type: 'tool_call_delta', id: 'b', arguments: '}' },
      { type: 'tool_call_end', id: 'a' },
      { type: 'tool_call_end', id: 'b' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls).toEqual([
      { type: 'tool_call', id: 'a', name: 'alpha', arguments: { x: 1 } },
      { type: 'tool_call', id: 'b', name: 'beta', arguments: { y: 2 } },
    ]);
  });

  it('a delta with an UNKNOWN id falls back to the first open accumulator', () => {
    // Some providers omit the id on continuation deltas. Dropping them would
    // leave the call with empty arguments.
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'search' },
      { type: 'tool_call_delta', id: '', arguments: '{"q":"cats"}' },
      { type: 'tool_call_end', id: 'c1' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls[0].arguments).toEqual({ q: 'cats' });
  });

  it('a delta before any start is dropped rather than throwing', () => {
    const { state } = feed([
      { type: 'tool_call_delta', id: 'ghost', arguments: '{"a":1}' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls).toEqual([]);
  });

  it('tool_call_end with a MISMATCHED id closes the oldest call not yet emitted', () => {
    // Providers do not all echo the same id back on the end frame. Dropping the
    // call here would lose a fully-buffered tool invocation.
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'first' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"n":1}' },
      { type: 'tool_call_end', id: 'some-other-id' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'first', arguments: { n: 1 } },
    ]);
  });

  it('a second mismatched end does not emit the same call twice', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'first' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"n":1}' },
      { type: 'tool_call_end', id: 'x' },
      { type: 'tool_call_end', id: 'y' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls).toHaveLength(1);
  });

  it('the mismatch fallback picks the FIRST still-open call, in start order', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'a', name: 'alpha' },
      { type: 'tool_call_delta', id: 'a', arguments: '{"x":1}' },
      { type: 'tool_call_start', id: 'b', name: 'beta' },
      { type: 'tool_call_delta', id: 'b', arguments: '{"y":2}' },
      { type: 'tool_call_end', id: 'unknown-1' },
      { type: 'tool_call_end', id: 'unknown-2' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls.map((t) => t.name)).toEqual(['alpha', 'beta']);
  });

  it('tool_call_end with no accumulator at all emits nothing', () => {
    const { state } = feed([{ type: 'tool_call_end', id: 'nope' }] as StreamEvent[]);
    expect(state.stepToolCalls).toEqual([]);
  });

  // KNOWN DEFECT, pinned deliberately. `(event.id && get(event.id)) ?? fallback`
  // short-circuits to the EMPTY STRING for `id: ''`, and `'' ?? x` is `''` — so
  // the fallback never runs and the buffered call is silently dropped. An `||`
  // would make this behave like the mismatched-id case above. No shipping adapter
  // emits `id: ''` today, which is why it has gone unnoticed; if one ever does,
  // the model's tool call disappears with no error. This test fails the moment
  // the operator is fixed — which is the intended signal.
  it('tool_call_end with an EMPTY id drops the call (see note: `??` should be `||`)', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'first' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"n":1}' },
      { type: 'tool_call_end', id: '' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls).toEqual([]);
    // The data is not lost — the end-of-step rescue still recovers it.
    finalizeUnendedToolCalls(state);
    expect(state.stepToolCalls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'first', arguments: { n: 1 } },
    ]);
  });

  it('malformed argument JSON degrades to {} instead of throwing away the call', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'broken' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"unclosed":' },
      { type: 'tool_call_end', id: 'c1' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'broken', arguments: {} },
    ]);
  });

  it('a call with no deltas at all parses as {} — never undefined', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'noargs' },
      { type: 'tool_call_end', id: 'c1' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls[0].arguments).toEqual({});
  });

  it('provider _meta from the start event survives onto the finished call', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'mcp_tool', _meta: { server: 'files' } },
      { type: 'tool_call_delta', id: 'c1', arguments: '{}' },
      { type: 'tool_call_end', id: 'c1' },
    ] as unknown as StreamEvent[]);
    expect(state.stepToolCalls[0]).toMatchObject({ _meta: { server: 'files' } });
  });

  it('finalizeUnendedToolCalls rescues calls whose end event never arrived', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'ended', },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"a":1}' },
      { type: 'tool_call_end', id: 'c1' },
      { type: 'tool_call_start', id: 'c2', name: 'unended' },
      { type: 'tool_call_delta', id: 'c2', arguments: '{"b":2}' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls).toHaveLength(1);
    finalizeUnendedToolCalls(state);
    expect(state.stepToolCalls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'ended', arguments: { a: 1 } },
      { type: 'tool_call', id: 'c2', name: 'unended', arguments: { b: 2 } },
    ]);
  });

  it('finalizeUnendedToolCalls does not duplicate an already-emitted call', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'ended' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"a":1}' },
      { type: 'tool_call_end', id: 'c1' },
    ] as StreamEvent[]);
    finalizeUnendedToolCalls(state);
    expect(state.stepToolCalls).toHaveLength(1);
  });
});

describe('accumulateStreamEvent — terminal + collected events', () => {
  it('usage replaces the running total and is not forwarded', () => {
    const usage = { ...emptyUsage(), inputTokens: 11, outputTokens: 5, totalTokens: 16 };
    const { state, yielded } = feed([{ type: 'usage', usage }] as StreamEvent[]);
    expect(state.stepUsage).toEqual(usage);
    expect(yielded).toEqual([null]);
  });

  it('done records the finish reason', () => {
    const { state } = feed([{ type: 'done', finishReason: 'tool_use' }] as StreamEvent[]);
    expect(state.stepFinishReason).toBe('tool_use');
  });

  it('citations are collected by url (deduped) and never forwarded', () => {
    const { state, yielded } = feed([
      { type: 'citation', citation: { url: 'https://a', title: 'A' } },
      { type: 'citation', citation: { url: 'https://a', title: 'A again' } },
      { type: 'citation', citation: { url: 'https://b', title: 'B' } },
    ] as unknown as StreamEvent[]);
    expect([...state.stepCitations.keys()]).toEqual(['https://a', 'https://b']);
    expect(state.stepCitations.get('https://a')?.title).toBe('A again');
    expect(yielded).toEqual([null, null, null]);
  });

  it('an event type the agent layer does not model is ignored, not thrown on', () => {
    // `file` / `builtin_tool_end` reach the agent layer but have no
    // AgentStreamEvent counterpart; an unknown one must not crash the run.
    const state = makeStepState();
    expect(accumulateStreamEvent({ type: 'file', file: { id: 'f' } } as never, state)).toBeNull();
    expect(accumulateStreamEvent({ type: 'brand_new_event' } as never, state)).toBeNull();
    expect(state.stepText).toBe('');
    expect(state.stepToolCalls).toEqual([]);
  });
});
