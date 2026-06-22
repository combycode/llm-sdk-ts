/** FileCacheStore — persists CacheEntries as JSON files via FilePersistence.
 *  Survives process restart. */

import { FilePersistence } from '../persistence/file';
import type { CacheEntry, CacheStore } from './types';

export interface FileCacheStoreConfig {
  dir: string;
}

export class FileCacheStore implements CacheStore {
  private readonly store: FilePersistence;

  constructor(config: FileCacheStoreConfig) {
    this.store = new FilePersistence(config.dir);
  }

  async get<T = unknown>(storageKey: string): Promise<CacheEntry<T> | null> {
    return this.store.get<CacheEntry<T>>(storageKey);
  }

  async set<T = unknown>(storageKey: string, entry: CacheEntry<T>): Promise<void> {
    await this.store.set(storageKey, entry);
  }

  async delete(storageKey: string): Promise<void> {
    await this.store.delete(storageKey);
  }

  async keys(prefix?: string): Promise<string[]> {
    return this.store.list(prefix);
  }

  async clear(): Promise<void> {
    const all = await this.store.list();
    await Promise.all(all.map((k) => this.store.delete(k)));
  }
}
