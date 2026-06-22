import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePersistence } from '../../../../src/plugins/persistence/file';

describe('FilePersistence', () => {
  let dir: string;
  let store: FilePersistence;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orxa-fp-'));
    store = new FilePersistence({ dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('basic ops', () => {
    it('returns null for missing key', async () => {
      expect(await store.get<unknown>('missing')).toBeNull();
      expect(await store.has('missing')).toBe(false);
    });

    it('round-trips a value', async () => {
      await store.set('a', { value: 1, nested: { ok: true } });
      const out = await store.get<{ value: number; nested: { ok: boolean } }>('a');
      expect(out).toEqual({ value: 1, nested: { ok: true } });
      expect(await store.has('a')).toBe(true);
    });

    it('survives a fresh instance pointed at the same dir', async () => {
      await store.set('a', 'hello');
      const store2 = new FilePersistence({ dir });
      expect(await store2.get<string>('a')).toBe('hello');
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
    });

    it('delete on missing key is no-op', async () => {
      await store.delete('nope');
      // No throw.
    });
  });

  describe('key encoding', () => {
    it('round-trips keys with special chars', async () => {
      const tricky = 'user:42/conv id with spaces';
      await store.set(tricky, 'data');
      expect(await store.has(tricky)).toBe(true);
      expect(await store.get<string>(tricky)).toBe('data');
    });

    it('list returns decoded keys (not encoded filenames)', async () => {
      await store.set('user:1', 'a');
      await store.set('group/admin', 'b');
      const keys = await store.list();
      expect(keys.sort()).toEqual(['group/admin', 'user:1']);
    });
  });

  describe('list', () => {
    it('returns empty list for empty dir', async () => {
      expect(await store.list()).toEqual([]);
    });

    it('filters by prefix', async () => {
      await store.set('user:1', 1);
      await store.set('user:2', 2);
      await store.set('cfg:a', 'a');
      const keys = await store.list('user:');
      expect(keys.sort()).toEqual(['user:1', 'user:2']);
    });
  });

  describe('constructor signatures', () => {
    it('accepts a plain string for dir', async () => {
      const dir2 = mkdtempSync(join(tmpdir(), 'orxa-fp-str-'));
      try {
        const s = new FilePersistence(dir2);
        await s.set('a', 1);
        expect(await s.get<number>('a')).toBe(1);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    });
  });
});
