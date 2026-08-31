/** The response interpreter, primitive by primitive.
 *
 *  These are deliberately about the MACHINE, not about any provider: a bug here
 *  is a bug in all seven parsers at once, so it is worth pinning separately from
 *  the differential that replays real bodies.
 */
import { describe, expect, it } from 'bun:test';
import { buildResponse, type ResponseSpec } from '../../../src/wire/response-interpreter';
import type { Registry } from '../../../src/wire/interpreter';

const REG: Registry = {
  transforms: {
    upper: (arg: unknown) => String(arg).toUpperCase(),
    parseJson: (arg: unknown) => JSON.parse(String(arg)),
    /** A block yielding SEVERAL values, for `concat`. */
    twoFiles: () => [{ id: 'a' }, { id: 'b' }],
    /** The shape a real spec uses for `text`: a fold over collected content. */
    joinText: (_arg: unknown, ctx) =>
      ((ctx.req as { out: { content: Array<{ type: string; text?: string }> } }).out.content ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text ?? '')
        .join(''),
  },
  builders: {},
  predicates: {
    hasTools: (ctx) => ((ctx.req as { out: { toolCalls: unknown[] } }).out.toolCalls.length > 0),
  },
  effects: {
    /** Attach a result block's stdout to the call it names. */
    attachOutput: (ctx) => {
      const b = (ctx.item?.value ?? {}) as Record<string, unknown>;
      const calls = (ctx.req as { out: { toolCalls: Array<{ id?: string; output?: string }> } }).out
        .toolCalls;
      const call = calls.find((c) => c.id === b.tool_use_id);
      if (call && typeof b.stdout === 'string') call.output = b.stdout;
    },
  },
};

/** An Anthropic-shaped spec, small enough to read in one screen. */
const SPEC: ResponseSpec = {
  id: 'test/messages.response',
  accumulators: {
    content: { kind: 'array' },
    toolCalls: { kind: 'array' },
    files: { kind: 'array', omitEmpty: true },
    thinking: { kind: 'scalar', default: null },
  },
  fields: [
    { to: 'id', from: 'raw.id' },
    { to: 'model', from: 'raw.model' },
  ],
  collect: [
    {
      from: 'raw.content',
      match: 'type',
      cases: {
        text: { emit: 'content', as: { type: 'text', text: { $: '@text' } } },
        thinking: { emit: 'thinking', mode: 'scalar', as: { $: '@thinking' } },
        tool_use: {
          emit: ['content', 'toolCalls'],
          as: {
            type: 'tool_call',
            id: { $: '@id' },
            name: { $: '@name' },
            arguments: { $: '@input' },
          },
        },
        file: { emit: 'files', when: { itemTruthy: 'file_id' }, as: { id: { $: '@file_id' } } },
      },
    },
  ],
  derive: {
    finishReason: { $table: 'finish', $key: 'raw.stop_reason', $default: 'stop' },
  },
  tables: { finish: { max_tokens: 'length', refusal: 'content_filter' } },
};

const body = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  model: 'claude-test',
  stop_reason: 'end_turn',
  content,
  ...extra,
});

describe('fields', () => {
  it('copies scalars from the raw body', () => {
    const r = buildResponse(SPEC, body([]), REG);
    expect(r.id).toBe('msg_1');
    expect(r.model).toBe('claude-test');
  });

  it('merges `extra` for what the spec cannot know', () => {
    const r = buildResponse(SPEC, body([]), REG, { extra: { latencyMs: 42 } });
    expect(r.latencyMs).toBe(42);
  });
});

describe('collect', () => {
  it('routes each block by its discriminator', () => {
    const r = buildResponse(
      SPEC,
      body([
        { type: 'text', text: 'hello' },
        { type: 'thinking', thinking: 'hmm' },
      ]),
      REG,
    );
    expect(r.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(r.thinking).toBe('hmm');
  });

  it('puts the SAME object in every accumulator it names', () => {
    // Load-bearing: the hand-written adapters push one object into both arrays,
    // so a consumer mutating response.toolCalls[0] sees it in content too.
    // Copies would pass a deep-equality test and change that behaviour.
    const r = buildResponse(SPEC, body([{ type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } }]), REG);
    const fromContent = (r.content as unknown[])[0];
    const fromCalls = (r.toolCalls as unknown[])[0];
    expect(fromCalls).toBe(fromContent);
  });

  it('a scalar emit is last-write-wins, not an append', () => {
    const r = buildResponse(
      SPEC,
      body([
        { type: 'thinking', thinking: 'first' },
        { type: 'thinking', thinking: 'second' },
      ]),
      REG,
    );
    expect(r.thinking).toBe('second');
  });

  it('honours a `when` guard on top of the discriminator', () => {
    const r = buildResponse(
      SPEC,
      body([
        { type: 'file', file_id: 'f_1' },
        { type: 'file' }, // no id -> guarded out
      ]),
      REG,
    );
    expect(r.files).toEqual([{ id: 'f_1' }]);
  });

  it('ignores a block type nothing declares, rather than throwing', () => {
    // Providers add block types continuously. An unknown one must not take the
    // whole response down.
    const r = buildResponse(
      SPEC,
      body([{ type: 'some_future_thing', x: 1 }, { type: 'text', text: 'ok' }]),
      REG,
    );
    expect(r.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('survives a missing or non-array source', () => {
    expect(buildResponse(SPEC, { id: 'x' }, REG).content).toEqual([]);
    expect(buildResponse(SPEC, body('not an array' as never), REG).content).toEqual([]);
  });

  it('concat splices an array in, where push would nest it', () => {
    // One code-execution result block can carry several output files. `push`
    // there yields files: [[a, b]], which is a different response.
    const spec: ResponseSpec = {
      ...SPEC,
      collect: [
        {
          from: 'raw.content',
          match: 'type',
          cases: {
            file: { emit: 'files', mode: 'concat', as: { $call: 'twoFiles' } },
          },
        },
      ],
    };
    const r = buildResponse(spec, body([{ type: 'file' }]), REG);
    expect(r.files).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('concat refuses a non-array rather than corrupting the accumulator', () => {
    const spec: ResponseSpec = {
      ...SPEC,
      collect: [
        {
          from: 'raw.content',
          match: 'type',
          cases: { file: { emit: 'files', mode: 'concat', as: { notAn: 'array' } } },
        },
      ],
    };
    expect(() => buildResponse(spec, body([{ type: 'file' }]), REG)).toThrow(/concat into "files"/);
  });

  it('an effect can modify something already collected', () => {
    // The case emitting cannot express: a result block attaches its output to a
    // call collected earlier, matched by id.
    const spec: ResponseSpec = {
      ...SPEC,
      collect: [
        {
          from: 'raw.content',
          match: 'type',
          cases: {
            tool_use: {
              emit: ['content', 'toolCalls'],
              as: { type: 'tool_call', id: { $: '@id' }, name: { $: '@name' } },
            },
            result: { effect: 'attachOutput' },
          },
        },
      ],
    };
    const r = buildResponse(
      spec,
      body([
        { type: 'tool_use', id: 't1', name: 'f' },
        { type: 'result', tool_use_id: 't1', stdout: 'done' },
      ]),
      REG,
    );
    expect((r.toolCalls as Array<{ output?: string }>)[0].output).toBe('done');
  });

  it('rejects an effect name nothing registers', () => {
    const spec: ResponseSpec = {
      ...SPEC,
      collect: [
        { from: 'raw.content', match: 'type', cases: { text: { effect: 'nope' } } },
      ],
    };
    expect(() => buildResponse(spec, body([{ type: 'text', text: 'x' }]), REG)).toThrow(
      /unknown effect "nope"/,
    );
  });

  it('refuses to emit into an accumulator nobody declared', () => {
    const bad: ResponseSpec = {
      ...SPEC,
      collect: [
        { from: 'raw.content', match: 'type', cases: { text: { emit: 'typo', as: { a: 1 } } } },
      ],
    };
    expect(() => buildResponse(bad, body([{ type: 'text', text: 'x' }]), REG)).toThrow(
      /undeclared accumulator "typo"/,
    );
  });
});

describe('accumulator shape', () => {
  it('keeps an empty array, but omits one marked omitEmpty', () => {
    const r = buildResponse(SPEC, body([]), REG);
    expect(r.content).toEqual([]);
    expect('files' in r).toBe(false);
  });

  it('gives a scalar its declared default when nothing was emitted', () => {
    expect(buildResponse(SPEC, body([]), REG).thinking).toBeNull();
  });
});

describe('derive', () => {
  it('runs after collect and can read what was collected', () => {
    // The ordering is the point: `text` is a fold over `content`, which does not
    // exist until every block has been classified. Running derive first would
    // silently produce an empty string on every response.
    const spec: ResponseSpec = {
      ...SPEC,
      derive: {
        ...SPEC.derive,
        text: { $call: 'joinText' },
        hadTools: { $when: { pred: 'hasTools' }, $value: true },
      },
    };
    const r = buildResponse(
      spec,
      body([
        { type: 'text', text: 'one ' },
        { type: 'tool_use', id: 't', name: 'n', input: {} },
        { type: 'text', text: 'two' },
      ]),
      REG,
    );
    expect(r.text).toBe('one two');
    expect(r.hadTools).toBe(true);
  });

  it('a predicate reading `out` is false when nothing was collected', () => {
    const spec: ResponseSpec = {
      ...SPEC,
      derive: { hadTools: { $when: { pred: 'hasTools' }, $value: true } },
    };
    expect('hadTools' in buildResponse(spec, body([{ type: 'text', text: 'x' }]), REG)).toBe(false);
  });

  it('maps through a table, with a default', () => {
    expect(buildResponse(SPEC, body([], { stop_reason: 'max_tokens' }), REG).finishReason).toBe('length');
    expect(buildResponse(SPEC, body([], { stop_reason: 'end_turn' }), REG).finishReason).toBe('stop');
  });

  it('overrides an accumulator of the same name', () => {
    const spec: ResponseSpec = { ...SPEC, derive: { thinking: 'derived wins' } };
    const r = buildResponse(spec, body([{ type: 'thinking', thinking: 'collected' }]), REG);
    expect(r.thinking).toBe('derived wins');
  });
});
