/** createCollection — typed namespace over `engine.persistence`.
 *
 *  Wraps the raw key/value persistence in a small typed handle keyed by
 *  short names within a single namespace. Lets app code talk in domain
 *  terms (subagents, prompts, conversations) without juggling key
 *  prefixes or the underlying file/db wiring. */

import type { Persistence } from '../plugins/persistence/types';
import { coreRegistry } from './engine';

export interface Collection<T> {
  set(key: string, value: T): Promise<void>;
  get(key: string): Promise<T | null>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Short keys (without the namespace prefix). */
  keys(): Promise<string[]>;
  /** All values. */
  list(): Promise<T[]>;
  /** [shortKey, value] pairs. */
  entries(): Promise<Array<[string, T]>>;
}

export function createCollection<T>(name: string): Collection<T> {
  if (!name || /[/]/.test(name)) {
    throw new Error(
      `createCollection: name must be a non-empty string without "/" (got "${name}")`,
    );
  }
  const prefix = `${name}:`;
  const fullKey = (k: string): string => `${prefix}${k}`;
  const shortKey = (k: string): string => k.slice(prefix.length);

  const persistence = (): Persistence => coreRegistry.get().persistence;

  return {
    async set(key, value) {
      await persistence().set(fullKey(key), value);
    },
    async get(key) {
      return persistence().get<T>(fullKey(key));
    },
    async has(key) {
      return persistence().has(fullKey(key));
    },
    async delete(key) {
      await persistence().delete(fullKey(key));
    },
    async keys() {
      const all = await persistence().list(prefix);
      return all.map(shortKey);
    },
    async list() {
      const p = persistence();
      const all = await p.list(prefix);
      const values = await Promise.all(all.map((k) => p.get<T>(k)));
      return values.filter((v) => v !== null) as T[];
    },
    async entries() {
      const p = persistence();
      const all = await p.list(prefix);
      const pairs = await Promise.all(
        all.map(async (k): Promise<[string, T] | null> => {
          const v = await p.get<T>(k);
          return v === null ? null : [shortKey(k), v];
        }),
      );
      return pairs.filter((e) => e !== null) as Array<[string, T]>;
    },
  };
}
