/** Persistence interface — unified key-value storage.
 *
 *  Implementations:
 *    - `MemoryPersistence` — in-process Map (tests, ephemeral state).
 *    - `FilePersistence`   — JSON files per key on disk.
 *    - (future) DbPersistence, RedisPersistence, ...
 *
 *  Used by: ConfigurationPlugin, Cache (FileCacheStore), Scheduler,
 *  ResponseStore, ConversationPersistence, Batcher (pending jobs). */
export interface Persistence {
  /** Get a value by key. Returns null if not found. */
  get<T>(key: string): Promise<T | null>;

  /** Set a value. Overwrites if exists. */
  set<T>(key: string, value: T): Promise<void>;

  /** Delete a key. No-op if not found. */
  delete(key: string): Promise<void>;

  /** List all keys, optionally filtered by prefix. */
  list(prefix?: string): Promise<string[]>;

  /** Check if a key exists. */
  has(key: string): Promise<boolean>;
}
