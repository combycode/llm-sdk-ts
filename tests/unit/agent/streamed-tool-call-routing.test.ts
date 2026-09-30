/** A streamed tool call's arguments belong to THAT call.
 *
 *  The accumulator used to route a delta with no matching id to
 *  `values().next().value` — the FIRST call in flight. Google's stream registry
 *  emitted `id: ''` on every delta and every end (it had `functionCall.id` and
 *  simply did not pass it on), so with two function calls in one response:
 *
 *    read_file    got `{"path":"/a"}{"path":"/b"}` — both payloads concatenated,
 *                 unparseable, refused as malformed. Visibly broken.
 *    delete_file  got NOTHING. An empty args string is deliberately read as a
 *                 genuine no-argument call, so it was not marked malformed —
 *                 it EXECUTED, with `{}`.
 *
 *  That second line is the whole reason this matters: the model asked to delete
 *  `/b`, and the tool ran with no arguments at all. It is exactly the failure
 *  `parseAccumEntry` was written to prevent (`delete_files({"path": "/et` must
 *  never become `delete_files({})`), arriving through a different door.
 *
 *  Fixed in both places: Google now carries its id on all three events, and the
 *  accumulator no longer routes an unmatched delta to an arbitrary call.
 */

import { describe, expect, it } from 'bun:test';
import {
  accumulateStreamEvent,
  finalizeUnendedToolCalls,
  makeStepState,
} from '../../../src/agent/loop-internals';
import type { StreamEvent } from '../../../src/llm/types/stream';
import type { ToolCallPart } from '../../../src/llm/types/messages';

function run(events: StreamEvent[]): ToolCallPart[] {
  const state = makeStepState();
  for (const e of events) accumulateStreamEvent(e, state);
  finalizeUnendedToolCalls(state);
  return state.stepToolCalls;
}

const start = (id: string, name: string): StreamEvent => ({ type: 'tool_call_start', id, name });
const delta = (id: string, args: string): StreamEvent => ({
  type: 'tool_call_delta',
  id,
  arguments: args,
});
const end = (id: string): StreamEvent => ({ type: 'tool_call_end', id });

describe('two parallel calls keep their own arguments', () => {
  it('when every event carries its id', () => {
    const calls = run([
      start('call_a', 'read_file'),
      delta('call_a', '{"path":"/a"}'),
      end('call_a'),
      start('call_b', 'delete_file'),
      delta('call_b', '{"path":"/b"}'),
      end('call_b'),
    ]);
    expect(calls.map((c) => [c.name, c.arguments])).toEqual([
      ['read_file', { path: '/a' }],
      ['delete_file', { path: '/b' }],
    ]);
  });

  it('and when the deltas carry NO id, as Google used to emit', () => {
    // The regression case. `delete_file` must get `/b`, not an empty object.
    const calls = run([
      start('call_a', 'read_file'),
      delta('', '{"path":"/a"}'),
      end(''),
      start('call_b', 'delete_file'),
      delta('', '{"path":"/b"}'),
      end(''),
    ]);
    expect(calls.map((c) => [c.name, c.arguments])).toEqual([
      ['read_file', { path: '/a' }],
      ['delete_file', { path: '/b' }],
    ]);
    expect(calls.some((c) => c.malformed)).toBe(false);
  });

  it('interleaved, which is what a real parallel stream looks like', () => {
    // Deltas arrive mixed. Only the id can separate them, and it does.
    const calls = run([
      start('call_a', 'read_file'),
      start('call_b', 'delete_file'),
      delta('call_a', '{"pa'),
      delta('call_b', '{"pa'),
      delta('call_a', 'th":"/a"}'),
      delta('call_b', 'th":"/b"}'),
      end('call_a'),
      end('call_b'),
    ]);
    expect(calls.map((c) => c.arguments)).toEqual([{ path: '/a' }, { path: '/b' }]);
  });
});

describe('an end is honoured once', () => {
  it('a repeated end does not push the call twice', () => {
    // Pushing twice runs the tool twice — for anything destructive that is the
    // whole cost of a duplicated event.
    const calls = run([
      start('call_a', 'delete_file'),
      delta('call_a', '{"path":"/a"}'),
      end('call_a'),
      end('call_a'),
    ]);
    expect(calls).toHaveLength(1);
  });

  it('nor does an id-less end that lands on an already-pushed call', () => {
    const calls = run([start('call_a', 'delete_file'), delta('call_a', '{}'), end('call_a'), end('')]);
    expect(calls).toHaveLength(1);
  });

  it('and finalize does not re-add what an end already pushed', () => {
    const calls = run([start('call_a', 'read_file'), delta('call_a', '{}'), end('call_a')]);
    expect(calls).toHaveLength(1);
  });
});

describe('a single call still works every way it used to', () => {
  it('with ids throughout', () => {
    expect(run([start('c', 'f'), delta('c', '{"x":1}'), end('c')])[0]?.arguments).toEqual({ x: 1 });
  });

  it('with no ids on the delta or end', () => {
    expect(run([start('c', 'f'), delta('', '{"x":1}'), end('')])[0]?.arguments).toEqual({ x: 1 });
  });

  it('with no end at all — finalize still emits it', () => {
    expect(run([start('c', 'f'), delta('c', '{"x":1}')])[0]?.arguments).toEqual({ x: 1 });
  });

  it('and a truncated argument string is still refused, not guessed at', () => {
    const [call] = run([start('c', 'delete_files'), delta('c', '{"path": "/et'), end('c')]);
    expect(call?.malformed).toBe(true);
    expect(call?.arguments).toEqual({});
  });
});

describe('the Google stream registry carries its id', () => {
  it('on the delta and the end, not only the start', async () => {
    // The root cause: it had `functionCall.id` and passed `''` on twice.
    const { GOOGLE_STREAM_REGISTRY } = await import(
      '../../../src/llm/providers/google/stream-registry'
    );
    const out: { events: StreamEvent[] } = { events: [] };
    // `outOf` reads `ctx.req.out`; `partOf` reads `ctx.item.value`.
    const ctx = {
      req: { out },
      item: { value: { functionCall: { id: 'fc_1', name: 'read_file', args: { path: '/a' } } } },
    };
    GOOGLE_STREAM_REGISTRY.effects?.googleStreamToolCall?.(ctx as never);

    expect(out.events.map((e) => [e.type, 'id' in e ? e.id : undefined])).toEqual([
      ['tool_call_start', 'fc_1'],
      ['tool_call_delta', 'fc_1'],
      ['tool_call_end', 'fc_1'],
    ]);
  });
});
