/** MemoryPersistence — in-process Map-backed Persistence implementation.
 *
 *  Use cases:
 *    - Unit tests (no temp dirs).
 *    - Ephemeral runs where state should not outlive the process.
 *    - Default fallback in createEngine when no persistence is configured.
 *
 *  Values are deep-copied via structuredClone on get/set to prevent callers
 *  from mutating stored objects through retained references. This matches
 *  FilePersistence semantics (JSON serialize/parse round-trip). */

import type { Persistence } from './types';

export class MemoryPersistence implements Persistence {
  private store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    if (!this.store.has(key)) return null;
    const value = this.store.get(key);
    return clone(value) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, clone(value));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(prefix?: string): Promise<string[]> {
    const keys = Array.from(this.store.keys());
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  /** Test affordance: number of stored entries. Not part of Persistence iface. */
  get size(): number {
    return this.store.size;
  }

  /** Test affordance: drop everything. Not part of Persistence iface. */
  clear(): void {
    this.store.clear();
  }
}

/** Deep clone via structuredClone with a JSON fallback for environments
 *  missing it. Matches FilePersistence's serialize/deserialize semantics. */
function clone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
