/** Cache types — store interface + entry shape.
 *
 *  The Cache plugin stores arbitrary response bodies under (cacheName, cacheKey)
 *  pairs. The semantic layer decides what makes "the same request" by computing
 *  the `cacheKey`; the cache itself is content-agnostic. */

export interface CacheEntry<T = unknown> {
  /** Stored payload — typically a provider's raw response body. */
  body: T;
  /** ms-epoch when written. */
  storedAt: number;
  /** TTL in ms. Stores prune lazily on get. */
  ttlMs: number;
  /** Cache namespace this entry belongs to. Used by `invalidate(cacheName)`. */
  cacheName: string;
}

/** Storage backend. Implementations: MemoryCacheStore, FileCacheStore. */
export interface CacheStore {
  /** Get an entry by full storage key. Null if missing or expired. */
  get<T = unknown>(storageKey: string): Promise<CacheEntry<T> | null>;
  /** Write an entry. */
  set<T = unknown>(storageKey: string, entry: CacheEntry<T>): Promise<void>;
  /** Drop a specific entry. */
  delete(storageKey: string): Promise<void>;
  /** List all keys, optionally filtered by prefix. */
  keys(prefix?: string): Promise<string[]>;
  /** Drop everything. */
  clear(): Promise<void>;
}
