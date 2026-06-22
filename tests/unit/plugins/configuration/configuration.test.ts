import { beforeEach, describe, expect, it } from 'bun:test';
import { ConfigurationPlugin } from '../../../../src/plugins/configuration/configuration';
import { MemoryPersistence } from '../../../../src/plugins/persistence/memory';

describe('ConfigurationPlugin — set/get/has/delete', () => {
  let cfg: ConfigurationPlugin;

  beforeEach(() => {
    cfg = new ConfigurationPlugin();
  });

  it('returns null for unknown name', () => {
    expect(cfg.get('missing')).toBeNull();
    expect(cfg.has('missing')).toBe(false);
  });

  it('stores and retrieves a settings bundle', () => {
    cfg.set('anthropic/default', { rateLimit: { rpm: 50, tpm: 80_000 } });
    const got = cfg.get('anthropic/default');
    expect(got).toEqual({ rateLimit: { rpm: 50, tpm: 80_000 } });
    expect(cfg.has('anthropic/default')).toBe(true);
  });

  it('overwrites on second set', () => {
    cfg.set('a', { x: 1 });
    cfg.set('a', { y: 2 });
    expect(cfg.get('a')).toEqual({ y: 2 });
  });

  it('throws on empty name', () => {
    expect(() => cfg.set('', { x: 1 })).toThrow();
  });

  it('delete removes the entry', () => {
    cfg.set('a', { x: 1 });
    cfg.delete('a');
    expect(cfg.has('a')).toBe(false);
    expect(cfg.get('a')).toBeNull();
  });

  it('returned entry is frozen (mutation does not bleed back)', () => {
    cfg.set('a', { rateLimit: { rpm: 10 } });
    const got = cfg.get('a') as { rateLimit: { rpm: number } };
    expect(() => {
      got.rateLimit.rpm = 9999;
    }).toThrow();
    expect((cfg.get('a') as { rateLimit: { rpm: number } }).rateLimit.rpm).toBe(10);
  });

  it('input mutation after set does not bleed in (defensive copy)', () => {
    const input: { rateLimit: { rpm: number } } = { rateLimit: { rpm: 10 } };
    cfg.set('a', input);
    input.rateLimit.rpm = 9999;
    expect((cfg.get('a') as { rateLimit: { rpm: number } }).rateLimit.rpm).toBe(10);
  });
});

describe('ConfigurationPlugin — extend (parent chain)', () => {
  it('child inherits base settings', () => {
    const cfg = new ConfigurationPlugin();
    cfg.set('anthropic/default', {
      rateLimit: { rpm: 50, tpm: 80_000 },
      retry: { maxRetries: 2 },
    });
    cfg.extend('anthropic/default', 'anthropic/tier1', {
      rateLimit: { rpm: 1000 },
    });
    const got = cfg.get('anthropic/tier1');
    expect(got).toEqual({
      rateLimit: { rpm: 1000 },
      retry: { maxRetries: 2 },
    });
  });

  it('chain depth >1 — grandchild inherits both', () => {
    const cfg = new ConfigurationPlugin();
    cfg.set('a', { foo: 1, bar: 1, baz: 1 });
    cfg.extend('a', 'b', { bar: 2 });
    cfg.extend('b', 'c', { baz: 3 });
    expect(cfg.get('c')).toEqual({ foo: 1, bar: 2, baz: 3 });
  });

  it('extend on unknown base throws', () => {
    const cfg = new ConfigurationPlugin();
    expect(() => cfg.extend('nope', 'x', {})).toThrow();
  });

  it('cycle detection: A→B→A does not loop infinitely', () => {
    const cfg = new ConfigurationPlugin();
    cfg.set('A', { a: 1 });
    cfg.extend('A', 'B', { b: 2 });
    // Force a cycle (only possible by reaching into internals — but the
    // resolver must be cycle-tolerant anyway).
    (cfg as unknown as { parents: Map<string, string> }).parents.set('A', 'B');
    const got = cfg.get('B');
    expect(got).toBeDefined();
    // Won't infinite-loop, returns merged data.
  });

  it('breaks gracefully when base is later deleted', () => {
    const cfg = new ConfigurationPlugin();
    cfg.set('a', { x: 1 });
    cfg.extend('a', 'b', { y: 2 });
    cfg.delete('a');
    // Only 'b' overrides remain — chain to deleted parent.
    expect(cfg.get('b')).toEqual({ y: 2 });
  });
});

describe('ConfigurationPlugin — names() + initial', () => {
  it('seeded entries appear in names()', () => {
    const cfg = new ConfigurationPlugin({
      initial: {
        'a/default': { rpm: 1 },
        'b/default': { rpm: 2 },
      },
    });
    expect(cfg.names().sort()).toEqual(['a/default', 'b/default']);
    expect(cfg.get('a/default')).toEqual({ rpm: 1 });
  });
});

describe('ConfigurationPlugin — serialize / deserialize', () => {
  it('round-trips entries and parents', () => {
    const cfg = new ConfigurationPlugin();
    cfg.set('a', { x: 1 });
    cfg.extend('a', 'b', { y: 2 });

    const snapshot = cfg.serialize();
    expect(snapshot.version).toBe(1);
    expect(snapshot.entries).toEqual({ a: { x: 1 }, b: { y: 2 } });
    expect(snapshot.parents).toEqual({ b: 'a' });

    const cfg2 = new ConfigurationPlugin();
    cfg2.deserialize(snapshot);
    expect(cfg2.get('b')).toEqual({ x: 1, y: 2 });
  });

  it('deserialize replaces existing data', () => {
    const cfg = new ConfigurationPlugin();
    cfg.set('old', { a: 1 });
    cfg.deserialize({ version: 1, entries: { fresh: { z: 9 } }, parents: {} });
    expect(cfg.has('old')).toBe(false);
    expect(cfg.get('fresh')).toEqual({ z: 9 });
  });

  it('rejects unknown version', () => {
    const cfg = new ConfigurationPlugin();
    expect(() =>
      cfg.deserialize({
        version: 999 as unknown as 1,
        entries: {},
        parents: {},
      }),
    ).toThrow();
  });
});

describe('ConfigurationPlugin — load / save with Persistence', () => {
  it('save+load round-trip via MemoryPersistence', async () => {
    const persistence = new MemoryPersistence();
    const cfg = new ConfigurationPlugin({ persistence });
    cfg.set('a', { rpm: 50 });
    cfg.extend('a', 'b', { rpm: 100 });
    await cfg.save();

    const cfg2 = new ConfigurationPlugin({ persistence });
    const loaded = await cfg2.load();
    expect(loaded).toBe(true);
    expect(cfg2.get('b')).toEqual({ rpm: 100 });
  });

  it('load returns false when storage is empty', async () => {
    const persistence = new MemoryPersistence();
    const cfg = new ConfigurationPlugin({ persistence });
    expect(await cfg.load()).toBe(false);
  });

  it('save throws when no persistence attached', async () => {
    const cfg = new ConfigurationPlugin();
    await expect(cfg.save()).rejects.toThrow();
  });

  it('load is no-op when no persistence attached', async () => {
    const cfg = new ConfigurationPlugin();
    expect(await cfg.load()).toBe(false);
  });

  it('respects custom storageKey', async () => {
    const persistence = new MemoryPersistence();
    const cfg = new ConfigurationPlugin({ persistence, storageKey: 'cfg/main' });
    cfg.set('x', { a: 1 });
    await cfg.save();
    expect(await persistence.has('cfg/main')).toBe(true);
    expect(await persistence.has('__configurations')).toBe(false);
  });
});
