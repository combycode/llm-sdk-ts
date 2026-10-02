/** The `shell` builtin tool: two items for one call, and a call that is a request.
 *
 *  Every fixture here is a transcription of a live capture (2026-10-02), because
 *  the three things that make this tool awkward are all things a reasonable guess
 *  gets wrong:
 *
 *  - A container-run shell arrives as TWO output items. The `shell_call` completes
 *    carrying only the commands, and a separate `shell_call_output` follows with
 *    stdout/stderr, linked by `call_id`. Ending the tool call when the first item
 *    completes reports a command that printed nothing.
 *  - `container_auto` is not what comes back. OpenAI rewrites it to
 *    `{type:'container_reference', container_id}`.
 *  - A LOCAL shell call is not a finished call at all: the model only asks. The turn
 *    then ends `finishReason: 'stop'` with empty text, which is why it earns a
 *    warning rather than silence.
 *
 *  xAI is in here too: it supports the tool but names its stream events
 *  `response.shell_call_arguments.*` and sends one JSON string, so the fixtures
 *  pin that it still produces a start and an end from the ITEM alone.
 */

import { describe, expect, it } from 'bun:test';
import { OpenAIResponsesAdapter } from '../../../src/index';
import type { SSEEvent } from '../../../src/network/types';
import {
  shellAwaitsCaller,
  shellCommands,
  shellEnvironmentName,
  shellOutputText,
} from '../../../src/llm/providers/openai/responses';
import { mergeShellCalls, shellAwaitingNote } from '../../../src/llm/shell-calls';
import type { BuiltinToolCall } from '../../../src/llm/types/response';

const CONTAINER = {
  type: 'container_reference',
  container_id: 'cntr_6abf9290ddd881909b1563293d7c0d9609a6aff72865cc09',
};

const CALL_ITEM = {
  id: 'sh_0a11752d3fae1343006abf9292145887d1b008b4208991f3f2',
  type: 'shell_call',
  status: 'completed',
  call_id: 'call_NGiUM0QYjkGU1y2HiTOhaZrd',
  action: { commands: ['echo one', 'ls /nonexistent'], max_output_length: null, timeout_ms: null },
  environment: CONTAINER,
};

const STDERR_LINE = "ls: cannot access '/nonexistent': No such file or directory\n";

const OUTPUT_ITEM = {
  id: 'sho_0a11752d3fae1343006abf9292b66087d184d376be57f190f6',
  type: 'shell_call_output',
  status: 'completed',
  call_id: 'call_NGiUM0QYjkGU1y2HiTOhaZrd',
  output: [
    { outcome: { type: 'exit', exit_code: 0 }, stdout: 'one\n', stderr: '' },
    { outcome: { type: 'exit', exit_code: 2 }, stdout: '', stderr: STDERR_LINE },
  ],
};

const COMBINED = `one\n${STDERR_LINE}`;

function sse(payload: Record<string, unknown>): SSEEvent {
  return { event: String(payload.type), data: JSON.stringify(payload) } as SSEEvent;
}

/** Feed a whole stream through ONE parser, as a real stream does.
 *
 *  `createStreamParser()` rather than `parseStreamEvent()`: the latter builds a
 *  fresh parser per event, so every piece of cross-event state resets. The join
 *  between a shell call and its output item is exactly that kind of state, and
 *  using the per-event entry point here reported an end event carrying only
 *  `output` -- no commands, no environment. */
function streamOf(payloads: Record<string, unknown>[]) {
  const parse = new OpenAIResponsesAdapter({ apiKey: 'k' }).createStreamParser();
  const events: Record<string, unknown>[] = [];
  for (const p of payloads) {
    for (const e of parse(sse(p))) events.push(e as Record<string, unknown>);
  }
  return events;
}

const CONTAINER_STREAM: Record<string, unknown>[] = [
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...CALL_ITEM, status: 'in_progress', action: { commands: [] } },
  },
  { type: 'response.shell_call_command.added', command: '', command_index: 0, output_index: 0 },
  { type: 'response.shell_call_command.delta', command_index: 0, delta: 'echo', output_index: 0 },
  { type: 'response.shell_call_command.delta', command_index: 0, delta: ' one', output_index: 0 },
  {
    type: 'response.shell_call_command.done',
    command: 'echo one',
    command_index: 0,
    output_index: 0,
  },
  { type: 'response.output_item.done', output_index: 0, item: CALL_ITEM },
  {
    type: 'response.output_item.added',
    output_index: 1,
    item: { ...OUTPUT_ITEM, status: 'in_progress', output: [] },
  },
  {
    type: 'response.shell_call_output_content.delta',
    command_index: 0,
    delta: { stdout: 'one\n' },
    item_id: OUTPUT_ITEM.id,
    output_index: 1,
  },
  {
    type: 'response.shell_call_output_content.delta',
    command_index: 1,
    delta: { stderr: STDERR_LINE },
    item_id: OUTPUT_ITEM.id,
    output_index: 1,
  },
  { type: 'response.output_item.done', output_index: 1, item: OUTPUT_ITEM },
];

describe('reading a shell_call item', () => {
  it('joins several commands into one script', () => {
    // They run in order and read as a small script, so `code` is one block.
    expect(shellCommands(CALL_ITEM)).toBe('echo one\nls /nonexistent');
  });

  it('calls a missing or null environment `local`', () => {
    // OpenAI sends `null` for a local call; xAI omits the key entirely. Both mean
    // nobody has run these commands.
    expect(shellEnvironmentName({ type: 'shell_call', environment: null })).toBe('local');
    expect(shellEnvironmentName({ type: 'shell_call' })).toBe('local');
  });

  it('reports the container the provider actually chose', () => {
    // `container_auto` was the REQUEST; this is what comes back.
    expect(shellEnvironmentName(CALL_ITEM)).toBe('container_reference');
  });

  it('knows which calls are waiting on the caller', () => {
    expect(shellAwaitsCaller(CALL_ITEM)).toBe(false);
    expect(shellAwaitsCaller({ type: 'shell_call', environment: null })).toBe(true);
    // Not a shell call at all.
    expect(shellAwaitsCaller({ type: 'web_search_call' })).toBe(false);
  });

  it('keeps stdout and stderr in the order the commands wrote them', () => {
    // stderr is not dropped: a failing command's only output is usually there, and
    // `output` is a caller's whole view of what happened.
    expect(shellOutputText(OUTPUT_ITEM)).toBe(COMBINED);
  });

  it('skips the empty halves instead of padding with blanks', () => {
    expect(shellOutputText({ output: [{ stdout: '', stderr: '' }] })).toBe('');
  });
});

describe('a container-run shell, streamed', () => {
  it('announces the tool once, not once per item', () => {
    // The regression this pins: `shell_call_output` maps to a builtin call, so the
    // item-added effect reported `starts=2 ends=1` for a single `echo` until it was
    // told to skip the output half. Caught live, not by review.
    const events = streamOf(CONTAINER_STREAM);
    expect(events.filter((e) => e.type === 'builtin_tool_start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'builtin_tool_end')).toHaveLength(1);
  });

  it('streams the command text as it is composed', () => {
    const deltas = streamOf(CONTAINER_STREAM).filter(
      (e) => e.type === 'builtin_tool_delta' && e.code,
    );
    expect(deltas.map((e) => e.code)).toEqual(['echo', ' one']);
  });

  it('does not re-emit the finished command on done', () => {
    // `.added` carries an empty command and `.done` repeats the whole one. A
    // consumer that appends what it is given would end up with `echo oneecho one`.
    const codes = streamOf(CONTAINER_STREAM)
      .filter((e) => e.type === 'builtin_tool_delta' && e.code)
      .map((e) => e.code)
      .join('');
    expect(codes).toBe('echo one');
  });

  it('streams stdout and stderr as output deltas', () => {
    const deltas = streamOf(CONTAINER_STREAM).filter(
      (e) => e.type === 'builtin_tool_delta' && e.output,
    );
    // `delta` is an OBJECT for these events -- the one shape in the group that is
    // not a plain string, and the reason this has its own effect.
    expect(deltas.map((e) => e.output)).toEqual(['one\n', STDERR_LINE]);
  });

  it('ends the call only when the OUTPUT item lands, carrying both halves', () => {
    const end = streamOf(CONTAINER_STREAM).find((e) => e.type === 'builtin_tool_end');
    expect(end).toEqual({
      type: 'builtin_tool_end',
      tool: 'shell',
      id: CALL_ITEM.id,
      code: 'echo one\nls /nonexistent',
      callId: CALL_ITEM.call_id,
      environment: 'container_reference',
      output: COMBINED,
    });
  });

  it('does not end the call when the call item completes', () => {
    // Everything up to and including the call item's done. Ending here would report
    // a shell command that printed nothing.
    const upToCallDone = streamOf(CONTAINER_STREAM.slice(0, 6));
    expect(upToCallDone.filter((e) => e.type === 'builtin_tool_end')).toHaveLength(0);
  });
});

describe('a local shell call, streamed', () => {
  const LOCAL_ITEM = {
    id: 'sh_local',
    type: 'shell_call',
    status: 'completed',
    call_id: 'call_local',
    action: { commands: ['echo one'] },
    environment: null,
  };

  it('ends as soon as the call item completes, because no output will come', () => {
    const events = streamOf([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...LOCAL_ITEM, status: 'in_progress' },
      },
      { type: 'response.output_item.done', output_index: 0, item: LOCAL_ITEM },
    ]);
    const end = events.find((e) => e.type === 'builtin_tool_end');
    expect(end).toMatchObject({ tool: 'shell', code: 'echo one', environment: 'local' });
    expect(end && 'output' in end).toBe(false);
  });
});

describe('xAI, which supports the tool but streams it differently', () => {
  // Measured: `response.shell_call_arguments.delta` carries
  // `{"commands":["echo one","echo two"]}` -- a JSON string, not a fragment of
  // displayable command text. Nothing is emitted for it; the item carries the
  // finished commands anyway.
  const XAI_ITEM = {
    id: 'sc_2017f735-2333-9442-bd07-504c316d3040_0',
    type: 'shell_call',
    status: 'completed',
    call_id: 'call-b06e2b98-d48c-47a1-9883-c5259a45e0fa-0',
    action: { commands: ['echo one', 'echo two'], type: 'exec' },
  };

  const ARGS = '{"commands":["echo one","echo two"]}';

  const events = streamOf([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...XAI_ITEM, status: 'in_progress', action: { commands: [], type: 'exec' } },
    },
    {
      type: 'response.shell_call_arguments.delta',
      delta: ARGS,
      item_id: XAI_ITEM.id,
      output_index: 0,
    },
    {
      type: 'response.shell_call_arguments.done',
      arguments: ARGS,
      item_id: XAI_ITEM.id,
      output_index: 0,
    },
    { type: 'response.output_item.done', output_index: 0, item: XAI_ITEM },
  ]);

  it('still reports the call from the item alone', () => {
    expect(events.filter((e) => e.type === 'builtin_tool_start')).toHaveLength(1);
    expect(events.find((e) => e.type === 'builtin_tool_end')).toMatchObject({
      tool: 'shell',
      code: 'echo one\necho two',
      environment: 'local',
    });
  });

  it('invents no progress deltas out of its arguments JSON', () => {
    expect(events.filter((e) => e.type === 'builtin_tool_delta')).toHaveLength(0);
  });
});

describe('merging the two halves of a buffered response', () => {
  const call: BuiltinToolCall = {
    tool: 'shell',
    id: CALL_ITEM.id,
    code: 'echo one',
    callId: 'call_1',
    environment: 'container_reference',
  };
  const output: BuiltinToolCall = {
    tool: 'shell',
    id: OUTPUT_ITEM.id,
    callId: 'call_1',
    output: 'one\n',
  };

  it('reports one call, not two halves', () => {
    const merged = mergeShellCalls([call, output]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      code: 'echo one',
      output: 'one\n',
      environment: 'container_reference',
    });
  });

  it('pairs by call id, not by position', () => {
    // Two interleaved shell calls: position would pair the wrong halves.
    const a: BuiltinToolCall = { tool: 'shell', code: 'first', callId: 'a' };
    const b: BuiltinToolCall = { tool: 'shell', code: 'second', callId: 'b' };
    const merged = mergeShellCalls([
      a,
      b,
      { tool: 'shell', callId: 'b', output: 'B' },
      { tool: 'shell', callId: 'a', output: 'A' },
    ]);
    expect(merged.map((c) => [c.code, c.output])).toEqual([
      ['first', 'A'],
      ['second', 'B'],
    ]);
  });

  it('keeps an output whose call never arrived', () => {
    // Dropping it would hide output that really happened.
    expect(mergeShellCalls([output])).toHaveLength(1);
  });

  it('leaves other tools untouched', () => {
    const web: BuiltinToolCall = { tool: 'web_search', query: 'x' };
    expect(mergeShellCalls([web, web])).toHaveLength(2);
  });

  it('does not mutate what it was given', () => {
    // The caller's list is theirs; merging is not a side effect on the parse.
    const own: BuiltinToolCall = { ...call };
    mergeShellCalls([own, output]);
    expect(own.output).toBeUndefined();
  });

  it('does not let the output half overwrite the call half', () => {
    const merged = mergeShellCalls([call, { ...output, code: 'something else' }]);
    expect(merged[0]?.code).toBe('echo one');
  });
});

describe('the warning a local call earns', () => {
  it('fires for a call the caller has to run', () => {
    const note = shellAwaitingNote([{ tool: 'shell', environment: 'local', code: 'echo one' }]);
    expect(note).toContain('waiting on you');
    // It must name what to run and how to answer, or it is just an alarm.
    expect(note).toContain('echo one');
    expect(note).toContain('callId');
    expect(note).toContain('container_auto');
  });

  it('stays silent when the provider ran the commands itself', () => {
    expect(
      shellAwaitingNote([
        { tool: 'shell', environment: 'container_reference', output: 'one\n' },
      ]),
    ).toBeUndefined();
  });

  it('stays silent for every other tool', () => {
    expect(shellAwaitingNote([{ tool: 'code_interpreter', code: 'print(1)' }])).toBeUndefined();
    expect(shellAwaitingNote(undefined)).toBeUndefined();
  });

  it('counts them when the model asked for several', () => {
    const note = shellAwaitingNote([
      { tool: 'shell', environment: 'local', code: 'a' },
      { tool: 'shell', environment: 'local', code: 'b' },
    ]);
    expect(note).toContain('2 shell commands');
  });
});
