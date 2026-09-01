/** Turn a provider's SSE events into unified stream events, driven by a spec.
 *
 *  The buffered interpreter gets the whole body at once and builds one object.
 *  A stream arrives in fragments, and the parse is a small state machine: an
 *  Anthropic `server_tool_use` accumulates its input JSON across several deltas
 *  before it can be paired with the `*_tool_result` that completes it; OpenAI
 *  correlates tool-call fragments by index because only the first carries an id;
 *  Google emits its hosted-tool events once per stream and has to remember that.
 *
 *  -- how little of this is actually new ------------------------------------
 *  Measured across the five hand-written parsers: 518 lines of code, of which
 *  38 touch state. The other 93% is dispatch and mapping -- the same thing the
 *  buffered specs express -- so this driver is the buffered one with two
 *  differences:
 *
 *    1. `out` is created ONCE for the stream, not per call, so an accumulator
 *       is how the state machine remembers.
 *    2. One reserved accumulator, `events`, is drained and returned after each
 *       SSE event. Emitting a unified event means emitting into it.
 *
 *  Everything else -- `EmitRule`, `emit`/`mode`/`when`/`as`/`effect`, the whole
 *  evaluator -- is shared verbatim.
 *
 *  -- the root object -------------------------------------------------------
 *  Paths resolve against `{ raw, out, event }`:
 *
 *      { "$": "raw.delta.text" }        the parsed event payload
 *      { "$": "out.current.tool" }      state carried across events
 *      { "eq": ["event.name", "ping"] } the SSE envelope, for keep-alives
 *
 *  `event.data` is the payload as it arrived, so a spec can match a sentinel
 *  like `[DONE]` that is not JSON at all.
 */
import {
  emitInto,
  initAccumulators,
  type AccumulatorDecl,
  type EmitRule,
} from './response-interpreter';
import {
  evalCond,
  evalTemplate,
  getPath,
  OMIT,
  type Cond,
  type Ctx,
  type Json,
  type Registry,
  type WireSpec,
} from './interpreter';

/** The accumulator every stream spec emits into. Declared by the driver, not by
 *  the spec, because a stream that cannot emit is not a stream. */
export const EVENTS = 'events';

export interface EventRule {
  /** Guard on the whole event, before any discrimination. */
  when?: Cond;
  /** Stop processing this SSE event entirely when `when` holds.
   *
   *  Anthropic sends `ping` keep-alives that mean nothing and must not fall
   *  through to the type switch below. Without this a spec would need a
   *  `not(ping)` guard repeated on every case. */
  stop?: boolean;
  /** Field of the parsed payload that selects the case, e.g. `type`. */
  match?: string;
  cases?: Record<string, EmitRule | EmitRule[]>;
  /** Payloads matching no case. Omitted means ignore them, which is right:
   *  providers add event types continuously and an unknown one must not break
   *  the stream. */
  default?: EmitRule | EmitRule[];
}

export interface StreamSpec {
  id: string;
  extends?: string;
  /** Carried for the LIFETIME OF THE STREAM. This is the state machine's memory:
   *  the open tool call, the map of ids awaiting their result, the emit-once
   *  flags. `events` is added by the driver and must not be declared here. */
  state?: Record<string, AccumulatorDecl>;
  /** Applied in order to each SSE event. */
  on?: EventRule[];
  tables?: Record<string, Record<string, Json>>;
  _note?: string;
}

/** One SSE event as the transport delivers it. Structural on purpose: `wire`
 *  does not import from `network`. */
export interface StreamInput {
  event?: string;
  data: string;
}

export interface StreamBuildOptions {
  /** Adapter config, for `$config`. */
  config?: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A payload that is not JSON is not an error: `[DONE]` and keep-alives are
 *  normal, and a spec matches them on `event.data` instead. */
function payloadOf(data: string): Record<string, unknown> {
  try {
    const v = JSON.parse(data);
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

/** Build a stream parser: call the returned function per SSE event, and it
 *  returns the unified events that event produced (often none). */
export function createStreamBuilder(
  spec: StreamSpec,
  reg: Registry,
  opts: StreamBuildOptions = {},
): (event: StreamInput) => unknown[] {
  if (spec.state && EVENTS in spec.state) {
    throw new Error(`${spec.id}: "${EVENTS}" is reserved and declared by the driver`);
  }
  // Created ONCE. This is the whole difference from the buffered interpreter.
  const out = initAccumulators(spec.state);
  out[EVENTS] = [];

  return (input: StreamInput): unknown[] => {
    const raw = payloadOf(input.data);
    const event = { name: input.event, data: input.data };
    const root = { raw, out, event };

    const ctx: Ctx = {
      req: root,
      // `$table` reads `ctx.spec.tables`; nothing else on the spec is touched.
      spec: spec as unknown as WireSpec,
      flavor: '',
      config: opts.config ?? {},
      variants: new Set<string>(),
      body: {},
      // The payload is also the current item, so `@`-paths address it exactly as
      // they address a block inside `collect`.
      item: { value: raw, index: 0, isLast: true },
    };

    const apply = (r: EmitRule, c: Ctx): void => {
      if (!evalCond(r.when, c, reg)) return;
      if (r.effect) {
        const fn = reg.effects[r.effect];
        if (!fn) throw new Error(`${spec.id}: unknown effect "${r.effect}"`);
        fn(c);
        return;
      }
      const value = evalTemplate(r.as as Json, c, reg);
      if (value === OMIT) return;
      emitInto(out, r, value, spec.id);
    };

    // Drained per event: what this call returns is what this event produced.
    // The rest of `out` survives, which is how the machine remembers.
    out[EVENTS] = [];

    for (const rule of spec.on ?? []) {
      if (rule.when && !evalCond(rule.when, ctx, reg)) continue;
      if (rule.stop) return out[EVENTS] as unknown[];
      const key = rule.match !== undefined ? String(getPath(raw, rule.match)) : undefined;
      const picked = (key !== undefined ? rule.cases?.[key] : undefined) ?? rule.default;
      if (!picked) continue;
      for (const r of Array.isArray(picked) ? picked : [picked]) apply(r, ctx);
    }

    return out[EVENTS] as unknown[];
  };
}
