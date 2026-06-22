/** In-memory MediaStore. Test default; data is lost on process exit. */

import type { MediaMeta, MediaStore, MediaType } from './types';

export class MemoryMediaStore implements MediaStore {
  private entries = new Map<string, { data: Uint8Array; meta: MediaMeta }>();

  async save(id: string, data: Uint8Array, meta: MediaMeta): Promise<void> {
    this.entries.set(id, { data, meta });
  }

  async load(id: string): Promise<{ data: Uint8Array; meta: MediaMeta } | null> {
    return this.entries.get(id) ?? null;
  }

  async getMeta(id: string): Promise<MediaMeta | null> {
    return this.entries.get(id)?.meta ?? null;
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async list(filter?: { type?: MediaType; provider?: string }): Promise<string[]> {
    if (!filter) return [...this.entries.keys()];
    const out: string[] = [];
    for (const [id, { meta }] of this.entries) {
      if (filter.type && meta.type !== filter.type) continue;
      if (filter.provider && meta.provider !== filter.provider) continue;
      out.push(id);
    }
    return out;
  }

  async has(id: string): Promise<boolean> {
    return this.entries.has(id);
  }
}
