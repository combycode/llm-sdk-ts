/** FileMediaStore — stores media binary files + JSON metadata on disk. */

import { nodeFsPromises } from '../../runtime/runtime';
import type { MediaMeta, MediaStore, MediaType } from './types';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpeg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/mp3': '.mp3',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/pcm': '.pcm',
  'audio/opus': '.opus',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

function extForMime(mimeType: string): string {
  return MIME_TO_EXT[mimeType] ?? `.${mimeType.split('/')[1] ?? 'bin'}`;
}

export interface FileMediaStoreConfig {
  /** Directory under which media files + meta JSON go. */
  dir: string;
}

export class FileMediaStore implements MediaStore {
  private ready: Promise<void>;
  private readonly dir: string;

  constructor(config: FileMediaStoreConfig) {
    this.dir = config.dir;
    this.ready = this.ensureDir();
  }

  async save(id: string, data: Uint8Array, meta: MediaMeta): Promise<void> {
    await this.ready;
    const { writeFile } = await nodeFsPromises();
    const ext = extForMime(meta.mimeType);
    const dataPath = `${this.dir}/${id}${ext}`;
    const metaPath = `${this.dir}/${id}.meta.json`;
    await Promise.all([
      writeFile(dataPath, data),
      writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8'),
    ]);
  }

  async load(id: string): Promise<{ data: Uint8Array; meta: MediaMeta } | null> {
    await this.ready;
    const meta = await this.getMeta(id);
    if (!meta) return null;

    const ext = extForMime(meta.mimeType);
    const dataPath = `${this.dir}/${id}${ext}`;
    try {
      const { readFile } = await nodeFsPromises();
      const data = await readFile(dataPath);
      return { data: new Uint8Array(data), meta };
    } catch {
      return null;
    }
  }

  async getMeta(id: string): Promise<MediaMeta | null> {
    await this.ready;
    const metaPath = `${this.dir}/${id}.meta.json`;
    try {
      const { readFile } = await nodeFsPromises();
      const raw = await readFile(metaPath, 'utf-8');
      return JSON.parse(raw) as MediaMeta;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    await this.ready;
    const { unlink } = await nodeFsPromises();
    const meta = await this.getMeta(id);
    const metaPath = `${this.dir}/${id}.meta.json`;

    try {
      await unlink(metaPath);
    } catch {}

    if (meta) {
      const ext = extForMime(meta.mimeType);
      const dataPath = `${this.dir}/${id}${ext}`;
      try {
        await unlink(dataPath);
      } catch {}
    }
  }

  async list(filter?: { type?: MediaType; provider?: string }): Promise<string[]> {
    await this.ready;
    try {
      const { readdir } = await nodeFsPromises();
      const files = await readdir(this.dir);
      const metaFiles = files.filter((f) => f.endsWith('.meta.json'));
      const ids = metaFiles.map((f) => f.slice(0, -'.meta.json'.length));

      if (!filter) return ids;

      const results: string[] = [];
      for (const id of ids) {
        const meta = await this.getMeta(id);
        if (!meta) continue;
        if (filter.type && meta.type !== filter.type) continue;
        if (filter.provider && meta.provider !== filter.provider) continue;
        results.push(id);
      }
      return results;
    } catch {
      return [];
    }
  }

  async has(id: string): Promise<boolean> {
    await this.ready;
    const metaPath = `${this.dir}/${id}.meta.json`;
    const { access } = await nodeFsPromises();
    try {
      await access(metaPath);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureDir(): Promise<void> {
    const { mkdir } = await nodeFsPromises();
    await mkdir(this.dir, { recursive: true });
  }
}
