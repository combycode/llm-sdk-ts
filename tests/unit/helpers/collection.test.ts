/** createCollection — typed namespace over engine.persistence. */

import { beforeEach, describe, expect, it } from 'bun:test';
import { createCollection } from '../../../src/helpers/collection';
import { coreRegistry, createEngine } from '../../../src/helpers/engine';

interface Item {
  name: string;
  value: number;
}

describe('createCollection', () => {
  beforeEach(() => {
    coreRegistry.clear();
    createEngine();
  });

  it('round-trips an object value', async () => {
    const items = createCollection<Item>('items');
    await items.set('one', { name: 'one', value: 1 });
    expect(await items.get('one')).toEqual({ name: 'one', value: 1 });
    expect(await items.has('one')).toBe(true);
  });

  it('returns null for missing keys', async () => {
    const items = createCollection<Item>('items');
    expect(await items.get('missing')).toBeNull();
    expect(await items.has('missing')).toBe(false);
  });

  it('list / keys / entries skip the prefix', async () => {
    const items = createCollection<Item>('items');
    await items.set('a', { name: 'a', value: 1 });
    await items.set('b', { name: 'b', value: 2 });

    const keys = (await items.keys()).sort();
    expect(keys).toEqual(['a', 'b']);

    const list = (await items.list()).sort((x, y) => x.value - y.value);
    expect(list).toEqual([
      { name: 'a', value: 1 },
      { name: 'b', value: 2 },
    ]);

    const entries = (await items.entries()).sort((x, y) => x[0].localeCompare(y[0]));
    expect(entries).toEqual([
      ['a', { name: 'a', value: 1 }],
      ['b', { name: 'b', value: 2 }],
    ]);
  });

  it('delete removes a key', async () => {
    const items = createCollection<Item>('items');
    await items.set('a', { name: 'a', value: 1 });
    await items.delete('a');
    expect(await items.has('a')).toBe(false);
  });

  it('different namespaces do not collide', async () => {
    const a = createCollection<Item>('alpha');
    const b = createCollection<Item>('beta');
    await a.set('x', { name: 'a', value: 1 });
    await b.set('x', { name: 'b', value: 2 });
    expect(await a.get('x')).toEqual({ name: 'a', value: 1 });
    expect(await b.get('x')).toEqual({ name: 'b', value: 2 });
  });

  it('rejects names with "/"', () => {
    expect(() => createCollection('bad/name')).toThrow(/without "\/"/);
  });

  it('rejects empty name', () => {
    expect(() => createCollection('')).toThrow();
  });
});
