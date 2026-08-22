/** Spec inheritance: a spec version extends the previous one and overrides only
 *  what changed.
 *
 *  This replaces the `variants` section. Instead of asking "which shape does this
 *  model id take?" at request time — which needed version arithmetic, and which
 *  is currently WRONG for `claude-opus-4-20250514` (the date suffix parses as the
 *  minor version, so a 4.0 model resolves to the 4.6+ shape) — the catalog pins a
 *  model to a spec id, and the spec chain carries the differences as deltas.
 *
 *  Merge rules, in one sentence each:
 *    - `fields`  are keyed by `to`   — child replaces, `remove:true` deletes, new ones append
 *    - `blocks`  are keyed by `name` — same, with `before`/`after` for explicit placement
 *    - `tables`  merge per table, per key
 *    - `overlays`/`envelope.headers` are keyed and replaced
 *    - everything scalar: child wins
 *
 *  Block ORDER is load-bearing (proved by the mutation suite), so appended blocks
 *  land at the end unless the delta says otherwise.
 */
import type { BlockRule, FieldRule, WireSpec } from './interpreter';

export interface Deltas {
  extends?: string;
  /** Rules to delete from the inherited spec. */
  removeFields?: string[];
  removeBlocks?: string[];
  /** Explicit placement for an appended block. */
  placeBlocks?: Record<string, { before?: string; after?: string }>;
}

export type SpecDelta = Partial<WireSpec> & Deltas & { id: string };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function mergeKeyed<T>(base: T[], child: T[] | undefined, keyOf: (v: T) => string): T[] {
  const out = [...base];
  for (const c of child ?? []) {
    const i = out.findIndex((b) => keyOf(b) === keyOf(c));
    if (i >= 0) out[i] = c;
    else out.push(c);
  }
  return out;
}

function place<T>(list: T[], keyOf: (v: T) => string, placements: Deltas['placeBlocks']): T[] {
  if (!placements) return list;
  const out = [...list];
  for (const [name, where] of Object.entries(placements)) {
    const i = out.findIndex((b) => keyOf(b) === name);
    if (i < 0) throw new Error(`placeBlocks names an unknown block: ${name}`);
    const [item] = out.splice(i, 1);
    const anchor = where.before ?? where.after;
    const j = out.findIndex((b) => keyOf(b) === anchor);
    if (j < 0) throw new Error(`placeBlocks anchor not found: ${anchor}`);
    out.splice(where.before ? j : j + 1, 0, item!);
  }
  return out;
}

/** Apply one delta to a resolved spec. This is the whole of composition, and it
 *  is deliberately shared: a CHAIN picks the delta sequence by walking parents, a
 *  MATRIX picks it by selecting features. Behind the resolver they are the same
 *  operation — see `compose.ts`. */
export function applyDelta(base: WireSpec, delta: SpecDelta): WireSpec {
  const out = clone(base);
  if (delta.id) out.id = delta.id;

  // Every key the delta sets that has no special merge rule is copied straight
  // through. Enumerating them by hand dropped `url`, `method`, `bodyKind` and
  // then `multipart` in turn — four instances of one mistake — so the list is
  // now of what is SPECIAL, not of what is carried.
  const SPECIAL = new Set([
    'id', 'extends', 'tables', 'fields', 'blocks', 'unsupported', 'envelope', 'overlays',
    'removeFields', 'removeBlocks', 'placeBlocks',
    'provides', 'order', 'requires', 'note', '_note',
  ]);
  for (const [k, v] of Object.entries(delta)) {
    if (SPECIAL.has(k) || v === undefined) continue;
    (out as any)[k] = clone(v);
  }

  if (delta.tables) {
    out.tables = { ...(out.tables ?? {}) };
    for (const [name, table] of Object.entries(delta.tables)) {
      out.tables[name] = { ...(out.tables[name] ?? {}), ...table };
    }
  }

  out.fields = mergeKeyed<FieldRule>(out.fields ?? [], delta.fields, (f) => f.to);
  if (delta.removeFields?.length) {
    out.fields = out.fields.filter((f) => !delta.removeFields!.includes(f.to));
  }

  out.blocks = mergeKeyed<BlockRule>(out.blocks ?? [], delta.blocks, (b) => b.name);
  if (delta.removeBlocks?.length) {
    out.blocks = out.blocks.filter((b) => !delta.removeBlocks!.includes(b.name));
  }
  out.blocks = place(out.blocks, (b) => b.name, delta.placeBlocks);

  if (delta.unsupported) out.unsupported = [...(out.unsupported ?? []), ...delta.unsupported];

  if (delta.envelope) {
    // Copy EVERY envelope key generically. Enumerating them by hand dropped
    // `url` and `method` (found by google/veo) and then `bodyKind` (found by the
    // files uploads) — three instances of the same mistake, so the enumeration
    // itself was the bug. Headers still merge by name rather than replace.
    const { headers: deltaHeaders, ...rest } = delta.envelope;
    out.envelope = { ...(out.envelope ?? {}), ...clone(rest) };
    if (deltaHeaders) {
      out.envelope.headers = mergeKeyed(out.envelope.headers ?? [], deltaHeaders, (h) => h.name);
    }
  }

  if (delta.overlays) out.overlays = { ...(out.overlays ?? {}), ...clone(delta.overlays) };

  // A resolved spec must not carry variants: the whole point is that the pin
  // already decided which version applies.
  delete (out as any).variants;
  return out;
}

/** Resolve a spec id to its fully flattened form by walking `extends`. */
export function resolveSpec(id: string, byId: Map<string, SpecDelta>, seen = new Set<string>()): WireSpec {
  if (seen.has(id)) throw new Error(`cycle in spec inheritance at ${id}`);
  seen.add(id);
  const delta = byId.get(id);
  if (!delta) throw new Error(`unknown spec: ${id}`);
  if (!delta.extends) return clone(delta) as WireSpec;
  return applyDelta(resolveSpec(delta.extends, byId, seen), delta);
}

/** Catalog pin: model id -> spec id. `default` is what an unknown model gets. */
export interface PinTable {
  default: string;
  models: Record<string, string>;
}

export function specForModel(model: string, pins: PinTable): string {
  return pins.models[model] ?? pins.default;
}
