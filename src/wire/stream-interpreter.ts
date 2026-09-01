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
  /** Handle this rule and then stop: no later rule sees the event.
   *
   *  Two shapes need it. Anthropic's `ping` keep-alives mean nothing and must
   *  not fall through to the type switch, so the rule has no body at all.
   *  OpenAI's moderation and usage-only chunks emit and THEN return early,
   *  which is why `stop` fires after the body rather than before it. */
  stop?: boolean;
  /** Walk an array inside the payload and apply this rule to EACH element,
   *  with the element as `ctx.item` so `@`-paths address it.
   *
   *  Google sends `candidates[0].content.parts[]` on every chunk, and each part
   *  is a different kind of thing decided by which key it has -- the same shape
   *  `collect` handles on the buffered side. Without this the whole loop would
   *  collapse into one effect, which is code where it could be data. */
  each?: string;
  /** Field of the parsed payload (or of the current element, under `each`) that
   *  selects the case, e.g. `type`.
   *
   *  A LIST means "whichever of these is present", first defined wins. Google's
   *  Interactions stream discriminates on `event_type ?? type`, and writing that
   *  as two rules would fire both whenever the first was present. */
  match?: string | string[];
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
      const scopes: Ctx[] = [];
      if (rule.each !== undefined) {
        const arr = getPath(root, rule.each);
        // A missing or non-array source is not an error: a chunk with no parts
        // is a normal chunk.
        if (Array.isArray(arr)) {
          for (let i = 0; i < arr.length; i++) {
            scopes.push({
              ...ctx,
              item: { value: arr[i], index: i, isLast: i === arr.length - 1 },
            });
          }
        }
      } else {
        scopes.push(ctx);
      }

      for (const scope of scopes) {
        const subject = rule.each !== undefined ? scope.item?.value : raw;
        let key: string | undefined;
        if (rule.match !== undefined) {
          for (const path of Array.isArray(rule.match) ? rule.match : [rule.match]) {
            const v = getPath(subject, path);
            if (v !== undefined) {
              key = String(v);
              break;
            }
          }
          // Every candidate path was absent: no case can match, but `default`
          // still applies, exactly as it does for an unrecognised value.
          if (key === undefined) key = String(undefined);
        }
        const picked = (key !== undefined ? rule.cases?.[key] : undefined) ?? rule.default;
        if (!picked) continue;
        for (const r of Array.isArray(picked) ? picked : [picked]) apply(r, scope);
      }
      // AFTER the rule body, so `stop` is "handle this and go no further".
      // Anthropic's ping needs the plain form (a rule with nothing to do, which
      // just stops); OpenAI's moderation and usage-only chunks need to emit and
      // then stop, which is the same early `return` the hand-written parser does.
      if (rule.stop) return out[EVENTS] as unknown[];
    }

    return out[EVENTS] as unknown[];
  };
}
