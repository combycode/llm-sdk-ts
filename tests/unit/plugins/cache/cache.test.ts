import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache } from '../../../../src/plugins/cache/cache';
import { FileCacheStore } from '../../../../src/plugins/cache/file-store';
import { MemoryCacheStore } from '../../../../src/plugins/cache/memory-store';
import type { CacheStore } from '../../../../src/plugins/cache/types';

describe('MemoryCacheStore', () => {
  let store: MemoryCacheStore;

  beforeEach(() => {
    store = new MemoryCacheStore();
  });

  it('returns null for missing key', async () => {
    expect(await store.get('cache:default:abc')).toBeNull();
  });

  it('round-trips an entry', async () => {
    await store.set('cache:default:k1', {
      body: { hello: 'world' },
      storedAt: 1,
      ttlMs: 60_000,
      cacheName: 'default',
    });
    const got = await store.get('cache:default:k1');
    expect(got?.body).toEqual({ hello: 'world' });
  });

  it('keys filters by prefix', async () => {
    await store.set('cache:a:1', mkEntry('a'));
    await store.set('cache:a:2', mkEntry('a'));
    await store.set('cache:b:1', mkEntry('b'));
    const keys = await store.keys('cache:a:');
    expect(keys.sort()).toEqual(['cache:a:1', 'cache:a:2']);
  });

  it('clear empties the store', async () => {
    await store.set('cache:a:1', mkEntry('a'));
    await store.clear();
    expect(await store.keys()).toEqual([]);
  });
});

describe('FileCacheStore', () => {
  let dir: string;
  let store: FileCacheStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orxa-cache-'));
    store = new FileCacheStore({ dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips an entry across instances', async () => {
    await store.set('cache:n:k', mkEntry('n', { data: 42 }));
    const store2 = new FileCacheStore({ dir });
    const got = await store2.get('cache:n:k');
    expect(got?.body).toEqual({ data: 42 });
  });

  it('keys() returns prefix-filtered keys', async () => {
    await store.set('cache:a:1', mkEntry('a'));
    await store.set('cache:b:1', mkEntry('b'));
    const keys = await store.keys('cache:a:');
    expect(keys).toEqual(['cache:a:1']);
  });

  it('clear() empties the store', async () => {
    await store.set('cache:a:1', mkEntry('a'));
    await store.set('cache:b:1', mkEntry('b'));
    await store.clear();
    expect(await store.keys()).toEqual([]);
  });
});

describe('Cache — get/set/delete', () => {
  let cache: Cache;
  let store: CacheStore;

  beforeEach(() => {
    store = new MemoryCacheStore();
    cache = new Cache({ store });
  });

  it('miss returns null', async () => {
    expect(await cache.get('default', 'abc')).toBeNull();
  });

  it('set+get round-trips body', async () => {
    await cache.set('default', 'abc', { content: 'hello' });
    expect(await cache.get<{ content: string }>('default', 'abc')).toEqual({ content: 'hello' });
  });

  it('different cacheNames are isolated', async () => {
    await cache.set('user-1', 'k', 'A');
    await cache.set('user-2', 'k', 'B');
    expect(await cache.get<string>('user-1', 'k')).toBe('A');
    expect(await cache.get<string>('user-2', 'k')).toBe('B');
  });

  it('uses defaultName when cacheName omitted', async () => {
    const c = new Cache({ store, defaultName: 'global' });
    await c.set(undefined, 'k', 'value');
    // Same fallback for get:
    expect(await c.get<string>(undefined, 'k')).toBe('value');
    // Direct namespace match also works:
    expect(await c.get<string>('global', 'k')).toBe('value');
  });

  it('delete removes specific entry', async () => {
    await cache.set('default', 'a', 1);
    await cache.set('default', 'b', 2);
    await cache.delete('default', 'a');
    expect(await cache.get('default', 'a')).toBeNull();
    expect(await cache.get<number>('default', 'b')).toBe(2);
  });
});

describe('Cache — TTL', () => {
  it('returns null after TTL has elapsed (mocked time)', async () => {
    const store = new MemoryCacheStore();
    const now = Date.now();
    await store.set('cache:default:k', {
      body: 'old',
      storedAt: now - 10_000,
      ttlMs: 5_000,
      cacheName: 'default',
    });
    const cache = new Cache({ store });
    expect(await cache.get('default', 'k')).toBeNull();
    // Lazy delete — entry should be gone now.
    expect(await store.get('cache:default:k')).toBeNull();
  });

  it('per-call ttl overrides default', async () => {
    const store = new MemoryCacheStore();
    const cache = new Cache({ store, ttlMs: 5_000 });
    await cache.set('default', 'k', 'value', { ttlMs: 60_000 });
    const entry = await store.get('cache:default:k');
    expect(entry?.ttlMs).toBe(60_000);
  });

  it('Infinity TTL never expires', async () => {
    const store = new MemoryCacheStore();
    const cache = new Cache({ store, ttlMs: Number.POSITIVE_INFINITY });
    await cache.set('default', 'k', 'value');
    // Manually backdate.
    const e = await store.get('cache:default:k');
    if (e) {
      await store.set('cache:default:k', { ...e, storedAt: 0 });
    }
    expect(await cache.get<string>('default', 'k')).toBe('value');
  });
});

describe('Cache — invalidate', () => {
  let cache: Cache;
  let store: CacheStore;

  beforeEach(async () => {
    store = new MemoryCacheStore();
    cache = new Cache({ store });
    await cache.set('user-1', 'k1', 'a');
    await cache.set('user-1', 'k2', 'b');
    await cache.set('user-2', 'k1', 'c');
    await cache.set('shared', 'q1', 'd');
  });

  it('invalidates by cacheName', async () => {
    const removed = await cache.invalidate({ cacheName: 'user-1' });
    expect(removed).toBe(2);
    expect(await cache.get('user-1', 'k1')).toBeNull();
    expect(await cache.get<string>('user-2', 'k1')).toBe('c');
    expect(await cache.get<string>('shared', 'q1')).toBe('d');
  });

  it('invalidates by keyPrefix within a cacheName', async () => {
    const removed = await cache.invalidate({ cacheName: 'user-1', keyPrefix: 'k1' });
    expect(removed).toBe(1);
    expect(await cache.get('user-1', 'k1')).toBeNull();
    expect(await cache.get<string>('user-1', 'k2')).toBe('b');
  });

  it('empty scope removes everything cache-managed', async () => {
    const removed = await cache.invalidate({});
    expect(removed).toBe(4);
    expect(await cache.get('user-1', 'k1')).toBeNull();
    expect(await cache.get('shared', 'q1')).toBeNull();
  });

  it('keyPrefix without cacheName matches across all namespaces', async () => {
    const removed = await cache.invalidate({ keyPrefix: 'k1' });
    expect(removed).toBe(2);
    expect(await cache.get<string>('user-1', 'k2')).toBe('b');
    expect(await cache.get<string>('shared', 'q1')).toBe('d');
  });
});

describe('Cache — clear', () => {
  it('clear() empties the underlying store completely', async () => {
    const store = new MemoryCacheStore();
    const cache = new Cache({ store });
    await cache.set('a', '1', true);
    await cache.set('b', '1', true);
    await cache.clear();
    expect(await store.keys()).toEqual([]);
  });
});

describe('Cache — separator handling', () => {
  it('cache key containing colons survives the round-trip', async () => {
    const cache = new Cache({ store: new MemoryCacheStore() });
    const trickyKey = 'sha256:abcdef:more:colons';
    await cache.set('default', trickyKey, 'value');
    expect(await cache.get<string>('default', trickyKey)).toBe('value');
  });

  it('invalidate respects cacheName boundary even when keys contain colons', async () => {
    const cache = new Cache({ store: new MemoryCacheStore() });
    await cache.set('a', 'sha:1', 'a-1');
    await cache.set('b', 'sha:1', 'b-1');
    await cache.invalidate({ cacheName: 'a' });
    expect(await cache.get('a', 'sha:1')).toBeNull();
    expect(await cache.get<string>('b', 'sha:1')).toBe('b-1');
  });
});

function mkEntry(cacheName: string, body: unknown = 'data') {
  return { body, storedAt: Date.now(), ttlMs: 60_000, cacheName };
}
