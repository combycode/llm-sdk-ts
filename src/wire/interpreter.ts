/** Wire-spec interpreter — prototype for report 037 / 3.0.0.
 *
 *  Turns a declarative wire spec + a NormalizedRequest into the same
 *  ProviderHttpRequest the hand-written `buildRequest` produces today.
 *
 *  The point is NOT to eliminate code. It is to move the per-provider and
 *  per-MODEL knowledge — field names, shapes, enum values, which variant a
 *  model takes — out of imperative code and into reviewable data that the
 *  update pipeline can diff and that all three language ports can share.
 *
 *  Structural work (turning unified messages into provider content parts) stays
 *  as named code in the registry. See `transforms.ts`.
 */

// ── spec schema ─────────────────────────────────────────────────────────────

export type Json = unknown;

/** A condition evaluated against the request + resolved model variants. */
export type Cond =
  | { defined: string }
  | { truthy: string }
  | { eq: [string, Json] }
  | { ne: [string, Json] }
  | { variant: string }
  | { flavor: string | string[] }
  | { pred: string }
  /** Truthiness of a field on the current $map item. */
  | { itemTruthy: string }
  /** The current $map item equals this value (items are scalars here). */
  | { itemEq: Json }
  | { isLast: true }
  | { isFunctionTool: true }
  | { builtin: string }
  /** `req.tools` contains a builtin of this type. */
  | { hasTool: string }
  /** `req.tools` contains at least one function tool. */
  | { hasFunctionTool: true }
  /** Array at `path` contains `value`. */
  | { includes: [string, Json] }
  | { not: Cond }
  | { all: Cond[] }
  | { any: Cond[] };

export interface FieldRule {
  /** Dotted path into NormalizedRequest. */
  from: string;
  /** Dotted path into the body. */
  to: string;
  /** Default when the source is absent. Emits the field even if unset. */
  default?: Json;
  /** Extra gate on top of the presence check. */
  when?: Cond;
  /** Presence test: `defined` (!== undefined) or `truthy`. Default `defined`. */
  presence?: 'defined' | 'truthy';
  /** Named value table to map the source value through. */
  table?: string;
  /** Value used when the table has no entry (rather than dropping the field). */
  tableDefault?: Json;
  /** Named transform applied to the source value. */
  call?: string;
  /** Drop the field when the table/transform yields undefined. */
}

export interface BlockRule {
  /** Documentation handle; also used in diff output. */
  name: string;
  when?: Cond;
  /** Dotted target path. Omit to merge the result into the body root. */
  to?: string;
  /** Deep-merge into whatever is already at `to` (output_config case). */
  merge?: boolean;
  /** Value template. */
  template?: Json;
  /** Named builder invoked with (req, ctx) instead of a template. */
  call?: string;
  /** Named cross-field effects run after the block is written. */
  effects?: string[];
}

export interface WireSpec {
  id: string;
  provider: string;
  api: string;
  /** Adapter flavor, for specs shared by several providers (openai|xai|openrouter). */
  flavors?: string[];
  envelope?: {
    path?: Json;
    /** Full URL template. Non-chat adapters (media, files, batch) address an
     *  absolute URL rather than a path under a shared base. */
    url?: Json;
    method?: string;
    /** `json` (default), `multipart`, or `none` for GET/DELETE with no body.
     *  Multipart matters: a FormData body JSON-stringifies to `{}`, so comparing
     *  it as JSON would pass vacuously no matter what the fields are. */
    /** `json` (default), `multipart`, `none` for a bodyless GET/DELETE, or
     *  `raw` when the body is caller-supplied BYTES the spec cannot describe —
     *  a file being streamed to an upload session. The spec still owns the URL,
     *  method and headers; only the payload comes from outside. */
    bodyKind?: 'json' | 'multipart' | 'none' | 'raw' | 'form';
    /** Headers in declaration order. An entry with `spread` merges an evaluated
     *  OBJECT of headers instead of setting one, which is what a caller-supplied
     *  header map or a resolved auth bundle is. Order is the whole point: it is
     *  what decides whether a configured `accept` overrides the default one or the
     *  other way round, and that was previously a property of which spread came
     *  later in a hand-written object literal. */
    headers?: { name?: string; value?: Json; when?: Cond; spread?: Json }[];
    /** Query parameters, appended to `url` (or `path`) in declaration order.
     *
     *  Splicing them into the URL with `$join` works only while every parameter is
     *  present: `$join` propagates an omitted part, so one absent `pageToken` takes
     *  the whole URL with it. Declaring them separately lets a parameter drop out
     *  on its own, and puts the encoding in ONE place — the hand-written adapters
     *  disagreed about whether to call `encodeURIComponent`, which is how a page
     *  token with a `+` in it silently paged from the wrong place. */
    query?: { name: string; value: Json; when?: Cond }[];
    /** How query values are escaped. `component` (default) percent-escapes
     *  everything, including a space as `%20`. `form` uses the
     *  application/x-www-form-urlencoded rules, where a space is `+` — which is
     *  what RFC 6749 prescribes for an OAuth authorization request, and what its
     *  servers are used to receiving. Both decode to the same string; they are not
     *  the same bytes, and a signature over the request would notice. */
    queryEncoding?: 'component' | 'form';
  };
  /** Model-id → variant flags. The migration target is a catalog pin; the
   *  `idMatch` form is what today's regex helpers do, expressed as data.
   *  `fn` is the escape hatch for rules a pattern cannot express (version
   *  arithmetic) — every use of it is a finding, not a feature. */
  variants?: { flag: string; idMatch?: string; fn?: string; unless?: string; note?: string }[];
  /** Value tables referenced by `table:` and `$table`. */
  tables?: Record<string, Record<string, Json>>;
  /** Fields we deliberately never send, with the reason. */
  unsupported?: { from: string; reason: string }[];
  fields?: FieldRule[];
  blocks?: BlockRule[];
  /** Multipart form fields, in order, when `envelope.bodyKind` is 'multipart'. */
  multipart?: {
    name: string;
    value?: Json;
    file?: boolean;
    when?: Cond;
    /** Emit ONE field per array element instead of a single array-valued
     *  field. Real forms use repeated keys for lists — OpenAI's transcription
     *  takes `languages[]` once per language — and a single field holding an
     *  array is a different request the server will not accept. */
    repeat?: boolean;
  }[];
  /** Non-HTTP surfaces. A realtime session is not one request: it is a
   *  connection descriptor plus a sequence of outbound frames, so those are
   *  named operations rather than a single envelope+body. */
  operations?: Record<string, OperationRule>;
  /** Per-flavor patches applied after the blocks. This mirrors what the xai and
   *  openrouter adapters already do today: call the base builder, then patch the
   *  result. Expressing it as ops keeps the shared spec authoritative. */
  overlays?: Record<string, { ops: OverlayOp[] }>;
}

export interface OverlayOp {
  op: 'rename' | 'delete' | 'set' | 'mergeFrom' | 'call';
  /** rename/delete: body path. mergeFrom: request path. */
  from?: string;
  /** rename/set: body path. */
  to?: string;
  value?: Json;
  call?: string;
  when?: Cond;
}

// ── registry ────────────────────────────────────────────────────────────────

export interface Ctx {
  req: any;
  spec: WireSpec;
  flavor: string;
  /** Adapter-level configuration (baseURL, apiKey, ...) referenced by `$config`.
   *  Keeps the URL declarative rather than pushing it into a named transform. */
  config: Record<string, unknown>;
  variants: Set<string>;
  body: Record<string, unknown>;
  /** Per-item scope while inside a $map. */
  item?: { value: any; index: number; isLast: boolean };
  /** Collected multipart fields, when the spec declares a multipart body. */
  multipart?: MultipartField[];
}

export interface MultipartField {
  name: string;
  kind: 'file' | 'value';
  value?: Json;
}

export type Transform = (value: any, ctx: Ctx) => Json;
export type Builder = (ctx: Ctx) => Json;
export type Predicate = (ctx: Ctx) => boolean;
export type Effect = (ctx: Ctx) => void;

export interface Registry {
  transforms: Record<string, Transform>;
  builders: Record<string, Builder>;
  predicates: Record<string, Predicate>;
  effects: Record<string, Effect>;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function getPath(root: any, path: string): any {
  if (!path) return root;
  let cur = root;
  for (const part of path.split('.')) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: any = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (!isObj(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]!] = value;
}

function deletePath(root: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  let cur: any = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]!];
    if (!isObj(cur)) return;
  }
  delete cur[parts[parts.length - 1]!];
}

function deepMerge(target: any, source: any): any {
  if (!isObj(target) || !isObj(source)) return source;
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(source)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

// ── condition evaluation ────────────────────────────────────────────────────

export function evalCond(cond: Cond | undefined, ctx: Ctx, reg: Registry): boolean {
  if (!cond) return true;
  const c = cond as any;
  if ('defined' in c) return getPath(ctx.req, c.defined) !== undefined;
  if ('truthy' in c) return Boolean(getPath(ctx.req, c.truthy));
  if ('eq' in c) return getPath(ctx.req, c.eq[0]) === c.eq[1];
  if ('ne' in c) return getPath(ctx.req, c.ne[0]) !== c.ne[1];
  if ('variant' in c) return ctx.variants.has(c.variant);
  if ('flavor' in c)
    return Array.isArray(c.flavor) ? c.flavor.includes(ctx.flavor) : ctx.flavor === c.flavor;
  if ('pred' in c) {
    const p = reg.predicates[c.pred];
    if (!p) throw new Error(`unknown predicate: ${c.pred}`);
    return p(ctx);
  }
  if ('itemTruthy' in c) return Boolean(getPath(ctx.item?.value, c.itemTruthy));
  if ('itemEq' in c) return ctx.item?.value === c.itemEq;
  if ('isLast' in c) return ctx.item?.isLast === true;
  if ('isFunctionTool' in c) return reg.predicates.isFunctionTool!(ctx);
  if ('builtin' in c) {
    const t = ctx.item?.value;
    return !reg.predicates.isFunctionTool!(ctx) && t?.type === c.builtin;
  }
  if ('hasTool' in c) {
    const tools = ctx.req.tools as any[] | undefined;
    return Boolean(
      tools?.some((t) => {
        const itemCtx: Ctx = { ...ctx, item: { value: t, index: 0, isLast: false } };
        return !reg.predicates.isFunctionTool!(itemCtx) && t?.type === c.hasTool;
      }),
    );
  }
  if ('hasFunctionTool' in c) {
    const tools = ctx.req.tools as any[] | undefined;
    return Boolean(
      tools?.some((t) =>
        reg.predicates.isFunctionTool!({ ...ctx, item: { value: t, index: 0, isLast: false } }),
      ),
    );
  }
  if ('includes' in c) {
    const arr = getPath(ctx.req, c.includes[0]);
    return Array.isArray(arr) && arr.includes(c.includes[1]);
  }
  if ('not' in c) return !evalCond(c.not, ctx, reg);
  if ('all' in c) return (c.all as Cond[]).every((x) => evalCond(x, ctx, reg));
  if ('any' in c) return (c.any as Cond[]).some((x) => evalCond(x, ctx, reg));
  throw new Error(`unknown condition: ${JSON.stringify(cond)}`);
}

// ── template evaluation ─────────────────────────────────────────────────────

const OMIT = Symbol('omit');

function evalTemplate(tpl: Json, ctx: Ctx, reg: Registry): Json | typeof OMIT {
  if (Array.isArray(tpl)) {
    const out: Json[] = [];
    for (const el of tpl) {
      // `$each` splices an evaluated array INTO this array — the array analogue of
      // `$spread`. Needed wherever a `$map` has to sit beside literal entries: a
      // bare `$map` there nests one level down, and a nested array is a different
      // request, not a formatting detail. (Google's `tools` is exactly that shape:
      // fixed entries for the builtins, mapped entries for the rest.)
      if (isObj(el) && '$each' in (el as Record<string, unknown>)) {
        const many = evalTemplate((el as Record<string, Json>).$each, ctx, reg);
        if (many !== OMIT && Array.isArray(many)) out.push(...many);
        continue;
      }
      const v = evalTemplate(el, ctx, reg);
      if (v !== OMIT) out.push(v);
    }
    return out;
  }
  if (!isObj(tpl)) return tpl;

  const t = tpl as Record<string, any>;

  // Conditional value: emit `$value` only when `$when` holds.
  if ('$when' in t) {
    if (!evalCond(t.$when, ctx, reg)) return OMIT;
    return '$value' in t ? evalTemplate(t.$value, ctx, reg) : OMIT;
  }
  // Read a request path (or the current $map item with a leading `@`).
  if ('$' in t) {
    const p: string = t.$;
    const raw = p.startsWith('@')
      ? getPath(ctx.item?.value, p.slice(1))
      : getPath(ctx.req, p);
    const v = raw === undefined ? ('$default' in t ? t.$default : undefined) : raw;
    return v === undefined ? OMIT : v;
  }
  // Adapter config value (baseURL, apiKey).
  if ('$config' in t) {
    const v = ctx.config[t.$config as string];
    return v === undefined ? OMIT : (v as Json);
  }
  // String built from parts; the only way to concatenate, kept deliberately dull.
  if ('$join' in t) {
    const parts = (t.$join as Json[]).map((x) => evalTemplate(x, ctx, reg));
    if (parts.some((x) => x === OMIT)) return OMIT;
    return parts.join(t.$sep === undefined ? '' : String(t.$sep));
  }
  // Table lookup keyed by a request path.
  if ('$table' in t) {
    const table = ctx.spec.tables?.[t.$table];
    if (!table) throw new Error(`unknown table: ${t.$table}`);
    const key = String(getPath(ctx.req, t.$key));
    const v = key in table ? table[key] : t.$default;
    return v === undefined ? OMIT : v;
  }
  // Named transform over the whole request (or the current item with `$arg`).
  if ('$call' in t) {
    const fn = reg.transforms[t.$call];
    if (!fn) throw new Error(`unknown transform: ${t.$call}`);
    const arg = t.$arg === undefined ? undefined : evalTemplate(t.$arg, ctx, reg);
    const v = fn(arg === OMIT ? undefined : arg, ctx);
    return v === undefined ? OMIT : v;
  }
  // Map over a request array with per-item cases.
  if ('$map' in t) {
    const found = getPath(ctx.req, t.$map);
    const arr = Array.isArray(found) ? found : (t.$mapDefault as Json[] | undefined);
    if (!Array.isArray(arr)) return OMIT;
    const out: Json[] = [];
    for (let i = 0; i < arr.length; i++) {
      const itemCtx: Ctx = { ...ctx, item: { value: arr[i], index: i, isLast: i === arr.length - 1 } };
      let matched = false;
      for (const kase of t.$case as { when?: Cond; value: Json }[]) {
        if (!evalCond(kase.when, itemCtx, reg)) continue;
        const v = evalTemplate(kase.value, itemCtx, reg);
        if (v !== OMIT) out.push(v);
        matched = true;
        break;
      }
      if (!matched && !t.$dropUnmatched) {
        throw new Error(`$map item ${i} matched no case and $dropUnmatched is not set`);
      }
    }
    return out;
  }

  // Plain object: evaluate each value, honouring `$spread` and omission.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    // Comments inside a template. Without a reserved form, a plain `note` key
    // silently ships to the provider — which it did, on the first run.
    if (k === '$note') continue;
    if (k === '$spread') {
      const src = evalTemplate(v, ctx, reg);
      if (src !== OMIT && isObj(src)) Object.assign(out, src);
      continue;
    }
    const val = evalTemplate(v, ctx, reg);
    if (val !== OMIT) out[k] = val;
  }
  return out;
}

// ── model variant resolution ────────────────────────────────────────────────

export function resolveVariants(spec: WireSpec, model: string, reg: Registry): Set<string> {
  const flags = new Set<string>();
  const id = model.toLowerCase().replace(/^[a-z]+\//, '');
  for (const v of spec.variants ?? []) {
    if (v.idMatch && new RegExp(v.idMatch).test(id)) flags.add(v.flag);
    if (v.fn) {
      const fn = reg.transforms[v.fn];
      if (!fn) throw new Error(`unknown variant fn: ${v.fn}`);
      if (fn(model, { req: { model } } as Ctx)) flags.add(v.flag);
    }
  }
  // `unless` lets a spec express "this flag applies except when that one did".
  for (const v of spec.variants ?? []) {
    if (v.unless && flags.has(v.unless)) flags.delete(v.flag);
  }
  return flags;
}

// ── the interpreter ─────────────────────────────────────────────────────────

export interface BuiltRequest {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  path?: string;
  url?: string;
  method?: string;
  /** The body is caller-supplied bytes (bodyKind 'raw'). */
  rawBody?: boolean;
  /** Present instead of a JSON body when bodyKind is 'multipart'. */
  multipart?: MultipartField[];
  /** The body is form-urlencoded: `body` holds the FIELDS, and the caller encodes
   *  them. Same split as multipart — the spec says what the form carries, the
   *  runtime does the encoding, and the frozen fixture stays readable as fields
   *  rather than as one percent-escaped string. */
  formBody?: boolean;
  /** True when the spec declares the request carries no body at all. */
  noBody?: boolean;
}

export function buildFromSpec(
  spec: WireSpec,
  req: any,
  reg: Registry,
  flavor = spec.provider,
  /** Coverage hook: called with every rule that actually fired. */
  onUse?: (kind: 'field' | 'block' | 'header' | 'variant' | 'overlay', name: string) => void,
  /** Adapter config exposed to `$config`. */
  config: Record<string, unknown> = {},
): BuiltRequest {
  const ctx: Ctx = {
    req,
    spec,
    flavor,
    config,
    variants: resolveVariants(spec, req.model ?? '', reg),
    body: {},
  };

  for (const v of ctx.variants) onUse?.('variant', v);

  // 1. fields
  for (const f of spec.fields ?? []) {
    const raw = getPath(req, f.from);
    const present = (f.presence ?? 'defined') === 'truthy' ? Boolean(raw) : raw !== undefined;
    const value = present ? raw : f.default;
    if (value === undefined) continue;
    if (!present && f.default === undefined) continue;
    if (!evalCond(f.when, ctx, reg)) continue;

    let out: Json = value;
    if (f.table) {
      const table = spec.tables?.[f.table];
      if (!table) throw new Error(`unknown table: ${f.table}`);
      out = String(value) in table ? table[String(value)] : f.tableDefault;
      if (out === undefined) continue;
    }
    if (f.call) {
      const fn = reg.transforms[f.call];
      if (!fn) throw new Error(`unknown transform: ${f.call}`);
      out = fn(value, ctx);
      if (out === undefined) continue;
    }
    setPath(ctx.body, f.to, out);
    onUse?.('field', f.to);
  }

  // 2. blocks, in declaration order (output_config merge order depends on it)
  for (const b of spec.blocks ?? []) {
    if (!evalCond(b.when, ctx, reg)) continue;
    let value: Json | typeof OMIT;
    if (b.call) {
      const fn = reg.builders[b.call];
      if (!fn) throw new Error(`unknown builder: ${b.call}`);
      value = fn(ctx);
    } else {
      value = evalTemplate(b.template, ctx, reg);
    }
    if (value === OMIT || value === undefined) continue;

    if (!b.to) {
      if (isObj(value)) Object.assign(ctx.body, value);
    } else if (b.merge) {
      const existing = getPath(ctx.body, b.to);
      setPath(ctx.body, b.to, deepMerge(existing ?? {}, value));
    } else {
      setPath(ctx.body, b.to, value);
    }

    onUse?.('block', b.name);

    for (const e of b.effects ?? []) {
      const fn = reg.effects[e];
      if (!fn) throw new Error(`unknown effect: ${e}`);
      fn(ctx);
    }
  }

  // 2b. multipart body, described as fields rather than a blob
  if (spec.envelope?.bodyKind === 'multipart') {
    const fields: MultipartField[] = [];
    for (const f of spec.multipart ?? []) {
      if (!evalCond(f.when, ctx, reg)) continue;
      if (f.file) {
        fields.push({ name: f.name, kind: 'file' });
      } else {
        const v = evalTemplate(f.value, ctx, reg);
        if (v === OMIT || v === undefined) {
          // nothing to append
        } else if (f.repeat && Array.isArray(v)) {
          for (const item of v) fields.push({ name: f.name, kind: 'value', value: item as Json });
        } else {
          fields.push({ name: f.name, kind: 'value', value: v });
        }
      }
      onUse?.('block', `multipart:${f.name}`);
    }
    ctx.multipart = fields;
  }

  // 3. per-flavor overlay
  for (const op of spec.overlays?.[flavor]?.ops ?? []) {
    if (!evalCond(op.when, ctx, reg)) continue;
    onUse?.('overlay', `${flavor}:${op.op}:${op.from ?? op.to ?? op.call}`);
    if (op.op === 'rename') {
      const v = getPath(ctx.body, op.from!);
      if (v) {
        setPath(ctx.body, op.to!, v);
        deletePath(ctx.body, op.from!);
      }
    } else if (op.op === 'delete') {
      deletePath(ctx.body, op.from!);
    } else if (op.op === 'set') {
      const v = evalTemplate(op.value, ctx, reg);
      if (v !== OMIT) setPath(ctx.body, op.to!, v);
    } else if (op.op === 'mergeFrom') {
      const src = getPath(ctx.req, op.from!);
      if (isObj(src)) Object.assign(ctx.body, src);
    } else if (op.op === 'call') {
      const fn = reg.effects[op.call!];
      if (!fn) throw new Error(`unknown overlay effect: ${op.call}`);
      fn(ctx);
    }
  }

  // 4. envelope
  const out: BuiltRequest = { body: ctx.body };
  if (ctx.multipart) out.multipart = ctx.multipart;
  if (spec.envelope?.bodyKind === 'none') out.noBody = true;
  // `raw`: the caller attaches the bytes; say so rather than emitting an empty body.
  if (spec.envelope?.bodyKind === 'raw') out.rawBody = true;
  if (spec.envelope?.bodyKind === 'form') out.formBody = true;
  const headers: Record<string, string> = {};
  for (const h of spec.envelope?.headers ?? []) {
    if (!evalCond(h.when, ctx, reg)) continue;
    if (h.spread !== undefined) {
      const many = evalTemplate(h.spread, ctx, reg);
      if (many !== OMIT && isObj(many)) {
        for (const [k, v] of Object.entries(many)) {
          if (v === undefined || v === null) continue;
          headers[k] = String(v);
          onUse?.('header', k);
        }
      }
      continue;
    }
    if (h.name === undefined) throw new Error(`${spec.id}: a header needs either a name or a spread`);
    const v = evalTemplate(h.value, ctx, reg);
    if (v !== OMIT && v !== undefined) {
      headers[h.name] = String(v);
      onUse?.('header', h.name);
    }
  }
  if (spec.envelope?.headers) out.headers = headers;
  if (spec.envelope?.method) out.method = spec.envelope.method;
  if (spec.envelope?.url !== undefined) {
    const u = evalTemplate(spec.envelope.url, ctx, reg);
    if (u !== OMIT && u !== undefined) out.url = String(u);
  }
  if (spec.envelope?.path !== undefined) {
    const p = evalTemplate(spec.envelope.path, ctx, reg);
    if (p !== OMIT && p !== undefined) out.path = String(p);
  }

  // 5. query parameters, each able to drop out on its own.
  const params: string[] = [];
  for (const q of spec.envelope?.query ?? []) {
    if (!evalCond(q.when, ctx, reg)) continue;
    const v = evalTemplate(q.value, ctx, reg);
    if (v === OMIT || v === undefined) continue;
    const esc =
      spec.envelope?.queryEncoding === 'form'
        ? (x: string) => new URLSearchParams({ x }).toString().slice(2)
        : encodeURIComponent;
    params.push(`${esc(q.name)}=${esc(String(v))}`);
    onUse?.('header', `query:${q.name}`);
  }
  if (params.length) {
    const target = out.url !== undefined ? 'url' : 'path';
    const base = out[target];
    if (base === undefined) throw new Error(`${spec.id}: query parameters with no url or path to attach to`);
    out[target] = `${base}${base.includes('?') ? '&' : '?'}${params.join('&')}`;
  }
  return out;
}


// ── operations (non-HTTP surfaces) ──────────────────────────────────────────

export interface OperationRule {
  /** Connection descriptor (realtime `connect`). */
  url?: Json;
  protocols?: Json;
  /** Outbound frames, in order. A frame whose template evaluates away is skipped. */
  frames?: { name?: string; when?: Cond; template: Json }[];
}

export interface BuiltConnection {
  url: string;
  protocols?: string[];
}

function opCtx(spec: WireSpec, input: any, config: Record<string, unknown>): Ctx {
  return { req: input, spec, flavor: spec.provider, config, variants: new Set(), body: {} };
}

/** Build the connection descriptor for an operation (realtime `connect`). */
export function buildConnection(
  spec: WireSpec,
  operation: string,
  input: any,
  reg: Registry,
  config: Record<string, unknown> = {},
): BuiltConnection {
  const op = spec.operations?.[operation];
  if (!op) throw new Error(`spec ${spec.id} has no operation "${operation}"`);
  const ctx = opCtx(spec, input, config);
  const url = evalTemplate(op.url, ctx, reg);
  if (url === OMIT || url === undefined) throw new Error(`operation "${operation}" produced no url`);
  const out: BuiltConnection = { url: String(url) };
  if (op.protocols !== undefined) {
    const p = evalTemplate(op.protocols, ctx, reg);
    if (p !== OMIT && Array.isArray(p)) out.protocols = p.map(String);
  }
  return out;
}

/** Build the outbound frames for an operation (realtime `open` / `send`). */
export function buildFrames(
  spec: WireSpec,
  operation: string,
  input: any,
  reg: Registry,
  config: Record<string, unknown> = {},
): Json[] {
  const op = spec.operations?.[operation];
  if (!op) throw new Error(`spec ${spec.id} has no operation "${operation}"`);
  const ctx = opCtx(spec, input, config);
  const out: Json[] = [];
  for (const f of op.frames ?? []) {
    if (!evalCond(f.when, ctx, reg)) continue;
    const v = evalTemplate(f.template, ctx, reg);
    if (v !== OMIT && v !== undefined) out.push(v);
  }
  return out;
}
