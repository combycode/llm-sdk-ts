/** Cache — semantic-keyed response cache.
 *
 *  Lives at the network layer. Caller (LLMClient via RequestContext, or any
 *  application) supplies:
 *    - `cacheName`: namespace ("default", "user-${userId}", "shared", ...)
 *    - `cacheKey`:  content key (typically a content hash computed by LLMClient)
 *
 *  Storage key composition: `cache:{cacheName}:{cacheKey}`.
 *
 *  The cache is content-agnostic. It does not compute keys itself — that's
 *  semantic. The cache itself does not subscribe to a hook bus; NetworkEngine
 *  owns the bus wiring and emits the relevant cache events.
 *
 *  TTL: per-entry, with default at construction. Expired entries are
 *  detected on `get()` and dropped lazily. */

import type { CacheEntry, CacheStore } from './types';

export interface CachePluginConfig {
  store: CacheStore;
  /** Default TTL in ms applied to entries when caller does not specify one.
   *  Use Number.POSITIVE_INFINITY for "never expire". */
  ttlMs?: number;
  /** Namespace fallback when caller passes `set(undefined, ...)`. Default: 'default'. */
  defaultName?: string;
}

export interface InvalidateScope {
  /** Keep only entries whose cacheName matches this exact namespace. */
  cacheName?: string;
  /** Sub-pattern within a name. Currently a string prefix on cacheKey. */
  keyPrefix?: string;
}

const STORAGE_PREFIX = 'cache:';
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class Cache {
  private readonly store: CacheStore;
  private readonly defaultTtl: number;
  private readonly defaultName: string;

  constructor(config: CachePluginConfig) {
    this.store = config.store;
    this.defaultTtl = config.ttlMs ?? DEFAULT_TTL_MS;
    this.defaultName = config.defaultName ?? 'default';
  }

  /** Look up a cached response by (cacheName, cacheKey). Null if missing or expired. */
  async get<T = unknown>(cacheName: string | undefined, cacheKey: string): Promise<T | null> {
    const name = cacheName ?? this.defaultName;
    const storageKey = makeStorageKey(name, cacheKey);
    const entry = await this.store.get<T>(storageKey);
    if (!entry) return null;
    if (isExpired(entry)) {
      await this.store.delete(storageKey);
      return null;
    }
    return entry.body;
  }

  /** Store a response under (cacheName, cacheKey). Overwrites any existing entry. */
  async set<T = unknown>(
    cacheName: string | undefined,
    cacheKey: string,
    body: T,
    options?: { ttlMs?: number },
  ): Promise<void> {
    const name = cacheName ?? this.defaultName;
    const storageKey = makeStorageKey(name, cacheKey);
    const entry: CacheEntry<T> = {
      body,
      storedAt: Date.now(),
      ttlMs: options?.ttlMs ?? this.defaultTtl,
      cacheName: name,
    };
    await this.store.set(storageKey, entry);
  }

  /** Remove a single entry. */
  async delete(cacheName: string | undefined, cacheKey: string): Promise<void> {
    const name = cacheName ?? this.defaultName;
    await this.store.delete(makeStorageKey(name, cacheKey));
  }

  /** Drop entries matching scope. Empty scope clears everything cache-managed.
   *  Returns the number of entries removed. */
  async invalidate(scope: InvalidateScope = {}): Promise<number> {
    const all = await this.store.keys(STORAGE_PREFIX);
    let removed = 0;
    for (const storageKey of all) {
      // storageKey format: cache:{cacheName}:{cacheKey-with-arbitrary-content}
      // We need cacheName-aware filtering before doing keyPrefix.
      const parsed = parseStorageKey(storageKey);
      if (!parsed) continue;
      if (scope.cacheName && parsed.cacheName !== scope.cacheName) continue;
      if (scope.keyPrefix && !parsed.cacheKey.startsWith(scope.keyPrefix)) continue;
      await this.store.delete(storageKey);
      removed++;
    }
    return removed;
  }

  /** Drop all entries (cache-managed and otherwise) from the store.
   *  Compare with `invalidate({})` which only removes cache-prefixed entries. */
  async clear(): Promise<void> {
    await this.store.clear();
  }
}

function makeStorageKey(cacheName: string, cacheKey: string): string {
  return `${STORAGE_PREFIX}${cacheName}:${cacheKey}`;
}

function parseStorageKey(storageKey: string): { cacheName: string; cacheKey: string } | null {
  if (!storageKey.startsWith(STORAGE_PREFIX)) return null;
  const rest = storageKey.slice(STORAGE_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep < 0) return null;
  return {
    cacheName: rest.slice(0, sep),
    cacheKey: rest.slice(sep + 1),
  };
}

function isExpired(entry: CacheEntry<unknown>): boolean {
  if (!Number.isFinite(entry.ttlMs)) return false;
  return Date.now() - entry.storedAt > entry.ttlMs;
}
