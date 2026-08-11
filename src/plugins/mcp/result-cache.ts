/** Opt-in response cache honouring the 2026-07-28 `ttlMs` / `cacheScope` hints (SEP-2578).
 *
 *  A server tells the client how long a list/read result stays fresh. Without this, `listTools()`
 *  re-fetches on every call — the churn this hint exists to remove.
 *
 *  Deliberately conservative:
 *   - **Off unless asked for.** Caching changes when a caller observes a server change; that is the
 *     caller's decision, not ours.
 *   - **No hint, no caching.** `ttlMs` absent (every pre-2026 server) means nothing is stored, so
 *     behaviour is byte-identical to before.
 *   - **`ttlMs: 0` means immediately stale**, which is a real instruction — not a missing value to
 *     be replaced with a default.
 *   - **`cacheScope` is recorded, never used to widen sharing.** This cache lives inside one client
 *     with one credential, so `public` buys nothing here; storing the scope keeps the entry honest
 *     if the cache is ever shared.
 */

import type { McpCacheHints } from './types';

interface Entry {
  value: unknown;
  expiresAt: number;
  scope: 'private' | 'public';
}

export class McpResultCache {
  private readonly entries = new Map<string, Entry>();

  /** Cache key: the method plus its arguments. Two `resources/read` calls for different URIs are
   *  different entries. */
  static key(method: string, params?: unknown): string {
    return params === undefined ? method : `${method}:${JSON.stringify(params)}`;
  }

  get(key: string, now = Date.now()): unknown | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  /** Store only when the server actually asked for it. Returns whether anything was stored.
   *
   *  A non-positive `ttlMs` is an instruction, not a missing value: the server is saying *do not
   *  reuse this*. Any entry already held under that key is dropped, so the next `get` re-fetches.
   *  Without the eviction the hint is inert — a server that first said "cache for 60s" and then
   *  says "stale now" would keep being answered from the stale entry for the rest of the original
   *  TTL. Absent hints are different and must stay different: they carry no instruction, so an
   *  existing entry is left alone and pre-2026 servers behave exactly as before. */
  set(key: string, value: unknown, hints: McpCacheHints | undefined, now = Date.now()): boolean {
    const ttl = hints?.ttlMs;
    if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl <= 0) {
      this.entries.delete(key);
      return false;
    }
    if (typeof ttl !== 'number' || !Number.isFinite(ttl)) return false;
    this.entries.set(key, {
      value,
      expiresAt: now + ttl,
      scope: hints?.cacheScope === 'public' ? 'public' : 'private',
    });
    return true;
  }

  /** Drop everything — e.g. after a `*_changed` notification says the server moved on. */
  clear(): void {
    this.entries.clear();
  }

  /** Drop every entry for one method, leaving the others. */
  clearMethod(method: string): void {
    for (const key of this.entries.keys()) {
      if (key === method || key.startsWith(`${method}:`)) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
