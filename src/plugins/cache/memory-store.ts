/** MemoryCacheStore — in-process Map-backed CacheStore. Lost on restart. */

import type { CacheEntry, CacheStore } from './types';

export class MemoryCacheStore implements CacheStore {
  private map = new Map<string, CacheEntry<unknown>>();

  async get<T = unknown>(storageKey: string): Promise<CacheEntry<T> | null> {
    return (this.map.get(storageKey) as CacheEntry<T> | undefined) ?? null;
  }

  async set<T = unknown>(storageKey: string, entry: CacheEntry<T>): Promise<void> {
    this.map.set(storageKey, entry as CacheEntry<unknown>);
  }

  async delete(storageKey: string): Promise<void> {
    this.map.delete(storageKey);
  }

  async keys(prefix?: string): Promise<string[]> {
    const all = Array.from(this.map.keys());
    return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
  }

  async clear(): Promise<void> {
    this.map.clear();
  }
}
