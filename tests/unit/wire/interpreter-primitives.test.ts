/** Wire-interpreter primitives, driven by hand-written minimal specs.
 *
 *  The differential suite proves the SHIPPED specs reproduce the shipped
 *  adapters. It cannot reach an interpreter feature no current spec happens to
 *  use — and a port reimplementing the interpreter has to get those right too,
 *  or the first spec that uses one silently builds the wrong request. These are
 *  the interpreter's own semantics, stated on their own.
 */

import { describe, expect, it } from 'bun:test';
import {
  buildFromSpec,
  resolveVariants,
  type Registry,
  type WireSpec,
} from '../../../src/wire/interpreter';
import { getWireSpec, WIRE_SPECS } from '../../../src/wire/registry';
import { specForModel } from '../../../src/wire/inherit';
import { mediaSpec } from '../../../src/wire/media-specs';
import { serviceSpec } from '../../../src/wire/service-specs';

const emptyReg = (): Registry => ({ transforms: {}, builders: {}, predicates: {}, effects: {} });

const base = (over: Partial<WireSpec> = {}): WireSpec =>
  ({
    id: 'test/spec',
    provider: 'test',
    api: 'chat',
    envelope: { method: 'POST', path: '/v1/x' },
    ...over,
  }) as WireSpec;

// ─── variants ───────────────────────────────────────────────────────────────

describe('resolveVariants', () => {
  it('idMatch is applied to the model id with any provider prefix stripped', () => {
    const spec = base({ variants: [{ flag: 'thinking', idMatch: '^claude-opus' }] });
    expect([...resolveVariants(spec, 'anthropic/claude-opus-5', emptyReg())]).toEqual(['thinking']);
    expect([...resolveVariants(spec, 'claude-opus-5', emptyReg())]).toEqual(['thinking']);
    expect([...resolveVariants(spec, 'claude-haiku-5', emptyReg())]).toEqual([]);
  });

  it('idMatch is case-insensitive because the id is lowercased first', () => {
    const spec = base({ variants: [{ flag: 'f', idMatch: 'grok' }] });
    expect(resolveVariants(spec, 'GROK-4', emptyReg()).has('f')).toBe(true);
  });

  it('a `fn` variant is resolved through the registry and receives the ORIGINAL model id', () => {
    const seen: string[] = [];
    const reg = emptyReg();
    reg.transforms.isBig = ((model: string) => {
      seen.push(model);
      return model.includes('opus');
    }) as never;
    const spec = base({ variants: [{ flag: 'big', fn: 'isBig' }] });
    expect(resolveVariants(spec, 'anthropic/claude-opus-5', reg).has('big')).toBe(true);
    // Not the lowercased/stripped id — the fn gets what the caller passed.
    expect(seen).toEqual(['anthropic/claude-opus-5']);
    expect(resolveVariants(spec, 'claude-haiku-5', reg).has('big')).toBe(false);
  });

  it('an unknown `fn` is named in the error rather than silently skipped', () => {
    const spec = base({ variants: [{ flag: 'big', fn: 'nope' }] });
    expect(() => resolveVariants(spec, 'm', emptyReg())).toThrow('unknown variant fn: nope');
  });

  it('`unless` removes a flag when the named flag also matched', () => {
    const spec = base({
      variants: [
        { flag: 'legacy', idMatch: '^gpt' },
        { flag: 'modern', idMatch: '^gpt-5' },
        // legacy applies to every gpt EXCEPT where modern matched
        { flag: 'legacy', unless: 'modern' },
      ],
    });
    expect([...resolveVariants(spec, 'gpt-4o', emptyReg())]).toEqual(['legacy']);
    expect([...resolveVariants(spec, 'gpt-5.4', emptyReg())]).toEqual(['modern']);
  });

  it('`unless` naming a flag that did not match leaves the flag alone', () => {
    const spec = base({
      variants: [
        { flag: 'a', idMatch: '.' },
        { flag: 'a', unless: 'never-set' },
      ],
    });
    expect([...resolveVariants(spec, 'm', emptyReg())]).toEqual(['a']);
  });

  it('a spec with no variants resolves to no flags', () => {
    expect([...resolveVariants(base(), 'm', emptyReg())]).toEqual([]);
  });
});

// ─── $map ───────────────────────────────────────────────────────────────────

describe('$map templates', () => {
  const mapSpec = (dropUnmatched?: boolean): WireSpec =>
    base({
      blocks: [
        {
          name: 'items',
          to: 'items',
          template: {
            $map: 'things',
            ...(dropUnmatched ? { $dropUnmatched: true } : {}),
            $case: [
              { when: { itemEq: 'a' }, value: { tag: 'A' } },
              { when: { itemEq: 'b' }, value: { tag: 'B' } },
            ],
          },
        },
      ],
    } as unknown as Partial<WireSpec>);

  it('each item takes the first matching case', () => {
    const built = buildFromSpec(mapSpec(), { things: ['a', 'b'] }, emptyReg());
    expect(built.body.items).toEqual([{ tag: 'A' }, { tag: 'B' }]);
  });

  it('an item matching NO case throws, naming its index', () => {
    // Silence here would drop one message out of a conversation and the request
    // would still be well-formed — the worst possible failure mode.
    expect(() => buildFromSpec(mapSpec(), { things: ['a', 'zzz'] }, emptyReg())).toThrow(
      '$map item 1 matched no case and $dropUnmatched is not set',
    );
  });

  it('$dropUnmatched makes skipping an item explicit and allowed', () => {
    const built = buildFromSpec(mapSpec(true), { things: ['a', 'zzz', 'b'] }, emptyReg());
    expect(built.body.items).toEqual([{ tag: 'A' }, { tag: 'B' }]);
  });

  it('a missing source array omits the field entirely', () => {
    expect(buildFromSpec(mapSpec(), {}, emptyReg()).body.items).toBeUndefined();
  });
});

// ─── overlay ops ────────────────────────────────────────────────────────────

describe('overlay ops', () => {
  const withOverlay = (ops: unknown[]): WireSpec =>
    base({
      blocks: [{ name: 'seed', to: 'nested.value', template: { $: 'seed' } }],
      overlays: { test: { ops } },
    } as unknown as Partial<WireSpec>);

  it('`set` writes an evaluated template at a body path', () => {
    const built = buildFromSpec(
      withOverlay([{ op: 'set', to: 'extra.flag', value: { $: 'seed' } }]),
      { seed: 'v' },
      emptyReg(),
    );
    expect(built.body.extra).toEqual({ flag: 'v' });
  });

  it('`set` skips writing when the template omits', () => {
    const built = buildFromSpec(
      withOverlay([{ op: 'set', to: 'extra.flag', value: { $: 'absent' } }]),
      { seed: 'v' },
      emptyReg(),
    );
    expect(built.body.extra).toBeUndefined();
  });

  it('`set` honours its `when` guard', () => {
    const spec = withOverlay([
      { op: 'set', to: 'x', value: 1, when: { eq: ['seed', 'yes'] } },
    ]);
    expect(buildFromSpec(spec, { seed: 'yes' }, emptyReg()).body.x).toBe(1);
    expect(buildFromSpec(spec, { seed: 'no' }, emptyReg()).body.x).toBeUndefined();
  });

  it('`delete` down a path that does not exist is a no-op, not a crash', () => {
    // `nested` is a string here, so walking into `nested.deeper` hits a non-object
    // mid-path. Throwing would make an overlay unusable on any optional field.
    const spec = base({
      blocks: [{ name: 'seed', to: 'nested', template: 'a plain string' }],
      overlays: { test: { ops: [{ op: 'delete', from: 'nested.deeper.leaf' }] } },
    } as unknown as Partial<WireSpec>);
    const built = buildFromSpec(spec, {}, emptyReg());
    expect(built.body.nested).toBe('a plain string');
  });

  it('`delete` on a path that never existed at all is also a no-op', () => {
    const spec = base({
      overlays: { test: { ops: [{ op: 'delete', from: 'never.here' }] } },
    } as unknown as Partial<WireSpec>);
    expect(() => buildFromSpec(spec, {}, emptyReg())).not.toThrow();
  });

  it('`delete` removes a real nested leaf', () => {
    const spec = base({
      blocks: [{ name: 'seed', to: 'a.b', template: 1 }],
      overlays: { test: { ops: [{ op: 'delete', from: 'a.b' }] } },
    } as unknown as Partial<WireSpec>);
    expect(buildFromSpec(spec, {}, emptyReg()).body).toEqual({ a: {} });
  });

  it('an unknown `call` effect is named in the error', () => {
    const spec = base({
      overlays: { test: { ops: [{ op: 'call', call: 'nope' }] } },
    } as unknown as Partial<WireSpec>);
    expect(() => buildFromSpec(spec, {}, emptyReg())).toThrow('unknown overlay effect: nope');
  });
});

// ─── spec lookup ────────────────────────────────────────────────────────────

describe('spec lookup', () => {
  it('getWireSpec returns a registered delta and names an unknown id', () => {
    const known = [...WIRE_SPECS.keys()][0]!;
    expect(getWireSpec(known).id).toBe(known);
    expect(() => getWireSpec('provider/does-not-exist')).toThrow(
      'unknown wire spec: provider/does-not-exist',
    );
  });

  it('a BASE spec is refused rather than built from', () => {
    // A base spec has no endpoint of its own; building one would produce a
    // request addressed at nothing.
    expect(() => serviceSpec('anthropic/files.base')).toThrow(
      'anthropic/files.base is a base spec and cannot build a request on its own',
    );
    expect(() => mediaSpec('openai/media.base')).toThrow(
      'is a base spec and cannot build a request on its own',
    );
  });

  it('specForModel returns the pinned spec, else the default', () => {
    const pins = { default: 'p/base', models: { 'model-a': 'p/a' } };
    expect(specForModel('model-a', pins)).toBe('p/a');
    expect(specForModel('model-unknown', pins)).toBe('p/base');
  });
});
