/** FileCacheStore — the disk-backed CacheStore.
 *
 *  It is a thin adapter over FilePersistence, and thin is the point: a cache
 *  that survives a restart must round-trip the WHOLE entry, not just the body,
 *  or the TTL and the cache name are lost and every restored entry looks
 *  freshly written and unattributed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCacheStore } from '../../../../src/plugins/cache/file-store';
import type { CacheEntry } from '../../../../src/plugins/cache/types';

function entry(cacheName: string, body: unknown = { v: 1 }): CacheEntry {
  return { body, storedAt: 1_700_000_000_000, ttlMs: 60_000, cacheName };
}

describe('FileCacheStore', () => {
  let dir: string;
  let store: FileCacheStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orxa-fcs-'));
    store = new FileCacheStore({ dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a missing key reads as null, not as an empty entry', async () => {
    expect(await store.get('cache:n:absent')).toBeNull();
  });

  it('set() writes the whole entry — ttl and cache name included', async () => {
    await store.set('cache:n:k', entry('n', { data: 42 }));

    const got = await store.get<{ data: number }>('cache:n:k');
    expect(got).toEqual({
      body: { data: 42 },
      storedAt: 1_700_000_000_000,
      ttlMs: 60_000,
      cacheName: 'n',
    });
    // One file on disk per key.
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('set() on an existing key overwrites rather than appending a second file', async () => {
    await store.set('cache:n:k', entry('n', 'first'));
    await store.set('cache:n:k', entry('n', 'second'));

    expect((await store.get<string>('cache:n:k'))?.body).toBe('second');
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('delete() removes exactly that key and leaves its neighbours alone', async () => {
    await store.set('cache:n:a', entry('n', 'A'));
    await store.set('cache:n:b', entry('n', 'B'));

    await store.delete('cache:n:a');

    expect(await store.get('cache:n:a')).toBeNull();
    expect((await store.get<string>('cache:n:b'))?.body).toBe('B');
    expect(await store.keys()).toEqual(['cache:n:b']);
  });

  it('delete() of a key that was never written is a no-op, not an error', async () => {
    await store.set('cache:n:a', entry('n'));
    await store.delete('cache:n:never-existed');
    expect(await store.keys()).toEqual(['cache:n:a']);
  });

  it('deleting twice is harmless', async () => {
    await store.set('cache:n:a', entry('n'));
    await store.delete('cache:n:a');
    await store.delete('cache:n:a');
    expect(await store.keys()).toEqual([]);
  });

  it('keys() lists everything, and filters by prefix when asked', async () => {
    await store.set('cache:a:1', entry('a'));
    await store.set('cache:a:2', entry('a'));
    await store.set('cache:b:1', entry('b'));

    expect((await store.keys()).sort()).toEqual(['cache:a:1', 'cache:a:2', 'cache:b:1']);
    expect((await store.keys('cache:a:')).sort()).toEqual(['cache:a:1', 'cache:a:2']);
    expect(await store.keys('cache:zz:')).toEqual([]);
  });

  it('clear() removes every entry, and the store stays usable afterwards', async () => {
    await store.set('cache:a:1', entry('a'));
    await store.set('cache:b:1', entry('b'));

    await store.clear();

    expect(await store.keys()).toEqual([]);
    expect(await store.get('cache:a:1')).toBeNull();
    await store.set('cache:c:1', entry('c', 'after'));
    expect((await store.get<string>('cache:c:1'))?.body).toBe('after');
  });

  it('clear() on an empty store is a no-op', async () => {
    await store.clear();
    expect(await store.keys()).toEqual([]);
  });

  it('survives a restart: a second instance over the same directory sees the entries', async () => {
    await store.set('cache:n:k', entry('n', { data: 42 }));

    const reopened = new FileCacheStore({ dir });

    expect((await reopened.get<{ data: number }>('cache:n:k'))?.body).toEqual({ data: 42 });
    await reopened.delete('cache:n:k');
    // ...and a delete through one instance is visible through the other.
    expect(await store.get('cache:n:k')).toBeNull();
  });

  it('keys containing filesystem-hostile characters round-trip intact', async () => {
    const key = 'cache:n:https://api.example.com/v1?q=a b&x=1';
    await store.set(key, entry('n', 'ok'));
    expect((await store.get<string>(key))?.body).toBe('ok');
    expect(await store.keys()).toEqual([key]);
    await store.delete(key);
    expect(await store.keys()).toEqual([]);
  });
});
