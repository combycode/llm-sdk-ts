/** FilesRegistry — remote lifecycle and the onMessageResolve rewrite.
 *
 *  The registry's job is to turn a local file reference into something the
 *  chosen provider can actually read, and to do it IN PLACE on the message the
 *  request is about to send. Two rules matter more than the rest:
 *
 *    - a file must never be sent as a `provider_ref` belonging to a different
 *      provider, and never as a ref that no longer resolves;
 *    - a file the provider cannot take must degrade to a visible text note, not
 *      to a silently dropped part.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookBus } from '../../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../../src/catalog/catalog';
import { FilesRegistry } from '../../../../src/plugins/files/registry';
import type { MessageResolveContext, WarningContext } from '../../../../src/bus/hook-map';
import type { EngineFetch } from '../../../../src/network/types';
import type { ContentPart } from '../../../../src/llm/types/messages';
import type {
  FileProviderAdapter,
  RemoteFileInfo,
} from '../../../../src/plugins/files/provider-adapter';
import type { FileDecision, FileStrategy } from '../../../../src/plugins/files/strategy';

const noopFetch: EngineFetch = (async () => ({ status: 200, headers: {}, body: {} })) as EngineFetch;

interface AdapterCalls {
  uploads: string[];
  deletes: string[];
  lists: number;
}

function adapter(
  overrides: Partial<FileProviderAdapter> = {},
): { adapter: FileProviderAdapter; calls: AdapterCalls } {
  const calls: AdapterCalls = { uploads: [], deletes: [], lists: 0 };
  const base: FileProviderAdapter = {
    name: 'mock',
    expiresAfter: null,
    maxFileSize: 100_000_000,
    supportedTypes: null,
    upload: async (file) => {
      calls.uploads.push(file.id);
      return { remoteId: `remote_${calls.uploads.length}`, expiresAt: null };
    },
    delete: async (ref) => {
      calls.deletes.push(ref);
    },
    getInfo: async () => null,
    list: async (): Promise<RemoteFileInfo[]> => {
      calls.lists++;
      return [{ remoteId: 'remote_1', filename: 'a.png', sizeBytes: 1, createdAt: 0 }];
    },
    ...overrides,
  };
  return { adapter: base, calls };
}

function registry(
  opts: { strategy?: FileStrategy; catalog?: ModelCatalog } = {},
): { hooks: HookBus; reg: FilesRegistry; warnings: WarningContext[] } {
  const hooks = new HookBus();
  const warnings: WarningContext[] = [];
  hooks.on('onWarning', (c) => {
    warnings.push(c);
  });
  const reg = new FilesRegistry({ hooks, fetch: noopFetch, ...opts });
  return { hooks, reg, warnings };
}

const smallB64 = { type: 'base64' as const, mimeType: 'image/png', data: 'AAAA' };

// ─── CRUD and teardown ───────────────────────────────────────────────────────

describe('FilesRegistry — registry management', () => {
  it('remove() forgets a file so a later reference cannot resolve it', async () => {
    const { hooks, reg, warnings } = registry();
    const f = reg.add({ filename: 'a.png', mimeType: 'image/png', content: smallB64 });
    expect(reg.list()).toHaveLength(1);

    reg.remove(f.id);

    expect(reg.get(f.id)).toBeNull();
    expect(reg.list()).toEqual([]);
    await hooks.emit('onMessageResolve', {
      provider: 'mock',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', fileId: f.id } }] }],
    });
    expect(warnings.map((w) => w.code)).toContain('file_not_found');
  });

  it('removing an unknown id is harmless', () => {
    const { reg } = registry();
    expect(() => reg.remove('nope')).not.toThrow();
  });

  it('estimates the size of each content kind when none is given', () => {
    const { reg } = registry();
    const bytes = new Uint8Array(7);
    expect(reg.add({ filename: 'a', mimeType: 'application/octet-stream', content: { type: 'buffer', mimeType: 'application/octet-stream', data: bytes } }).sizeBytes).toBe(7);
    expect(reg.add({ filename: 'b', mimeType: 'text/plain', content: { type: 'blob', mimeType: 'text/plain', data: new Blob([bytes]) } }).sizeBytes).toBe(7);
    // base64 inflates by 4/3.
    expect(reg.add({ filename: 'c', mimeType: 'image/png', content: { type: 'base64', mimeType: 'image/png', data: 'AAAAAAAA' } }).sizeBytes).toBe(6);
    // A path or a URL is not read just to size it.
    expect(reg.add({ filename: 'd', mimeType: 'text/plain', content: { type: 'path', mimeType: 'text/plain', path: '/x' } }).sizeBytes).toBe(0);
    expect(reg.add({ filename: 'e', mimeType: 'image/png', content: { type: 'url', url: 'http://x/y.png' } }).sizeBytes).toBe(0);
  });

  it('an explicit sizeBytes wins over the estimate', () => {
    const { reg } = registry();
    expect(reg.add({ filename: 'a', mimeType: 'image/png', content: smallB64, sizeBytes: 999 }).sizeBytes).toBe(999);
  });

  it('destroy() unsubscribes, so later messages are left untouched', async () => {
    const { hooks, reg } = registry();
    reg.registerProvider('mock', adapter().adapter);
    const f = reg.add({ filename: 'a.png', mimeType: 'image/png', content: smallB64 });
    expect(hooks.handlerCount).toBe(2); // the warning listener plus the registry

    reg.destroy();
    expect(hooks.handlerCount).toBe(1);

    const ctx: MessageResolveContext = {
      provider: 'mock',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', fileId: f.id } }] }],
    };
    await hooks.emit('onMessageResolve', ctx);
    // The part is exactly as it was — nothing rewrote it.
    expect((ctx.messages[0].content as ContentPart[])[0]).toEqual({
      type: 'image',
      source: { type: 'file', fileId: f.id },
    });
  });

  it('destroy is idempotent', () => {
    const { reg } = registry();
    reg.destroy();
    reg.destroy();
  });
});

// ─── Remote operations ───────────────────────────────────────────────────────

describe('FilesRegistry — remote operations', () => {
  it('upload() records the remote id and announces it with a latency measurement', async () => {
    const { reg, warnings } = registry();
    const { adapter: a, calls } = adapter();
    reg.registerProvider('mock', a);
    const f = reg.add({ filename: 'a.png', mimeType: 'image/png', content: smallB64 });

    const remoteId = await reg.upload(f.id, 'mock');

    expect(remoteId).toBe('remote_1');
    expect(calls.uploads).toEqual([f.id]);
    expect(f.getRef('mock')).toBe('remote_1');

    const note = warnings.find((w) => w.code === 'file_uploaded');
    expect(note?.message).toBe('Uploaded a.png to mock: remote_1');
    expect(note?.details).toMatchObject({ fileId: f.id, provider: 'mock', remoteId: 'remote_1' });
    expect(typeof (note?.details as { latencyMs: number }).latencyMs).toBe('number');
  });

  it('upload() of an unknown file id throws before reaching any adapter', async () => {
    const { reg } = registry();
    const { adapter: a, calls } = adapter();
    reg.registerProvider('mock', a);
    await expect(reg.upload('no-such-file', 'mock')).rejects.toThrow('File not found: no-such-file');
    expect(calls.uploads).toEqual([]);
  });

  it('deleteRemote() deletes by ref and marks the provider copy gone', async () => {
    const { reg } = registry();
    const { adapter: a, calls } = adapter();
    reg.registerProvider('mock', a);
    const f = reg.add({ filename: 'a.png', mimeType: 'image/png', content: smallB64 });
    await reg.upload(f.id, 'mock');

    await reg.deleteRemote(f.id, 'mock');

    expect(calls.deletes).toEqual(['remote_1']);
    expect(f.uploads.get('mock')?.status).toBe('deleted');
    expect(f.getRef('mock')).toBeNull();
  });

  it('deleteRemote() is a no-op for an unknown file, an un-uploaded file, or an unknown provider', async () => {
    const { reg } = registry();
    const { adapter: a, calls } = adapter();
    reg.registerProvider('mock', a);
    const f = reg.add({ filename: 'a.png', mimeType: 'image/png', content: smallB64 });

    await reg.deleteRemote('no-such-file', 'mock'); // unknown file
    await reg.deleteRemote(f.id, 'mock'); // never uploaded → no ref
    await reg.upload(f.id, 'mock');
    await reg.deleteRemote(f.id, 'other-provider'); // no adapter for that provider

    expect(calls.deletes).toEqual([]);
    expect(f.uploads.get('mock')?.status).toBe('uploaded');
  });

  it('deleteRemote() ignores a ref for a provider whose adapter is not registered', async () => {
    // Upload state arrives from persistence too: a restored conversation can
    // name a provider this process never wired an adapter for.
    const { reg } = registry();
    const f = reg.add({ filename: 'a.png', mimeType: 'image/png', content: smallB64 });
    f.setUploaded('provider-from-a-previous-run', 'remote_x', null);

    await reg.deleteRemote(f.id, 'provider-from-a-previous-run');

    // No adapter, so nothing was called and nothing was marked deleted.
    expect(f.uploads.get('provider-from-a-previous-run')?.status).toBe('uploaded');
  });

  it('listRemote() delegates to the adapter, and is empty for an unregistered provider', async () => {
    const { reg } = registry();
    const { adapter: a, calls } = adapter();
    reg.registerProvider('mock', a);

    expect(await reg.listRemote('mock')).toHaveLength(1);
    expect(calls.lists).toBe(1);
    expect(await reg.listRemote('nobody')).toEqual([]);
    expect(calls.lists).toBe(1);
  });

  it('registering a provider twice replaces the adapter', async () => {
    const { reg } = registry();
    const first = adapter();
    const second = adapter();
    reg.registerProvider('mock', first.adapter);
    reg.registerProvider('mock', second.adapter);
    const f = reg.add({ filename: 'a.png', mimeType: 'image/png', content: smallB64 });

    await reg.upload(f.id, 'mock');

    expect(first.calls.uploads).toEqual([]);
    expect(second.calls.uploads).toEqual([f.id]);
  });
});

// ─── Message resolution ──────────────────────────────────────────────────────

function imageMessage(source: unknown): MessageResolveContext {
  return {
    provider: 'mock',
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'image', source } as ContentPart] }],
  };
}

const partOf = (ctx: MessageResolveContext): ContentPart =>
  (ctx.messages[0].content as ContentPart[])[0];

describe('FilesRegistry — resolving message parts', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orxa-files-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a registered file above the inline threshold becomes a provider_ref', async () => {
    const { hooks, reg } = registry();
    const { adapter: a, calls } = adapter();
    reg.registerProvider('mock', a);
    const f = reg.add({
      filename: 'big.png',
      mimeType: 'image/png',
      content: smallB64,
      sizeBytes: 100_000, // over the 50 KB inline threshold
    });

    const ctx = imageMessage({ type: 'file', fileId: f.id });
    await hooks.emit('onMessageResolve', ctx);

    expect(partOf(ctx)).toEqual({
      type: 'image',
      source: { type: 'provider_ref', mimeType: 'image/png', refId: 'remote_1' },
    });
    expect(calls.uploads).toHaveLength(1);
  });

  it('a non-image part keeps its own type when it becomes a provider_ref', async () => {
    const { hooks, reg } = registry();
    reg.registerProvider('mock', adapter().adapter);
    const f = reg.add({
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      content: { type: 'base64', mimeType: 'application/pdf', data: 'AAAA' },
      sizeBytes: 100_000,
    });

    const ctx: MessageResolveContext = {
      provider: 'mock',
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'document', source: { type: 'file', fileId: f.id } }] },
      ],
    };
    await hooks.emit('onMessageResolve', ctx);

    expect(partOf(ctx)).toEqual({
      type: 'document',
      source: { type: 'provider_ref', mimeType: 'application/pdf', refId: 'remote_1' },
    });
  });

  it('an already-uploaded file reuses its ref instead of uploading again', async () => {
    const { hooks, reg } = registry();
    const { adapter: a, calls } = adapter();
    reg.registerProvider('mock', a);
    const f = reg.add({
      filename: 'big.png',
      mimeType: 'image/png',
      content: smallB64,
      sizeBytes: 100_000,
    });
    await reg.upload(f.id, 'mock');

    await hooks.emit('onMessageResolve', imageMessage({ type: 'file', fileId: f.id }));

    expect(calls.uploads).toHaveLength(1);
  });

  it('an EXPIRED upload is re-uploaded rather than sent as a dead ref', async () => {
    const { hooks, reg } = registry();
    const { adapter: a, calls } = adapter();
    reg.registerProvider('mock', a);
    const f = reg.add({
      filename: 'big.png',
      mimeType: 'image/png',
      content: smallB64,
      sizeBytes: 100_000,
    });
    f.setUploaded('mock', 'stale_ref', Date.now() - 1);
    expect(f.isAvailable('mock')).toBe(false); // flips the state to expired

    const ctx = imageMessage({ type: 'file', fileId: f.id });
    await hooks.emit('onMessageResolve', ctx);

    expect(calls.uploads).toHaveLength(1);
    const src = (partOf(ctx) as { source: { refId: string } }).source;
    expect(src.refId).toBe('remote_1');
    expect(src.refId).not.toBe('stale_ref');
  });

  it('a small file is inlined as base64 rather than uploaded', async () => {
    const { hooks, reg } = registry();
    const { adapter: a, calls } = adapter();
    reg.registerProvider('mock', a);
    const f = reg.add({ filename: 'small.png', mimeType: 'image/png', content: smallB64 });

    const ctx = imageMessage({ type: 'file', fileId: f.id });
    await hooks.emit('onMessageResolve', ctx);

    expect(partOf(ctx)).toEqual({
      type: 'image',
      source: { type: 'base64', mimeType: 'image/png', data: 'AAAA' },
    });
    expect(calls.uploads).toEqual([]);
  });

  it('with NO adapter for the provider, an upload decision degrades to inline', async () => {
    const { hooks, reg } = registry();
    const f = reg.add({
      filename: 'big.png',
      mimeType: 'image/png',
      content: smallB64,
      sizeBytes: 100_000,
    });

    const ctx = imageMessage({ type: 'file', fileId: f.id });
    await hooks.emit('onMessageResolve', ctx);

    expect((partOf(ctx) as { source: { type: string } }).source.type).toBe('base64');
  });

  it('an adapter whose upload yields no usable ref falls back to inline', async () => {
    const { hooks, reg } = registry();
    const { adapter: a } = adapter({
      // Uploads "succeed" but the attachment is left with no live ref.
      upload: async () => ({ remoteId: 'r', expiresAt: Date.now() - 1 }),
    });
    reg.registerProvider('mock', a);
    const f = reg.add({
      filename: 'big.png',
      mimeType: 'image/png',
      content: smallB64,
      sizeBytes: 100_000,
    });

    const ctx = imageMessage({ type: 'file', fileId: f.id });
    await hooks.emit('onMessageResolve', ctx);

    expect((partOf(ctx) as { source: { type: string } }).source.type).toBe('base64');
  });

  it('a path source is read from disk, registered, and inlined', async () => {
    const path = join(dir, 'photo.png');
    writeFileSync(path, 'hello');
    const { hooks, reg } = registry();
    reg.registerProvider('mock', adapter().adapter);

    const ctx = imageMessage({ type: 'path', path, mimeType: 'image/png' });
    await hooks.emit('onMessageResolve', ctx);

    expect(partOf(ctx)).toEqual({
      type: 'image',
      source: { type: 'base64', mimeType: 'image/png', data: btoa('hello') },
    });
    // The file joined the registry under its basename and its real size.
    const added = reg.list();
    expect(added).toHaveLength(1);
    expect(added[0].filename).toBe('photo.png');
    expect(added[0].sizeBytes).toBe(5);
  });

  it('a buffer source is registered with its byte length and inlined', async () => {
    const { hooks, reg } = registry();
    reg.registerProvider('mock', adapter().adapter);

    const ctx = imageMessage({
      type: 'buffer',
      mimeType: 'image/png',
      data: new TextEncoder().encode('hello'),
    });
    await hooks.emit('onMessageResolve', ctx);

    expect((partOf(ctx) as { source: { data: string } }).source.data).toBe(btoa('hello'));
    expect(reg.list()[0].filename).toBe('buffer-file');
    expect(reg.list()[0].sizeBytes).toBe(5);
  });

  it('a url source the provider accepts is passed through as a url', async () => {
    const hooks = new HookBus();
    const reg = new FilesRegistry({ hooks, fetch: noopFetch });
    const f = reg.add({
      filename: 'a.png',
      mimeType: 'image/png',
      content: { type: 'url', url: 'https://cdn.example.com/a.png' },
      sizeBytes: 100_000,
    });

    const ctx: MessageResolveContext = {
      provider: 'openai', // openai and xai take direct URLs
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'file', fileId: f.id } }] },
      ],
    };
    await hooks.emit('onMessageResolve', ctx);

    expect(partOf(ctx)).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://cdn.example.com/a.png' },
    });
  });

  it('a url decision for content that is not a url falls back to inline', async () => {
    // Reachable through a custom strategy: 'url' is a decision, not a fact
    // about the content.
    const alwaysUrl: FileStrategy = { decide: (): FileDecision => ({ action: 'url', reason: 'test' }) };
    const { hooks, reg } = registry({ strategy: alwaysUrl });
    const f = reg.add({ filename: 'a.png', mimeType: 'image/png', content: smallB64 });

    const ctx = imageMessage({ type: 'file', fileId: f.id });
    await hooks.emit('onMessageResolve', ctx);

    expect((partOf(ctx) as { source: { type: string } }).source.type).toBe('base64');
  });

  it('a file the provider cannot take becomes a visible text note, not a dropped part', async () => {
    const { hooks, reg, warnings } = registry();
    const { adapter: a } = adapter({ supportedTypes: ['image/'] });
    reg.registerProvider('mock', a);
    const f = reg.add({
      filename: 'notes.pdf',
      mimeType: 'application/pdf',
      content: { type: 'base64', mimeType: 'application/pdf', data: 'AAAA' },
    });

    const ctx: MessageResolveContext = {
      provider: 'mock',
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'document', source: { type: 'file', fileId: f.id } }] },
      ],
    };
    await hooks.emit('onMessageResolve', ctx);

    expect(partOf(ctx)).toEqual({
      type: 'text',
      text: '[File notes.pdf skipped: mock does not support application/pdf]',
    });
    const skipped = warnings.find((w) => w.code === 'file_skipped');
    expect(skipped?.details).toMatchObject({ fileId: f.id, provider: 'mock' });
  });

  it('a file over the adapter size limit is skipped with the limit in the reason', async () => {
    const { hooks, reg } = registry();
    const { adapter: a } = adapter({ maxFileSize: 10 });
    reg.registerProvider('mock', a);
    const f = reg.add({
      filename: 'huge.png',
      mimeType: 'image/png',
      content: smallB64,
      sizeBytes: 5_000,
    });

    const ctx = imageMessage({ type: 'file', fileId: f.id });
    await hooks.emit('onMessageResolve', ctx);

    expect((partOf(ctx) as { text: string }).text).toBe(
      '[File huge.png skipped: File 5000B exceeds limit 10B]',
    );
  });

  it('an unknown file id leaves the part untouched and warns', async () => {
    const { hooks, reg, warnings } = registry();
    reg.registerProvider('mock', adapter().adapter);

    const ctx = imageMessage({ type: 'file', fileId: 'ghost' });
    await hooks.emit('onMessageResolve', ctx);

    expect(partOf(ctx)).toEqual({ type: 'image', source: { type: 'file', fileId: 'ghost' } });
    expect(warnings.find((w) => w.code === 'file_not_found')?.message).toBe(
      'File ghost not found in registry',
    );
  });
});

describe('FilesRegistry — which parts it touches at all', () => {
  it('leaves string content and non-file sources alone', async () => {
    const { hooks, reg } = registry();
    reg.registerProvider('mock', adapter().adapter);

    const messages = [
      { role: 'user' as const, content: 'just text' },
      {
        role: 'user' as const,
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
          { type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'AAAA' } },
          { type: 'image' },
        ] as ContentPart[],
      },
    ];
    const before = JSON.stringify(messages);

    await hooks.emit('onMessageResolve', { provider: 'mock', model: 'm', messages });

    expect(JSON.stringify(messages)).toBe(before);
  });

  it('rewrites every file part across every message, of every media kind', async () => {
    const { hooks, reg } = registry();
    reg.registerProvider('mock', adapter().adapter);
    const ids = (['image', 'document', 'audio', 'video'] as const).map((kind) =>
      reg.add({ filename: `${kind}.bin`, mimeType: `${kind}/x`, content: { type: 'base64', mimeType: `${kind}/x`, data: 'AAAA' } }),
    );

    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'image', source: { type: 'file', fileId: ids[0].id } },
          { type: 'document', source: { type: 'file', fileId: ids[1].id } },
        ] as ContentPart[],
      },
      {
        role: 'user' as const,
        content: [
          { type: 'audio', source: { type: 'file', fileId: ids[2].id } },
          { type: 'video', source: { type: 'file', fileId: ids[3].id } },
        ] as ContentPart[],
      },
    ];

    await hooks.emit('onMessageResolve', { provider: 'mock', model: 'm', messages });

    for (const msg of messages) {
      for (const part of msg.content as ContentPart[]) {
        expect((part as { source: { type: string } }).source.type).toBe('base64');
      }
    }
    // The part TYPE is preserved — an audio file must not arrive as an image.
    expect((messages[1].content as ContentPart[]).map((p) => p.type)).toEqual(['audio', 'video']);
  });

  it('passes the model info from the catalog to the strategy, so it can decide per model', async () => {
    const catalog = new ModelCatalog();
    catalog.set('mock', 'm', { pricing: {}, contextWindow: 1000 });
    const seen: Array<{ model: string; hasInfo: boolean; supports: boolean; maxSize: number }> = [];
    const spy: FileStrategy = {
      decide(ctx): FileDecision {
        seen.push({
          model: ctx.model,
          hasInfo: ctx.modelInfo !== null,
          supports: ctx.providerSupportsType,
          maxSize: ctx.providerMaxSize,
        });
        return { action: 'inline', reason: 'test' };
      },
    };
    const { hooks, reg } = registry({ strategy: spy, catalog });
    const f = reg.add({ filename: 'a.png', mimeType: 'image/png', content: smallB64 });

    await hooks.emit('onMessageResolve', imageMessage({ type: 'file', fileId: f.id }));

    expect(seen).toEqual([{ model: 'm', hasInfo: true, supports: true, maxSize: 500_000_000 }]);
  });

  it('tells the strategy whether the file is already uploaded, and whether that upload expired', async () => {
    const seen: Array<{ isUploaded: boolean; isExpired: boolean }> = [];
    const spy: FileStrategy = {
      decide(ctx): FileDecision {
        seen.push({ isUploaded: ctx.isUploaded, isExpired: ctx.isExpired });
        return { action: 'inline', reason: 'test' };
      },
    };
    const { hooks, reg } = registry({ strategy: spy });
    reg.registerProvider('mock', adapter().adapter);

    const fresh = reg.add({ filename: 'a.png', mimeType: 'image/png', content: smallB64 });
    const uploaded = reg.add({ filename: 'b.png', mimeType: 'image/png', content: smallB64 });
    uploaded.setUploaded('mock', 'remote_live', null);
    const expired = reg.add({ filename: 'c.png', mimeType: 'image/png', content: smallB64 });
    expired.setUploaded('mock', 'remote_stale', Date.now() - 1);

    await hooks.emit('onMessageResolve', {
      provider: 'mock',
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'file', fileId: fresh.id } },
            { type: 'image', source: { type: 'file', fileId: uploaded.id } },
            { type: 'image', source: { type: 'file', fileId: expired.id } },
          ] as ContentPart[],
        },
      ],
    });

    // Without these two facts the strategy cannot tell "upload it" from
    // "re-upload it" from "reuse the ref you already have".
    expect(seen).toEqual([
      { isUploaded: false, isExpired: false },
      { isUploaded: true, isExpired: false },
      { isUploaded: false, isExpired: true },
    ]);
  });

  it('with no adapter, the strategy is told the default size cap and that the type is fine', async () => {
    const seen: Array<{ supports: boolean; maxSize: number }> = [];
    const spy: FileStrategy = {
      decide(ctx): FileDecision {
        seen.push({ supports: ctx.providerSupportsType, maxSize: ctx.providerMaxSize });
        return { action: 'inline', reason: 'test' };
      },
    };
    const { hooks, reg } = registry({ strategy: spy });
    const f = reg.add({ filename: 'a.png', mimeType: 'image/png', content: smallB64 });

    await hooks.emit('onMessageResolve', imageMessage({ type: 'file', fileId: f.id }));

    expect(seen).toEqual([{ supports: true, maxSize: 500_000_000 }]);
  });
});
