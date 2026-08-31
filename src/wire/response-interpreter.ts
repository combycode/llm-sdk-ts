/** Build a unified response from a provider body, driven by a spec.
 *
 *  The request side has been spec-driven since 3.0.0; the parse side is seven
 *  hand-written `parseResponse` implementations doing the same four things in
 *  four different spellings. This is the other half.
 *
 *  -- what is reused, and why that matters ----------------------------------
 *  Everything except classification. `evalTemplate`, `evalCond`, `$`, `$map`,
 *  `$call`, `$table`, `$join`, `$when` and `$default` come from the request
 *  interpreter unchanged, because that evaluator never cared what the root
 *  object was: it resolves paths against `ctx.req`, and nothing in it is
 *  request-shaped. Handing it a response body costs nothing, and means the
 *  Python port inherits the whole evaluator it has already transposed.
 *
 *  -- the one genuinely new thing -------------------------------------------
 *  Requests map a tree onto another tree. Responses must first CLASSIFY: every
 *  provider returns a heterogeneous array (Anthropic `content[]`, OpenAI
 *  `output[]`, Google `parts[]`) whose elements are discriminated by a type
 *  field and fan out to different destinations. `$map` cannot express that,
 *  because one element may need to land in TWO places at once.
 *
 *  Hence `collect`: walk an array, switch on a discriminator, emit into named
 *  accumulators. `emit: ['content', 'toolCalls']` places the SAME object
 *  reference in both, which is what the hand-written adapters do today
 *  (`content.push(tc); toolCalls.push(tc)`) and is load-bearing: a consumer that
 *  mutates `response.toolCalls[0]` sees it in `response.content` too.
 *
 *  -- the root object -------------------------------------------------------
 *  Paths resolve against `{ raw, out }`, in BOTH phases:
 *
 *      { "$": "raw.stop_reason" }     the provider body
 *      { "$map": "out.content" }      what has been collected so far
 *      { "$": "@text" }               the block currently being classified
 *
 *  `out` is readable during collection on purpose: Anthropic attaches a tool
 *  result to the builtin call it belongs to by matching `tool_use_id` against
 *  calls already collected, and that is a lookup into `out`, not into `raw`.
 */
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

/** How an accumulator behaves. Declared up front so that "absent" and "empty"
 *  are a decision in the spec rather than an accident of what the body held:
 *  `content` is an array even when empty, `files` is absent unless the turn
 *  produced one, and a response type grows by OPTIONAL fields only. */
export interface AccumulatorDecl {
  kind: 'array' | 'scalar';
  /** Arrays: drop the key entirely when nothing landed in it. */
  omitEmpty?: boolean;
  /** Scalars: the value when nothing was emitted. `thinking` is null, not absent. */
  default?: Json;
  /** Working state, never assembled into the result.
   *
   *  OpenAI's `program` items must carry the reasoning items that preceded them
   *  in the same output -- the program cannot be sent back without them -- so
   *  those items are collected as they go and read by a later block. They are
   *  scaffolding for the build, not a field of the response. */
  internal?: boolean;
}

export interface EmitRule {
  /** Accumulator name, or several. Several means ONE evaluated value placed in
   *  each -- the same reference, not copies. Omitted only with `effect`. */
  emit?: string | string[];
  /** `push` appends one value (default); `concat` splices an evaluated ARRAY in,
   *  for a block that yields several (one Anthropic code-execution result can
   *  carry more than one output file); `scalar` assigns, last write wins. */
  mode?: 'push' | 'concat' | 'scalar';
  /** Extra guard beyond the discriminator match. */
  when?: Cond;
  as?: Json;
  /** A named effect run for this block INSTEAD of emitting.
   *
   *  Some blocks modify what is already collected rather than adding to it:
   *  Anthropic's `*_tool_result` attaches its stdout to the `server_tool_use`
   *  it belongs to, matched on `tool_use_id`. That is a lookup into `out` and a
   *  write to an object already in it, which no amount of emitting expresses.
   *  The effect receives the block as `ctx.item` and the accumulators at
   *  `ctx.req.out`. */
  effect?: string;
}

export interface CollectRule {
  /** Path to the array to walk, e.g. `raw.content`. A missing or non-array value
   *  is not an error: a response with no content is a normal response. */
  from: string;
  /** Field on each element that selects the case, e.g. `type`.
   *
   *  OPTIONAL, because not every provider discriminates by a field. OpenAI's
   *  `tool_calls` is homogeneous -- every element is a tool call -- and Google's
   *  `parts[]` discriminates by WHICH KEY EXISTS (`text` vs `functionCall` vs
   *  `inlineData`) rather than by a type tag. With no `match`, every element
   *  takes `default`, whose rules carry their own `when`. */
  match?: string;
  cases?: Record<string, EmitRule | EmitRule[]>;
  /** Elements matching no case. Omitted means ignore them, which is the right
   *  default: providers add block types continuously, and an unknown one must
   *  not break the whole parse. */
  default?: EmitRule | EmitRule[];
}

export interface ResponseFieldRule {
  to: string;
  /** Path in the root object. Mutually exclusive with `value`. */
  from?: string;
  value?: Json;
  when?: Cond;
  /** Used when `from` resolves to undefined. */
  default?: Json;
}

export interface ResponseSpec {
  id: string;
  extends?: string;
  accumulators?: Record<string, AccumulatorDecl>;
  fields?: ResponseFieldRule[];
  /** Emits that are not driven by walking an array, run BEFORE `collect`.
   *
   *  OpenAI puts the assistant's text at `message.content` and its spoken audio
   *  at `message.audio` -- two single values, not elements of anything -- and
   *  both must sit in `content` ahead of the tool calls, because order inside
   *  `content` is what a consumer renders. */
  seed?: EmitRule[];
  collect?: CollectRule[];
  /** Emits run AFTER `collect`, for what can only be decided once everything is
   *  in. OpenAI falls back to the `output_text` convenience field, but only when
   *  no message item produced text AND nothing else landed in `content` -- a
   *  condition that does not exist until the walk is over. */
  finalize?: EmitRule[];
  /** Computed last, so they can read everything `collect` produced. A derived
   *  value overrides an accumulator of the same name. */
  derive?: Record<string, Json>;
  tables?: Record<string, Record<string, Json>>;
  _note?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Flatten a spec's `extends` chain.
 *
 *  OpenRouter is Chat Completions plus one rule: a `url_citation` annotation is
 *  the only signal that its `:online` search ran. Copying the OpenAI spec to add
 *  that rule would leave two files to keep in step, and they would diverge the
 *  first time only one was edited -- which is the whole argument for specs.
 *
 *  Merge rules, one line each:
 *    accumulators / derive / tables  merge by key, child wins
 *    fields                          merge by `to`, child replaces, new append
 *    seed / collect                  APPEND, parent first
 *
 *  Append rather than merge for the ordered ones, because their order is their
 *  meaning: a child adding to `content` adds AFTER what the parent put there.
 */
export function resolveResponseSpec(
  id: string,
  byId: Map<string, ResponseSpec>,
  seen: Set<string> = new Set(),
): ResponseSpec {
  if (seen.has(id)) throw new Error(`cycle in response spec inheritance at ${id}`);
  seen.add(id);
  const spec = byId.get(id);
  if (!spec) throw new Error(`unknown response spec: ${id}`);
  if (!spec.extends) return spec;

  const base = resolveResponseSpec(spec.extends, byId, seen);
  const fields = [...(base.fields ?? [])];
  for (const f of spec.fields ?? []) {
    const at = fields.findIndex((x) => x.to === f.to);
    if (at >= 0) fields[at] = f;
    else fields.push(f);
  }
  return {
    ...base,
    ...spec,
    accumulators: { ...(base.accumulators ?? {}), ...(spec.accumulators ?? {}) },
    fields,
    seed: [...(base.seed ?? []), ...(spec.seed ?? [])],
    collect: [...(base.collect ?? []), ...(spec.collect ?? [])],
    derive: { ...(base.derive ?? {}), ...(spec.derive ?? {}) },
    tables: { ...(base.tables ?? {}), ...(spec.tables ?? {}) },
  };
}

/** The accumulators, initialised from their declarations. */
function initOut(spec: ResponseSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, decl] of Object.entries(spec.accumulators ?? {})) {
    out[name] = decl.kind === 'array' ? [] : (decl.default ?? null);
  }
  return out;
}

function emitInto(
  out: Record<string, unknown>,
  rule: EmitRule,
  value: unknown,
  specId: string,
): void {
  const names = Array.isArray(rule.emit) ? rule.emit : [rule.emit as string];
  for (const name of names) {
    if (!(name in out)) {
      // A typo here would silently discard everything it emitted, which is the
      // failure mode this whole exercise exists to end.
      throw new Error(`${specId}: emit names undeclared accumulator "${name}"`);
    }
    if (rule.mode === 'scalar') {
      out[name] = value;
      continue;
    }
    const target = out[name];
    if (!Array.isArray(target)) {
      throw new Error(`${specId}: cannot push into scalar accumulator "${name}"`);
    }
    if (rule.mode === 'concat') {
      if (!Array.isArray(value)) {
        throw new Error(`${specId}: concat into "${name}" needs an array, got ${typeof value}`);
      }
      target.push(...value);
      continue;
    }
    target.push(value);
  }
}

export interface BuildResponseOptions {
  /** Merged in before `fields`, for values the spec cannot know: `latencyMs`,
   *  and `raw` itself. */
  extra?: Record<string, unknown>;
  /** Adapter config, for `$config`. */
  config?: Record<string, unknown>;
}

export function buildResponse(
  spec: ResponseSpec,
  raw: unknown,
  reg: Registry,
  opts: BuildResponseOptions = {},
): Record<string, unknown> {
  const out = initOut(spec);
  const root = { raw, out };

  // The spec is handed to the shared evaluator as a WireSpec because `$table`
  // reads `ctx.spec.tables`. Only `tables` is touched on this path.
  const ctx: Ctx = {
    req: root,
    spec: spec as unknown as WireSpec,
    flavor: '',
    config: opts.config ?? {},
    variants: new Set<string>(),
    body: {},
  };

  const evaluate = (tpl: Json, c: Ctx = ctx): Json | typeof OMIT => evalTemplate(tpl, c, reg);

  // -- 1. scalars straight across -------------------------------------------
  const result: Record<string, unknown> = { ...(opts.extra ?? {}) };
  for (const f of spec.fields ?? []) {
    if (!evalCond(f.when, ctx, reg)) continue;
    let v: unknown;
    if (f.from !== undefined) {
      v = getPath(root, f.from);
      if (v === undefined) v = f.default;
    } else {
      const t = evaluate(f.value as Json);
      v = t === OMIT ? f.default : t;
    }
    if (v !== undefined) result[f.to] = v;
  }

  /** One emit rule, in whatever scope it was given. */
  const apply = (r: EmitRule, c: Ctx): void => {
    if (!evalCond(r.when, c, reg)) return;
    if (r.effect) {
      const fn = reg.effects[r.effect];
      if (!fn) throw new Error(`${spec.id}: unknown effect "${r.effect}"`);
      fn(c);
      return;
    }
    const value = evaluate(r.as as Json, c);
    if (value === OMIT) return;
    emitInto(out, r, value, spec.id);
  };

  // -- 2. seed the accumulators with what is not in any array -----------------
  for (const r of spec.seed ?? []) apply(r, ctx);

  // -- 3. classify -----------------------------------------------------------
  for (const rule of spec.collect ?? []) {
    const arr = getPath(root, rule.from);
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const block = arr[i];
      const key =
        rule.match !== undefined && isObj(block) ? String(getPath(block, rule.match)) : undefined;
      const picked = (key !== undefined ? rule.cases?.[key] : undefined) ?? rule.default;
      if (!picked) continue;
      const rules = Array.isArray(picked) ? picked : [picked];
      const itemCtx: Ctx = {
        ...ctx,
        item: { value: block, index: i, isLast: i === arr.length - 1 },
      };
      for (const r of rules) apply(r, itemCtx);
    }
  }

  // -- 4. what only makes sense once the walk is over -------------------------
  for (const r of spec.finalize ?? []) apply(r, ctx);

  // -- 5. derive, now that everything is collected ---------------------------
  const derived: Record<string, unknown> = {};
  for (const [name, tpl] of Object.entries(spec.derive ?? {})) {
    const v = evaluate(tpl);
    if (v !== OMIT) derived[name] = v;
  }

  // -- 6. assemble -----------------------------------------------------------
  for (const [name, decl] of Object.entries(spec.accumulators ?? {})) {
    if (decl.internal) continue;
    const v = out[name];
    if (decl.kind === 'array' && decl.omitEmpty && Array.isArray(v) && v.length === 0) continue;
    result[name] = v;
  }
  Object.assign(result, derived);
  return result;
}
