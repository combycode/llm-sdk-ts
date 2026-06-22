import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryPersistence } from '../../../../src/plugins/persistence/memory';

describe('MemoryPersistence', () => {
  let store: MemoryPersistence;

  beforeEach(() => {
    store = new MemoryPersistence();
  });

  describe('basic ops', () => {
    it('returns null for missing key', async () => {
      expect(await store.get<unknown>('missing')).toBeNull();
      expect(await store.has('missing')).toBe(false);
    });

    it('round-trips a value', async () => {
      await store.set('a', { value: 1 });
      const out = await store.get<{ value: number }>('a');
      expect(out).toEqual({ value: 1 });
      expect(await store.has('a')).toBe(true);
    });

    it('overwrites existing key', async () => {
      await store.set('a', 1);
      await store.set('a', 2);
      expect(await store.get<number>('a')).toBe(2);
    });

    it('delete removes key', async () => {
      await store.set('a', 1);
      await store.delete('a');
      expect(await store.has('a')).toBe(false);
      expect(await store.get<unknown>('a')).toBeNull();
    });

    it('delete on missing key is no-op', async () => {
      await store.delete('missing');
      expect(store.size).toBe(0);
    });
  });

  describe('list', () => {
    it('returns empty list when store is empty', async () => {
      expect(await store.list()).toEqual([]);
    });

    it('returns all keys when no prefix supplied', async () => {
      await store.set('a', 1);
      await store.set('b', 2);
      await store.set('c', 3);
      const keys = await store.list();
      expect(keys.sort()).toEqual(['a', 'b', 'c']);
    });

    it('filters by prefix', async () => {
      await store.set('user:1', 'a');
      await store.set('user:2', 'b');
      await store.set('group:1', 'c');
      const keys = await store.list('user:');
      expect(keys.sort()).toEqual(['user:1', 'user:2']);
    });
  });

  describe('isolation', () => {
    it('mutating retrieved object does not affect stored copy', async () => {
      const obj = { count: 1 };
      await store.set('o', obj);
      const got = (await store.get<{ count: number }>('o'))!;
      got.count = 99;
      const fresh = await store.get<{ count: number }>('o');
      expect(fresh).toEqual({ count: 1 });
    });

    it('mutating original after set does not affect stored copy', async () => {
      const obj = { count: 1 };
      await store.set('o', obj);
      obj.count = 99;
      const fresh = await store.get<{ count: number }>('o');
      expect(fresh).toEqual({ count: 1 });
    });
  });

  describe('size + clear', () => {
    it('size reflects entry count', async () => {
      expect(store.size).toBe(0);
      await store.set('a', 1);
      await store.set('b', 2);
      expect(store.size).toBe(2);
      await store.delete('a');
      expect(store.size).toBe(1);
    });

    it('clear removes everything', async () => {
      await store.set('a', 1);
      await store.set('b', 2);
      store.clear();
      expect(store.size).toBe(0);
      expect(await store.list()).toEqual([]);
    });
  });
});
