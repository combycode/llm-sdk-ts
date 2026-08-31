import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMediaStore } from '../../../../src/plugins/media/file-store';
import type { MediaMeta, MediaType } from '../../../../src/plugins/media/types';

function meta(over: Partial<MediaMeta> = {}): MediaMeta {
  return {
    id: 'm1',
    type: 'image',
    mimeType: 'image/png',
    size: 3,
    createdAt: 1_700_000_000_000,
    provider: 'openai',
    ...over,
  };
}

describe('FileMediaStore', () => {
  let dir: string;
  let store: FileMediaStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orxa-media-'));
    store = new FileMediaStore({ dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('layout on disk', () => {
    it('creates the target directory, including missing parents', async () => {
      const nested = join(dir, 'a', 'b', 'c');
      const s = new FileMediaStore({ dir: nested });
      await s.save('m1', new Uint8Array([1]), meta());
      expect(existsSync(nested)).toBe(true);
      expect(existsSync(join(nested, 'm1.png'))).toBe(true);
    });

    it('writes bytes beside a sidecar meta JSON named <id>.meta.json', async () => {
      const data = new Uint8Array([137, 80, 78, 71]);
      await store.save('m1', data, meta({ id: 'm1', prompt: 'a cat' }));

      const bytes = readFileSync(join(dir, 'm1.png'));
      expect(new Uint8Array(bytes)).toEqual(data);

      const raw = readFileSync(join(dir, 'm1.meta.json'), 'utf-8');
      expect(JSON.parse(raw)).toEqual(meta({ id: 'm1', prompt: 'a cat' }));
      // Written pretty so the sidecar is human-readable on disk.
      expect(raw).toContain('\n');
    });

    it('overwrites both files when the same id is saved twice', async () => {
      await store.save('m1', new Uint8Array([1]), meta({ prompt: 'first' }));
      await store.save('m1', new Uint8Array([2, 2]), meta({ prompt: 'second', size: 2 }));
      const out = await store.load('m1');
      expect(out?.data).toEqual(new Uint8Array([2, 2]));
      expect(out?.meta.prompt).toBe('second');
    });
  });

  describe('extension is derived from the mime type', () => {
    // The data file is addressed by <id><ext>, so a wrong extension means the
    // bytes are written where load() will never look for them.
    const cases: Array<[string, string, MediaType]> = [
      ['image/png', '.png', 'image'],
      ['image/jpeg', '.jpeg', 'image'],
      ['image/jpg', '.jpg', 'image'],
      ['image/webp', '.webp', 'image'],
      ['image/gif', '.gif', 'image'],
      ['audio/mp3', '.mp3', 'audio'],
      ['audio/mpeg', '.mp3', 'audio'],
      ['audio/wav', '.wav', 'audio'],
      ['audio/pcm', '.pcm', 'audio'],
      ['audio/opus', '.opus', 'audio'],
      ['audio/aac', '.aac', 'audio'],
      ['audio/flac', '.flac', 'audio'],
      ['video/mp4', '.mp4', 'video'],
      ['video/webm', '.webm', 'video'],
    ];

    it.each(cases)('%s -> %s', async (mimeType, ext, type) => {
      await store.save('m1', new Uint8Array([1]), meta({ mimeType, type }));
      expect(existsSync(join(dir, `m1${ext}`))).toBe(true);
    });

    it('falls back to the mime subtype for an unmapped type', async () => {
      await store.save('m1', new Uint8Array([1]), meta({ mimeType: 'image/avif' }));
      expect(existsSync(join(dir, 'm1.avif'))).toBe(true);
      expect((await store.load('m1'))?.data).toEqual(new Uint8Array([1]));
    });

    it('falls back to .bin when the mime type has no subtype', async () => {
      await store.save('m1', new Uint8Array([9]), meta({ mimeType: 'application' }));
      expect(existsSync(join(dir, 'm1.bin'))).toBe(true);
      expect((await store.load('m1'))?.data).toEqual(new Uint8Array([9]));
    });
  });

  describe('load', () => {
    it('round-trips bytes and meta', async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      await store.save('m1', data, meta({ size: 5, revisedPrompt: 'a fluffy cat' }));
      const out = await store.load('m1');
      expect(out?.data).toBeInstanceOf(Uint8Array);
      expect(out?.data).toEqual(data);
      expect(out?.meta.revisedPrompt).toBe('a fluffy cat');
    });

    it('returns null when nothing was ever stored under that id', async () => {
      expect(await store.load('missing')).toBeNull();
    });

    it('returns null when the sidecar survives but the bytes are gone', async () => {
      await store.save('m1', new Uint8Array([1]), meta());
      rmSync(join(dir, 'm1.png'));
      expect(await store.load('m1')).toBeNull();
      // The sidecar is still readable — only the payload is missing.
      expect(await store.getMeta('m1')).not.toBeNull();
    });
  });

  describe('getMeta', () => {
    it('returns the parsed sidecar', async () => {
      await store.save('m1', new Uint8Array([1]), meta({ model: 'dall-e-3', width: 1024 }));
      const m = await store.getMeta('m1');
      expect(m?.model).toBe('dall-e-3');
      expect(m?.width).toBe(1024);
    });

    it('returns null for an unknown id', async () => {
      expect(await store.getMeta('nope')).toBeNull();
    });

    it('returns null rather than throwing on a corrupt sidecar', async () => {
      writeFileSync(join(dir, 'bad.meta.json'), '{ not json', 'utf-8');
      expect(await store.getMeta('bad')).toBeNull();
    });
  });

  describe('delete', () => {
    it('removes the bytes and the sidecar together', async () => {
      await store.save('m1', new Uint8Array([1]), meta());
      await store.delete('m1');
      expect(existsSync(join(dir, 'm1.png'))).toBe(false);
      expect(existsSync(join(dir, 'm1.meta.json'))).toBe(false);
      expect(await store.has('m1')).toBe(false);
      expect(await store.load('m1')).toBeNull();
    });

    it('is a no-op for an unknown id', async () => {
      await store.delete('never-existed');
      expect(await store.has('never-existed')).toBe(false);
    });

    it('still removes the sidecar when the bytes are already gone', async () => {
      await store.save('m1', new Uint8Array([1]), meta());
      rmSync(join(dir, 'm1.png'));
      await store.delete('m1');
      expect(existsSync(join(dir, 'm1.meta.json'))).toBe(false);
    });

    it('leaves the orphaned bytes when the sidecar is already gone', async () => {
      // Without the sidecar the extension is unknowable, so the payload cannot
      // be located — the store reports no such id rather than guessing.
      await store.save('m1', new Uint8Array([1]), meta());
      rmSync(join(dir, 'm1.meta.json'));
      await store.delete('m1');
      expect(existsSync(join(dir, 'm1.png'))).toBe(true);
    });
  });

  describe('list', () => {
    async function seed(): Promise<void> {
      await store.save(
        'a',
        new Uint8Array([1]),
        meta({ id: 'a', type: 'image', provider: 'openai' }),
      );
      await store.save(
        'b',
        new Uint8Array([1]),
        meta({ id: 'b', type: 'audio', mimeType: 'audio/mp3', provider: 'openai' }),
      );
      await store.save(
        'c',
        new Uint8Array([1]),
        meta({ id: 'c', type: 'video', mimeType: 'video/mp4', provider: 'google' }),
      );
    }

    it('lists ids from the sidecars, counting each item once', async () => {
      await seed();
      // Data files sit in the same directory; only .meta.json defines an id.
      expect((await store.list()).sort()).toEqual(['a', 'b', 'c']);
    });

    it('strips exactly the .meta.json suffix', async () => {
      await store.save('img.meta', new Uint8Array([1]), meta({ id: 'img.meta' }));
      expect(await store.list()).toEqual(['img.meta']);
    });

    it('filters by type', async () => {
      await seed();
      expect(await store.list({ type: 'audio' })).toEqual(['b']);
      expect((await store.list({ type: 'image' })).sort()).toEqual(['a']);
    });

    it('filters by provider', async () => {
      await seed();
      expect((await store.list({ provider: 'openai' })).sort()).toEqual(['a', 'b']);
      expect(await store.list({ provider: 'google' })).toEqual(['c']);
    });

    it('applies type and provider together as an AND', async () => {
      await seed();
      expect(await store.list({ type: 'image', provider: 'openai' })).toEqual(['a']);
      expect(await store.list({ type: 'image', provider: 'google' })).toEqual([]);
    });

    it('an empty filter object still lists everything readable', async () => {
      await seed();
      expect((await store.list({})).sort()).toEqual(['a', 'b', 'c']);
    });

    it('omitting the filter lists ids from filenames without parsing the sidecars', async () => {
      // No filter means no reason to read anything, so an unparseable sidecar
      // is still a stored id. Passing any filter object — even `{}` — takes the
      // reading path, where an unparseable sidecar is dropped.
      await seed();
      writeFileSync(join(dir, 'broken.meta.json'), 'not json at all', 'utf-8');
      expect((await store.list()).sort()).toEqual(['a', 'b', 'broken', 'c']);
      expect((await store.list({})).sort()).toEqual(['a', 'b', 'c']);
    });

    it('a filtered listing skips an entry whose sidecar is unreadable', async () => {
      await seed();
      writeFileSync(join(dir, 'broken.meta.json'), 'not json at all', 'utf-8');
      expect((await store.list({ provider: 'openai' })).sort()).toEqual(['a', 'b']);
    });

    it('returns [] when the directory has been removed underneath it', async () => {
      await seed();
      rmSync(dir, { recursive: true, force: true });
      expect(await store.list()).toEqual([]);
    });

    it('returns [] for an empty store', async () => {
      expect(await store.list()).toEqual([]);
    });
  });

  describe('has', () => {
    it('is true once saved and false before', async () => {
      expect(await store.has('m1')).toBe(false);
      await store.save('m1', new Uint8Array([1]), meta());
      expect(await store.has('m1')).toBe(true);
    });

    it('keys on the sidecar, not the payload', async () => {
      await store.save('m1', new Uint8Array([1]), meta());
      rmSync(join(dir, 'm1.png'));
      expect(await store.has('m1')).toBe(true);
    });
  });

  it('a second store over the same directory sees what the first wrote', async () => {
    await store.save('m1', new Uint8Array([7, 7]), meta({ prompt: 'shared' }));
    const other = new FileMediaStore({ dir });
    expect((await other.load('m1'))?.meta.prompt).toBe('shared');
    expect(await other.list()).toEqual(['m1']);
  });
});
