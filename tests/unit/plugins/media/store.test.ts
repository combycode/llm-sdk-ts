import { describe, expect, it } from 'bun:test';
import { MemoryMediaStore } from '../../../../src/plugins/media/memory-store';
import type { MediaMeta } from '../../../../src/plugins/media/types';

function meta(id: string, type: 'image' | 'audio' | 'video' = 'image', provider = 'p'): MediaMeta {
  return {
    id,
    type,
    mimeType: type === 'image' ? 'image/png' : type === 'audio' ? 'audio/mp3' : 'video/mp4',
    size: 4,
    createdAt: 1,
    provider,
  };
}

describe('MemoryMediaStore', () => {
  it('save + load round-trips bytes and meta', async () => {
    const s = new MemoryMediaStore();
    const data = new Uint8Array([1, 2, 3, 4]);
    await s.save('m1', data, meta('m1'));
    const out = await s.load('m1');
    expect(out?.data).toEqual(data);
    expect(out?.meta.id).toBe('m1');
  });

  it('has + delete', async () => {
    const s = new MemoryMediaStore();
    await s.save('m1', new Uint8Array([1]), meta('m1'));
    expect(await s.has('m1')).toBe(true);
    await s.delete('m1');
    expect(await s.has('m1')).toBe(false);
  });

  it('list filters by type and provider', async () => {
    const s = new MemoryMediaStore();
    await s.save('a', new Uint8Array([1]), meta('a', 'image', 'openai'));
    await s.save('b', new Uint8Array([1]), meta('b', 'audio', 'openai'));
    await s.save('c', new Uint8Array([1]), meta('c', 'image', 'google'));

    expect((await s.list({ type: 'image' })).sort()).toEqual(['a', 'c']);
    expect((await s.list({ provider: 'openai' })).sort()).toEqual(['a', 'b']);
  });

  it('getMeta returns null for unknown', async () => {
    expect(await new MemoryMediaStore().getMeta('nope')).toBeNull();
  });
});
