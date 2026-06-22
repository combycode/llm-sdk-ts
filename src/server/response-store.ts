/** ResponseStore — persistent registry keyed by `(userId, response_id)` for
 *  multi-user mode, or just by response_id when unauthenticated.
 *
 *  Used by the OAI server to continue stateful conversations across requests.
 *  Backing store is the generic Persistence interface — in-memory for tests,
 *  FilePersistence on disk by default. */

import { ConversationHistory } from '../agent/history';
import type { HistorySnapshot } from '../agent/history-types';
import type { Persistence } from '../plugins/persistence/types';

export interface ResponseTarget {
  /** 'direct' (registered LLMClient) — server-side AgentLoop wraps it. */
  kind: 'direct';
  /** Human-readable model name (what the client asked for, before resolution). */
  model: string;
  /** Routing tag (provider/model for direct entries). */
  id: string;
}

export interface ResponseStoreEntryMeta {
  localResponseId: string;
  /** Owner — set when AuthPlugin is attached. null for unauthenticated. */
  userId: string | null;
  createdAt: number;
  updatedAt: number;
  target: ResponseTarget;
  /** Provider-side response id (OpenAI / xAI) for chain passthrough. */
  providerResponseId: string | null;
  providerStateExpiresAt: number | null;
}

export interface ResponseStoreEntry extends ResponseStoreEntryMeta {
  history: ConversationHistory;
}

interface SerializedEntry {
  meta: ResponseStoreEntryMeta;
  history: HistorySnapshot;
}

export interface ResponseStoreConfig {
  persistence?: Persistence;
  /** Key prefix used when writing to the Persistence backend. Default 'response:'. */
  keyPrefix?: string;
  /** Max entries kept in-memory. Default 10_000. */
  memoryCapacity?: number;
}

export class ResponseStore {
  private readonly persistence: Persistence | null;
  private readonly keyPrefix: string;
  private readonly memoryCapacity: number;
  private readonly cache = new Map<string, ResponseStoreEntry>();

  constructor(config: ResponseStoreConfig = {}) {
    this.persistence = config.persistence ?? null;
    this.keyPrefix = config.keyPrefix ?? 'response:';
    this.memoryCapacity = config.memoryCapacity ?? 10_000;
  }

  async get(
    localResponseId: string,
    userId: string | null = null,
  ): Promise<ResponseStoreEntry | null> {
    const key = this.cacheKey(localResponseId, userId);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    if (!this.persistence) return null;
    const raw = await this.persistence.get<SerializedEntry>(
      this.persistKey(localResponseId, userId),
    );
    if (!raw) return null;
    const entry: ResponseStoreEntry = {
      ...raw.meta,
      history: ConversationHistory.import(raw.history),
    };
    this.putInCache(entry);
    return entry;
  }

  async put(
    entry: Omit<ResponseStoreEntry, 'createdAt' | 'updatedAt'> & {
      createdAt?: number;
      updatedAt?: number;
    },
  ): Promise<ResponseStoreEntry> {
    const now = Date.now();
    const full: ResponseStoreEntry = {
      ...entry,
      createdAt: entry.createdAt ?? now,
      updatedAt: entry.updatedAt ?? now,
    };
    this.putInCache(full);
    if (this.persistence) {
      const serialized: SerializedEntry = {
        meta: {
          localResponseId: full.localResponseId,
          userId: full.userId,
          createdAt: full.createdAt,
          updatedAt: full.updatedAt,
          target: full.target,
          providerResponseId: full.providerResponseId,
          providerStateExpiresAt: full.providerStateExpiresAt,
        },
        history: full.history.export(),
      };
      await this.persistence.set(this.persistKey(full.localResponseId, full.userId), serialized);
    }
    return full;
  }

  async delete(localResponseId: string, userId: string | null = null): Promise<void> {
    this.cache.delete(this.cacheKey(localResponseId, userId));
    if (this.persistence) {
      await this.persistence.delete(this.persistKey(localResponseId, userId));
    }
  }

  /** List response ids for a given user (or all unauthenticated entries). */
  async list(userId: string | null = null): Promise<string[]> {
    if (this.persistence) {
      const prefix = this.persistKeyPrefix(userId);
      const keys = await this.persistence.list(prefix);
      return keys.map((k) => k.slice(prefix.length));
    }
    const out: string[] = [];
    for (const [key, entry] of this.cache) {
      if (entry.userId === userId) out.push(entry.localResponseId);
      else if (key.startsWith(this.cacheKeyPrefix(userId))) out.push(entry.localResponseId);
    }
    return out;
  }

  static newId(): string {
    return `resp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  }

  static hasFreshProviderState(
    entry: Pick<ResponseStoreEntry, 'providerResponseId' | 'providerStateExpiresAt'>,
    now: number = Date.now(),
  ): boolean {
    if (!entry.providerResponseId || entry.providerStateExpiresAt === null) return false;
    return entry.providerStateExpiresAt > now;
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private cacheKey(id: string, userId: string | null): string {
    return userId ? `${userId}:${id}` : id;
  }

  private cacheKeyPrefix(userId: string | null): string {
    return userId ? `${userId}:` : '';
  }

  private persistKey(id: string, userId: string | null): string {
    return userId
      ? `${this.keyPrefix}${encodeURIComponent(userId)}:${id}`
      : `${this.keyPrefix}${id}`;
  }

  private persistKeyPrefix(userId: string | null): string {
    return userId ? `${this.keyPrefix}${encodeURIComponent(userId)}:` : this.keyPrefix;
  }

  private putInCache(entry: ResponseStoreEntry): void {
    const key = this.cacheKey(entry.localResponseId, entry.userId);
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.memoryCapacity) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey === undefined) break;
      this.cache.delete(firstKey);
    }
  }
}
