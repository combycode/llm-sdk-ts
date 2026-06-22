/** ConfigurationPlugin — open-shape settings registry keyed by `configName`.
 *
 *  Stores arbitrary configuration bundles. Consumers (rate limiter, retry,
 *  cache TTL, custom plugins) read their own typed slice off each entry by
 *  convention. The registry itself is opaque about content.
 *
 *  Lookup order at consumer time (e.g. NetworkEngine creating a queue):
 *    1. Lookup by `configName`.
 *    2. Fallback to a parent name via `extend()` chain (handled internally).
 *    3. If nothing registered: consumer applies its own hard-coded defaults.
 *
 *  Snapshot semantics: when a queue is created, it captures its slice from
 *  the current config. Subsequent `set()` calls do NOT affect existing queues.
 *  Live updates are deferred (see report 016 §open-questions).
 *
 *  Persistence: optional. When a `Persistence` is supplied, `load()` and
 *  `save()` round-trip the registry through it under the key `__configurations`.
 *  The registry does not auto-save; callers do.
 */

import type { Persistence } from '../persistence/types';

/** Per-name settings bundle. Values are opaque. */
export type ConfigurationEntry = Record<string, unknown>;

/** What `serialize()` emits / `deserialize()` accepts. */
export interface SerializedConfigurations {
  version: 1;
  entries: Record<string, ConfigurationEntry>;
  /** Parent chain: child name → parent name. */
  parents: Record<string, string>;
}

export interface ConfigurationPluginConfig {
  /** Optional storage. When given, `load()` / `save()` use it. */
  persistence?: Persistence;
  /** Storage key under which the registry is persisted. Defaults to `__configurations`. */
  storageKey?: string;
  /** Initial entries seeded at construction. */
  initial?: Record<string, ConfigurationEntry>;
}

const DEFAULT_STORAGE_KEY = '__configurations';

export class ConfigurationPlugin {
  private readonly entries = new Map<string, ConfigurationEntry>();
  private readonly parents = new Map<string, string>();
  private readonly persistence?: Persistence;
  private readonly storageKey: string;

  constructor(config?: ConfigurationPluginConfig) {
    this.persistence = config?.persistence;
    this.storageKey = config?.storageKey ?? DEFAULT_STORAGE_KEY;
    if (config?.initial) {
      for (const [name, settings] of Object.entries(config.initial)) {
        this.entries.set(name, deepFreeze(deepClone(settings)));
      }
    }
  }

  /** Register or replace settings for a name. Throws if `name` is empty.
   *  Defensive deep clone: caller's nested objects can be mutated freely
   *  after `set()` without affecting the stored copy. */
  set(name: string, settings: ConfigurationEntry): void {
    if (!name) throw new Error('ConfigurationPlugin.set: name must be non-empty');
    this.entries.set(name, deepFreeze(deepClone(settings)));
  }

  /** Look up resolved settings for a name. Walks the parent chain (child overrides
   *  parent). Returns null if the name (and any ancestor) is unknown. */
  get(name: string): ConfigurationEntry | null {
    if (!this.entries.has(name) && !this.parents.has(name)) return null;

    const chain: ConfigurationEntry[] = [];
    let current: string | undefined = name;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const own = this.entries.get(current);
      if (own) chain.unshift(own);
      current = this.parents.get(current);
    }

    if (chain.length === 0) return null;
    // child entries override parents — merge shallowly per top-level key.
    const merged: ConfigurationEntry = {};
    for (const layer of chain) Object.assign(merged, layer);
    return merged;
  }

  /** Create a derived configuration that inherits from `baseName`.
   *  The derived entry stores ONLY the overrides; `get(newName)` merges
   *  them with the base. */
  extend(baseName: string, newName: string, overrides: ConfigurationEntry): void {
    if (!this.entries.has(baseName) && !this.parents.has(baseName)) {
      throw new Error(`ConfigurationPlugin.extend: unknown base "${baseName}"`);
    }
    this.parents.set(newName, baseName);
    this.entries.set(newName, deepFreeze(deepClone(overrides)));
  }

  /** Whether a name is registered (directly or via parent chain). */
  has(name: string): boolean {
    return this.entries.has(name) || this.parents.has(name);
  }

  /** Remove a name. If others extend from it, they remain but `get()` on them
   *  returns null when their full chain becomes broken. */
  delete(name: string): void {
    this.entries.delete(name);
    this.parents.delete(name);
  }

  /** All registered names. */
  names(): string[] {
    const all = new Set<string>([...this.entries.keys(), ...this.parents.keys()]);
    return Array.from(all);
  }

  /** Snapshot the registry. */
  serialize(): SerializedConfigurations {
    return {
      version: 1,
      entries: Object.fromEntries(this.entries),
      parents: Object.fromEntries(this.parents),
    };
  }

  /** Replace the registry from a snapshot. */
  deserialize(data: SerializedConfigurations): void {
    if (data.version !== 1) {
      throw new Error(`ConfigurationPlugin.deserialize: unsupported version ${data.version}`);
    }
    this.entries.clear();
    this.parents.clear();
    for (const [name, settings] of Object.entries(data.entries ?? {})) {
      this.entries.set(name, deepFreeze(deepClone(settings)));
    }
    for (const [child, parent] of Object.entries(data.parents ?? {})) {
      this.parents.set(child, parent);
    }
  }

  /** Load from configured persistence. No-op if no persistence attached.
   *  Returns true if data was loaded; false if storage was empty. */
  async load(): Promise<boolean> {
    if (!this.persistence) return false;
    const data = await this.persistence.get<SerializedConfigurations>(this.storageKey);
    if (!data) return false;
    this.deserialize(data);
    return true;
  }

  /** Save to configured persistence. Throws if no persistence attached. */
  async save(): Promise<void> {
    if (!this.persistence) {
      throw new Error('ConfigurationPlugin.save: no persistence attached');
    }
    await this.persistence.set(this.storageKey, this.serialize());
  }
}

function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const value = (obj as Record<string, unknown>)[key];
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value as object);
    }
  }
  return obj;
}

function deepClone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
