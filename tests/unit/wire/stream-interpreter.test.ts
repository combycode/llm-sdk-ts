/** The streaming driver, primitive by primitive.
 *
 *  What separates it from the buffered interpreter is exactly two things, and
 *  both are pinned here: `out` survives across events, and `events` is drained
 *  after each one. Everything else is shared code and is tested next door.
 *
 *  The mini-spec below is deliberately shaped like the hardest real case --
 *  Anthropic's `server_tool_use`, whose input JSON arrives in fragments, is
 *  parsed when its block closes, and is then paired with the result block that
 *  completes it. If the driver can carry that, it can carry the rest.
 */
import { describe, expect, it } from 'bun:test';
import { createStreamBuilder, type StreamSpec } from '../../../src/wire/stream-interpreter';
import type { Ctx, Registry } from '../../../src/wire/interpreter';

type Out = {
  events: unknown[];
  current: { id: string; json: string } | null;
  pending: Record<string, unknown>;
};
const outOf = (ctx: Ctx): Out => (ctx.req as { out: Out }).out;
const rawOf = (ctx: Ctx): Record<string, unknown> =>
  (ctx.req as { raw: Record<string, unknown> }).raw;

const REG: Registry = {
  transforms: {},
  builders: {},
  predicates: {
    /** True while a tool block is open -- the fragments belong to it. */
    accumulating: (ctx) => outOf(ctx).current !== null,
  },
  effects: {
    openTool: (ctx) => {
      outOf(ctx).current = { id: rawOf(ctx).id as string, json: '' };
    },
    /** A fragment either feeds the open block or is emitted as a plain delta. */
    fragment: (ctx) => {
      const out = outOf(ctx);
      const piece = (rawOf(ctx).partial as string) ?? '';
      if (out.current) out.current.json += piece;
      else out.events.push({ type: 'tool_call_delta', arguments: piece });
    },
    closeTool: (ctx) => {
      const out = outOf(ctx);
      if (!out.current) return;
      out.pending[out.current.id] = JSON.parse(out.current.json || '{}');
      out.current = null;
    },
    /** Pair the result with the input collected earlier. */
    pair: (ctx) => {
      const out = outOf(ctx);
      const id = rawOf(ctx).for as string;
      out.events.push({ type: 'builtin_tool_end', id, input: out.pending[id] ?? null });
      delete out.pending[id];
    },
  },
};

const SPEC: StreamSpec = {
  id: 'test/stream',
  state: {
    current: { kind: 'scalar', default: null },
    pending: { kind: 'scalar', default: {} },
    seen: { kind: 'array' },
  },
  on: [
    { when: { eq: ['event.name', 'ping'] }, stop: true },
    {
      match: 'type',
      cases: {
        text: { emit: 'events', as: { type: 'text', text: { $: 'raw.text' } } },
        open: { effect: 'openTool' },
        fragment: { effect: 'fragment' },
        close: { effect: 'closeTool' },
        result: { effect: 'pair' },
        counted: { emit: 'seen', as: { $: '@id' } },
      },
    },
  ],
};

const sse = (data: unknown, name?: string) => ({
  ...(name ? { event: name } : {}),
  data: typeof data === 'string' ? data : JSON.stringify(data),
});

describe('per-event output', () => {
  it('returns only what THIS event produced', () => {
    const parse = createStreamBuilder(SPEC, REG);
    expect(parse(sse({ type: 'text', text: 'a' }))).toEqual([{ type: 'text', text: 'a' }]);
    // Drained: the previous event's output must not come back a second time.
    expect(parse(sse({ type: 'text', text: 'b' }))).toEqual([{ type: 'text', text: 'b' }]);
  });

  it('returns nothing for an event that maps to nothing', () => {
    const parse = createStreamBuilder(SPEC, REG);
    expect(parse(sse({ type: 'something_new_next_year' }))).toEqual([]);
  });

  it('stops on a guarded rule without falling through to the switch', () => {
    const parse = createStreamBuilder(SPEC, REG);
    // A ping whose payload would otherwise match `text`.
    expect(parse(sse({ type: 'text', text: 'nope' }, 'ping'))).toEqual([]);
  });
});

describe('state survives across events', () => {
  it('carries an accumulator from one event to the next', () => {
    const parse = createStreamBuilder(SPEC, REG);
    parse(sse({ type: 'counted', id: 'a' }));
    parse(sse({ type: 'counted', id: 'b' }));
    // Third event proves both earlier ones are still there.
    parse(sse({ type: 'counted', id: 'c' }));
    // `seen` is state, not output, so it never appears in a return value.
    const last = parse(sse({ type: 'text', text: 'x' }));
    expect(last).toEqual([{ type: 'text', text: 'x' }]);
  });

  it('accumulates fragments, then pairs them with a later event', () => {
    // The whole reason this driver exists.
    const parse = createStreamBuilder(SPEC, REG);
    expect(parse(sse({ type: 'open', id: 't1' }))).toEqual([]);
    expect(parse(sse({ type: 'fragment', partial: '{"q":' }))).toEqual([]);
    expect(parse(sse({ type: 'fragment', partial: '"hi"}' }))).toEqual([]);
    expect(parse(sse({ type: 'close' }))).toEqual([]);
    expect(parse(sse({ type: 'result', for: 't1' }))).toEqual([
      { type: 'builtin_tool_end', id: 't1', input: { q: 'hi' } },
    ]);
  });

  it('emits a fragment as a delta when no block is open', () => {
    // Same event type, opposite behaviour, decided purely by carried state.
    const parse = createStreamBuilder(SPEC, REG);
    expect(parse(sse({ type: 'fragment', partial: 'abc' }))).toEqual([
      { type: 'tool_call_delta', arguments: 'abc' },
    ]);
  });

  it('gives each stream its own state', () => {
    // Two conversations must not share a pending map.
    const a = createStreamBuilder(SPEC, REG);
    const b = createStreamBuilder(SPEC, REG);
    a(sse({ type: 'open', id: 't1' }));
    a(sse({ type: 'fragment', partial: '{"q":1}' }));
    a(sse({ type: 'close' }));
    // `b` never saw t1, so it pairs with nothing.
    expect(b(sse({ type: 'result', for: 't1' }))).toEqual([
      { type: 'builtin_tool_end', id: 't1', input: null },
    ]);
  });
});

describe('the SSE envelope', () => {
  it('survives a payload that is not JSON', () => {
    const parse = createStreamBuilder(SPEC, REG);
    expect(parse(sse('[DONE]'))).toEqual([]);
  });

  it('lets a spec match on the raw payload text', () => {
    const spec: StreamSpec = {
      id: 'test/sentinel',
      on: [
        {
          when: { eq: ['event.data', '[DONE]'] },
          match: 'nothing',
          default: { emit: 'events', as: { type: 'done' } },
        },
      ],
    };
    const parse = createStreamBuilder(spec, REG);
    expect(parse(sse('[DONE]'))).toEqual([{ type: 'done' }]);
    expect(parse(sse({ type: 'text' }))).toEqual([]);
  });
});

describe('guard rails', () => {
  it('refuses a spec that declares the reserved accumulator', () => {
    expect(() =>
      createStreamBuilder(
        { id: 'test/bad', state: { events: { kind: 'array' } } },
        REG,
      ),
    ).toThrow(/"events" is reserved/);
  });

  it('refuses an effect name nothing registers', () => {
    const spec: StreamSpec = {
      id: 'test/bad-effect',
      on: [{ match: 'type', cases: { text: { effect: 'nope' } } }],
    };
    expect(() => createStreamBuilder(spec, REG)(sse({ type: 'text' }))).toThrow(
      /unknown effect "nope"/,
    );
  });

  it('refuses an emit into an accumulator nobody declared', () => {
    const spec: StreamSpec = {
      id: 'test/bad-emit',
      on: [{ match: 'type', cases: { text: { emit: 'typo', as: 1 } } }],
    };
    expect(() => createStreamBuilder(spec, REG)(sse({ type: 'text' }))).toThrow(
      /undeclared accumulator "typo"/,
    );
  });
});
