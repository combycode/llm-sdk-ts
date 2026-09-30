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
  buildStepResponse,
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

  it('an unmatched end resolves to the MOST RECENT call, and only once', () => {
    // Was "picks the FIRST still-open call, in start order". A stream delivers a
    // call's events after its start, so the most recent open call is the only
    // reading that holds once more than one is in flight. Two unmatched ends
    // therefore close `beta` once; `alpha` is recovered by the end-of-step
    // rescue, with its own arguments intact.
    const { state } = feed([
      { type: 'tool_call_start', id: 'a', name: 'alpha' },
      { type: 'tool_call_delta', id: 'a', arguments: '{"x":1}' },
      { type: 'tool_call_start', id: 'b', name: 'beta' },
      { type: 'tool_call_delta', id: 'b', arguments: '{"y":2}' },
      { type: 'tool_call_end', id: 'unknown-1' },
      { type: 'tool_call_end', id: 'unknown-2' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls.map((t) => t.name)).toEqual(['beta']);
    finalizeUnendedToolCalls(state);
    expect(state.stepToolCalls.map((t) => [t.name, t.arguments])).toEqual([
      ['beta', { y: 2 }],
      ['alpha', { x: 1 }],
    ]);
  });

  it('tool_call_end with no accumulator at all emits nothing', () => {
    const { state } = feed([{ type: 'tool_call_end', id: 'nope' }] as StreamEvent[]);
    expect(state.stepToolCalls).toEqual([]);
  });

  // WAS a deliberately pinned defect: `(event.id && get(event.id)) ?? fallback`
  // short-circuits to the EMPTY STRING for `id: ''`, and `'' ?? x` is `''`, so
  // the fallback never ran and the call was silently dropped until the
  // end-of-step rescue recovered it.
  //
  // The note here said "no shipping adapter emits `id: ''` today, which is why
  // it has gone unnoticed". That was WRONG, and the reason the defect survived:
  // Google's stream registry emitted `id: ''` on EVERY tool_call_delta and every
  // tool_call_end while having `functionCall.id` in hand. An empty grep is a fact
  // about the search, not about the adapters.
  it('tool_call_end with an EMPTY id closes the call it belongs to', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'first' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"n":1}' },
      { type: 'tool_call_end', id: '' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'first', arguments: { n: 1 } },
    ]);
    // And the end-of-step rescue does not add it a second time.
    finalizeUnendedToolCalls(state);
    expect(state.stepToolCalls).toHaveLength(1);
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

  it('an unmatched end resolves to the MOST RECENT call, and only once', () => {
    // Was "picks the FIRST still-open call, in start order". A stream delivers a
    // call's events after its start, so the most recent open call is the only
    // reading that holds once more than one is in flight. Two unmatched ends
    // therefore close `beta` once; `alpha` is recovered by the end-of-step
    // rescue, with its own arguments intact.
    const { state } = feed([
      { type: 'tool_call_start', id: 'a', name: 'alpha' },
      { type: 'tool_call_delta', id: 'a', arguments: '{"x":1}' },
      { type: 'tool_call_start', id: 'b', name: 'beta' },
      { type: 'tool_call_delta', id: 'b', arguments: '{"y":2}' },
      { type: 'tool_call_end', id: 'unknown-1' },
      { type: 'tool_call_end', id: 'unknown-2' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls.map((t) => t.name)).toEqual(['beta']);
    finalizeUnendedToolCalls(state);
    expect(state.stepToolCalls.map((t) => [t.name, t.arguments])).toEqual([
      ['beta', { y: 2 }],
      ['alpha', { x: 1 }],
    ]);
  });

  it('tool_call_end with no accumulator at all emits nothing', () => {
    const { state } = feed([{ type: 'tool_call_end', id: 'nope' }] as StreamEvent[]);
    expect(state.stepToolCalls).toEqual([]);
  });

  // This test used to assert `arguments: {}` and nothing more, under the heading
  // "degrades to {} instead of throwing away the call". Half of that was right and
  // is kept: the call must survive, with its id and name, or the step loses the
  // model's intent entirely. The other half was the bug -- `{}` is a VALID call,
  // so "degraded" was indistinguishable from "the model asked for no arguments",
  // and the tool ran. The call is still kept; it is now MARKED, and the loop
  // refuses to execute it.
  it('malformed argument JSON keeps the call but marks it, rather than running it with {}', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'broken' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"unclosed":' },
      { type: 'tool_call_end', id: 'c1' },
    ] as StreamEvent[]);
    expect(state.stepToolCalls).toEqual([
      { type: 'tool_call', id: 'c1', name: 'broken', arguments: {}, malformed: true },
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

describe('accumulateStreamEvent — arguments that never parsed', () => {
  /** The failure this guards against: a stream cut mid-JSON used to become `{}`,
   *  and `{}` is a VALID call. `delete_files({"path": "/et` ran as
   *  `delete_files()` — the most destructive reading of an unfinished sentence,
   *  and nothing downstream could tell it from a deliberate no-argument call. */
  it('marks a truncated tool call instead of running it with {}', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'delete_files' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"path": "/et' },
    ] as StreamEvent[]);
    finalizeUnendedToolCalls(state);
    expect(state.stepToolCalls).toHaveLength(1);
    expect(state.stepToolCalls[0]!.malformed).toBe(true);
    expect(state.stepToolCalls[0]!.arguments).toEqual({});
    expect(state.stepToolCalls[0]!.name).toBe('delete_files');
  });

  it('a genuine no-argument call is NOT malformed', () => {
    for (const args of ['', '   ', '{}']) {
      const { state } = feed([
        { type: 'tool_call_start', id: 'c1', name: 'ping' },
        ...(args ? [{ type: 'tool_call_delta', id: 'c1', arguments: args }] : []),
      ] as StreamEvent[]);
      finalizeUnendedToolCalls(state);
      expect(state.stepToolCalls[0]!.arguments).toEqual({});
      expect('malformed' in state.stepToolCalls[0]!).toBe(false);
    }
  });

  it('a scalar or array parses as JSON but is not an argument object', () => {
    for (const args of ['"just a string"', '42', 'null', '[1,2]']) {
      const { state } = feed([
        { type: 'tool_call_start', id: 'c1', name: 't' },
        { type: 'tool_call_delta', id: 'c1', arguments: args },
      ] as StreamEvent[]);
      finalizeUnendedToolCalls(state);
      expect(state.stepToolCalls[0]!.malformed).toBe(true);
      expect(state.stepToolCalls[0]!.arguments).toEqual({});
    }
  });

  it('well-formed arguments are untouched and carry no marker', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'get_weather' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"city":' },
      { type: 'tool_call_delta', id: 'c1', arguments: '"Berlin"}' },
    ] as StreamEvent[]);
    finalizeUnendedToolCalls(state);
    expect(state.stepToolCalls[0]!.arguments).toEqual({ city: 'Berlin' });
    expect('malformed' in state.stepToolCalls[0]!).toBe(false);
  });

  /** Only Google's API reports MALFORMED_FUNCTION_CALL, so before this the same
   *  truncation on OpenAI or Anthropic finished as `tool_use` and looked like a
   *  successful turn — `reflectAndRetry` defaults to this reason and never fired. */
  it('the step reports malformed_tool_call, not tool_use', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'x' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"a":' },
    ] as StreamEvent[]);
    finalizeUnendedToolCalls(state);
    const { response } = buildStepResponse(state, 'test-model', 0);
    expect(response.finishReason).toBe('malformed_tool_call');
  });

  it('a step whose calls all parsed still reports tool_use', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'c1', name: 'x' },
      { type: 'tool_call_delta', id: 'c1', arguments: '{"a":1}' },
    ] as StreamEvent[]);
    finalizeUnendedToolCalls(state);
    const { response } = buildStepResponse(state, 'test-model', 0);
    expect(response.finishReason).toBe('tool_use');
  });

  it('one bad call among good ones still fails the step', () => {
    const { state } = feed([
      { type: 'tool_call_start', id: 'good', name: 'a' },
      { type: 'tool_call_delta', id: 'good', arguments: '{"ok":true}' },
      { type: 'tool_call_end', id: 'good' },
      { type: 'tool_call_start', id: 'bad', name: 'b' },
      { type: 'tool_call_delta', id: 'bad', arguments: '{"cut' },
    ] as StreamEvent[]);
    finalizeUnendedToolCalls(state);
    const { response } = buildStepResponse(state, 'test-model', 0);
    expect(response.finishReason).toBe('malformed_tool_call');
    expect(state.stepToolCalls.find((t) => t.id === 'good')!.arguments).toEqual({ ok: true });
    expect(state.stepToolCalls.find((t) => t.id === 'bad')!.malformed).toBe(true);
  });
});
