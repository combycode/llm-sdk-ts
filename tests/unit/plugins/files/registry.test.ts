import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../../src/bus/hook-bus';
import type { MessageResolveContext } from '../../../../src/bus/hook-map';
import type { EngineFetch } from '../../../../src/network/types';
import { FileAttachment } from '../../../../src/plugins/files/attachment';
import type { FileProviderAdapter } from '../../../../src/plugins/files/provider-adapter';
import { FilesRegistry } from '../../../../src/plugins/files/registry';

// Adapters are mocked, so the registry never actually dispatches HTTP.
const noopFetch: EngineFetch = async () => ({ status: 200, headers: {}, body: {} });

function fakeAdapter(
  name: string,
  behavior: Partial<FileProviderAdapter> = {},
): FileProviderAdapter {
  return {
    name,
    expiresAfter: null,
    maxFileSize: 100_000_000,
    supportedTypes: null,
    upload: async () => ({
      remoteId: `remote_${name}_${crypto.randomUUID().slice(0, 6)}`,
      expiresAt: null,
    }),
    delete: async () => {},
    getInfo: async () => null,
    list: async () => [],
    ...behavior,
  };
}

describe('FilesRegistry — basic CRUD', () => {
  it('add registers a file', () => {
    const reg = new FilesRegistry({ hooks: new HookBus(), fetch: noopFetch });
    const f = reg.add({
      filename: 'a.txt',
      mimeType: 'text/plain',
      content: { type: 'base64', mimeType: 'text/plain', data: btoa('hello') },
    });
    expect(reg.get(f.id)?.filename).toBe('a.txt');
    expect(reg.list().length).toBe(1);
  });

  it('upload writes upload state to the attachment', async () => {
    const reg = new FilesRegistry({ hooks: new HookBus(), fetch: noopFetch });
    reg.registerProvider('mock', fakeAdapter('mock'));
    const f = reg.add({
      filename: 'x.bin',
      mimeType: 'application/octet-stream',
      content: { type: 'base64', mimeType: 'application/octet-stream', data: 'AAAA' },
      sizeBytes: 3,
    });
    const remoteId = await reg.upload(f.id, 'mock');
    expect(remoteId).toContain('remote_mock_');
    expect(reg.get(f.id)?.isAvailable('mock')).toBe(true);
  });

  it('throws when uploading to unknown provider', async () => {
    const reg = new FilesRegistry({ hooks: new HookBus(), fetch: noopFetch });
    const f = reg.add({
      filename: 'x',
      mimeType: 'text/plain',
      content: { type: 'base64', mimeType: 'text/plain', data: 'AA' },
      sizeBytes: 1,
    });
    await expect(reg.upload(f.id, 'no-such')).rejects.toThrow(/No file adapter/);
  });
});

describe('FilesRegistry — onMessageResolve resolves file refs', () => {
  it('replaces a path-typed source with provider_ref after upload', async () => {
    const hooks = new HookBus();
    const reg = new FilesRegistry({ hooks, fetch: noopFetch });
    reg.registerProvider('mock', fakeAdapter('mock'));

    // Pre-register file under the registry so we can pass type:'file'
    const file = reg.add({
      filename: 'a.png',
      mimeType: 'image/png',
      content: { type: 'base64', mimeType: 'image/png', data: 'AAAA' },
      sizeBytes: 100_000, // big enough to trigger upload
    });

    const ctx: MessageResolveContext = {
      provider: 'mock',
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'file', fileId: file.id } }],
        },
      ],
    };
    await hooks.emit('onMessageResolve', ctx);

    const part = ctx.messages[0].content[0] as { source: { type: string } };
    expect(['provider_ref', 'base64']).toContain(part.source.type);
  });

  it('warns when type:file references missing id', async () => {
    const hooks = new HookBus();
    const warnings: unknown[] = [];
    hooks.on('onWarning', (c) => {
      warnings.push(c);
    });
    const reg = new FilesRegistry({ hooks, fetch: noopFetch });
    reg.registerProvider('mock', fakeAdapter('mock'));

    await hooks.emit('onMessageResolve', {
      provider: 'mock',
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'file', fileId: 'nope' } }],
        },
      ],
    });

    expect(warnings.some((w) => (w as { code: string }).code === 'file_not_found')).toBe(true);
  });
});

describe('FileAttachment — upload state machine', () => {
  it('isAvailable false until setUploaded; flips to expired past expiry', () => {
    const f = new FileAttachment({
      filename: 'x',
      mimeType: 'text/plain',
      sizeBytes: 1,
      content: { type: 'base64', mimeType: 'text/plain', data: 'AA' },
    });
    expect(f.isAvailable('mock')).toBe(false);
    f.setUploaded('mock', 'remote_1', null);
    expect(f.isAvailable('mock')).toBe(true);
    expect(f.getRef('mock')).toBe('remote_1');

    f.setUploaded('mock', 'remote_2', Date.now() - 1);
    expect(f.isAvailable('mock')).toBe(false);
    expect(f.uploads.get('mock')?.status).toBe('expired');
  });

  it('toBase64 round-trips buffer', async () => {
    const f = new FileAttachment({
      filename: 'x',
      mimeType: 'text/plain',
      sizeBytes: 5,
      content: { type: 'buffer', mimeType: 'text/plain', data: new TextEncoder().encode('hello') },
    });
    expect(await f.toBase64()).toBe(btoa('hello'));
  });
});
