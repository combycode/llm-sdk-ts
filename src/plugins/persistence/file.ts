/** FilePersistence — stores each key as a JSON file in a directory.
 *
 *  Key encoding: chars outside `[A-Za-z0-9_.-]` are %-escaped (URL-style)
 *  so any key works on Windows/Unix filesystems.
 *
 *  Concurrency: writes are not atomic. For a multi-process scenario,
 *  callers should layer their own locking on top. Single-process,
 *  single-thread use is safe. */

import { nodeFsPromises } from '../../runtime/runtime';
import type { Persistence } from './types';

export interface FilePersistenceConfig {
  /** Directory in which JSON files are stored. Created on first write. */
  dir: string;
}

export class FilePersistence implements Persistence {
  private readonly dir: string;
  private readonly ready: Promise<void>;

  constructor(config: FilePersistenceConfig | string) {
    this.dir = typeof config === 'string' ? config : config.dir;
    this.ready = this.ensureDir();
  }

  async get<T>(key: string): Promise<T | null> {
    await this.ready;
    try {
      const { readFile } = await nodeFsPromises();
      const data = await readFile(this.keyPath(key), 'utf-8');
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.ready;
    const { writeFile } = await nodeFsPromises();
    await writeFile(this.keyPath(key), JSON.stringify(value, null, 2), 'utf-8');
  }

  async delete(key: string): Promise<void> {
    await this.ready;
    try {
      const { unlink } = await nodeFsPromises();
      await unlink(this.keyPath(key));
    } catch {
      // No-op if missing.
    }
  }

  async list(prefix?: string): Promise<string[]> {
    await this.ready;
    try {
      const { readdir } = await nodeFsPromises();
      const files = await readdir(this.dir);
      let keys = files.filter((f) => f.endsWith('.json')).map((f) => decodeKey(f.slice(0, -5)));
      if (prefix) keys = keys.filter((k) => k.startsWith(prefix));
      return keys;
    } catch {
      return [];
    }
  }

  async has(key: string): Promise<boolean> {
    await this.ready;
    const { access } = await nodeFsPromises();
    try {
      await access(this.keyPath(key));
      return true;
    } catch {
      return false;
    }
  }

  private keyPath(key: string): string {
    return `${this.dir}/${encodeKey(key)}.json`;
  }

  private async ensureDir(): Promise<void> {
    const { mkdir } = await nodeFsPromises();
    await mkdir(this.dir, { recursive: true });
  }
}

function encodeKey(key: string): string {
  return key.replace(
    /[^a-zA-Z0-9_\-.]/g,
    (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

function decodeKey(encoded: string): string {
  return encoded.replace(/%([0-9a-f]{2})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}
