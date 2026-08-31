/** FileAttachment — content loading and the per-provider upload state machine.
 *
 *  One attachment can be uploaded to several providers at once, and each
 *  provider's remote id, expiry and failure are tracked separately. Blurring
 *  them means a file uploaded to Anthropic is offered to OpenAI as a
 *  provider_ref that only Anthropic can resolve.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileAttachment } from '../../../../src/plugins/files/attachment';

function make(content: ConstructorParameters<typeof FileAttachment>[0]['content']): FileAttachment {
  return new FileAttachment({
    filename: 'x.bin',
    mimeType: 'application/octet-stream',
    sizeBytes: 5,
    content,
  });
}

describe('FileAttachment — construction', () => {
  it('generates an id and a creation time, and defaults metadata to an empty object', () => {
    const before = Date.now();
    const f = make({ type: 'base64', mimeType: 'text/plain', data: 'AA' });
    expect(f.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.createdAt).toBeGreaterThanOrEqual(before);
    expect(f.metadata).toEqual({});
    expect(f.uploads.size).toBe(0);
  });

  it('an explicit id and metadata are kept verbatim', () => {
    const f = new FileAttachment({
      id: 'file_fixed',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      content: { type: 'base64', mimeType: 'application/pdf', data: 'AA' },
      metadata: { source: 'upload-form' },
    });
    expect(f.id).toBe('file_fixed');
    expect(f.metadata).toEqual({ source: 'upload-form' });
  });

  it('fromBlob takes filename, type and size from the Blob', () => {
    const blob = new Blob([new TextEncoder().encode('hello')], { type: 'image/png' });
    const f = FileAttachment.fromBlob(blob);
    expect(f.filename).toBe('file'); // a bare Blob has no name
    expect(f.mimeType).toBe('image/png');
    expect(f.sizeBytes).toBe(5);
    expect(f.content).toEqual({ type: 'blob', mimeType: 'image/png', data: blob });
  });

  it('fromBlob picks up a File name, and lets the caller override everything', () => {
    const file = new File([new TextEncoder().encode('hello')], 'notes.txt', {
      type: 'text/plain',
    });
    expect(FileAttachment.fromBlob(file).filename).toBe('notes.txt');

    const overridden = FileAttachment.fromBlob(file, {
      id: 'file_x',
      filename: 'renamed.txt',
      mimeType: 'application/custom',
      metadata: { k: 1 },
    });
    expect(overridden.id).toBe('file_x');
    expect(overridden.filename).toBe('renamed.txt');
    expect(overridden.mimeType).toBe('application/custom');
    expect(overridden.metadata).toEqual({ k: 1 });
    // The override reaches the stored content too, not just the label.
    expect((overridden.content as { mimeType: string }).mimeType).toBe('application/custom');
  });

  // KNOWN DEFECT (pinned as current behaviour, not endorsed).
  // The documented fallback is `blob.type ?? 'application/octet-stream'`, but a
  // type-less Blob reports '' rather than null/undefined, so `??` never fires
  // and the attachment carries an EMPTY mime type. Downstream,
  // DefaultFileStrategy asks `mimeType.startsWith(...)` against the provider's
  // supported types, which is false for '', so such a file is silently SKIPPED
  // with "provider does not support ". `||` instead of `??` is the fix.
  it('DEFECT: a type-less Blob yields an empty mime type, not octet-stream', () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const f = FileAttachment.fromBlob(blob);
    expect(f.mimeType).toBe('');
    expect((f.content as { mimeType: string }).mimeType).toBe('');
  });

  it('an explicit mimeType override is the way round the empty-type case', () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    expect(
      FileAttachment.fromBlob(blob, { mimeType: 'application/octet-stream' }).mimeType,
    ).toBe('application/octet-stream');
  });
});

describe('FileAttachment — per-provider upload state', () => {
  it('tracks each provider independently', () => {
    const f = make({ type: 'base64', mimeType: 'text/plain', data: 'AA' });
    f.setUploaded('anthropic', 'ant_1', null);

    expect(f.isAvailable('anthropic')).toBe(true);
    expect(f.getRef('anthropic')).toBe('ant_1');
    expect(f.isAvailable('openai')).toBe(false);
    expect(f.getRef('openai')).toBeNull();
    expect(f.needsUpload('openai')).toBe(true);
    expect(f.needsUpload('anthropic')).toBe(false);
  });

  it('an expiry in the future keeps the file available', () => {
    const f = make({ type: 'base64', mimeType: 'text/plain', data: 'AA' });
    f.setUploaded('p', 'r1', Date.now() + 3_600_000);
    expect(f.isAvailable('p')).toBe(true);
    expect(f.uploads.get('p')?.status).toBe('uploaded');
  });

  it('reading availability past the expiry flips the state to expired, and getRef then refuses', () => {
    const f = make({ type: 'base64', mimeType: 'text/plain', data: 'AA' });
    f.setUploaded('p', 'r1', Date.now() - 1);

    expect(f.isAvailable('p')).toBe(false);
    expect(f.uploads.get('p')?.status).toBe('expired');
    // The remote id is still recorded, but must not be handed out.
    expect(f.uploads.get('p')?.remoteId).toBe('r1');
    expect(f.getRef('p')).toBeNull();
    expect(f.needsUpload('p')).toBe(true);
  });

  it('setError records the failure and clears any remote id', () => {
    const f = make({ type: 'base64', mimeType: 'text/plain', data: 'AA' });
    f.setUploaded('p', 'r1', null);
    f.setError('p', 'upload rejected: 413');

    expect(f.uploads.get('p')).toEqual({
      provider: 'p',
      status: 'error',
      remoteId: null,
      uploadedAt: null,
      expiresAt: null,
      error: 'upload rejected: 413',
    });
    expect(f.isAvailable('p')).toBe(false);
    expect(f.getRef('p')).toBeNull();
  });

  it('setDeleted marks the provider copy gone without losing its remote id', () => {
    const f = make({ type: 'base64', mimeType: 'text/plain', data: 'AA' });
    f.setUploaded('p', 'r1', null);
    f.setDeleted('p');

    expect(f.uploads.get('p')?.status).toBe('deleted');
    expect(f.uploads.get('p')?.remoteId).toBe('r1');
    expect(f.isAvailable('p')).toBe(false);
    expect(f.needsUpload('p')).toBe(true);
  });

  it('setDeleted for a provider that was never uploaded to is a no-op', () => {
    const f = make({ type: 'base64', mimeType: 'text/plain', data: 'AA' });
    f.setDeleted('never');
    expect(f.uploads.has('never')).toBe(false);
  });

  it('re-uploading replaces the previous state for that provider', () => {
    const f = make({ type: 'base64', mimeType: 'text/plain', data: 'AA' });
    f.setError('p', 'first attempt failed');
    f.setUploaded('p', 'r2', null);

    expect(f.uploads.size).toBe(1);
    expect(f.uploads.get('p')?.error).toBeNull();
    expect(f.getRef('p')).toBe('r2');
  });
});

describe('FileAttachment — content loading', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orxa-attach-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const bytes = new TextEncoder().encode('hello');
  const b64 = btoa('hello');

  it('base64 content round-trips both ways', async () => {
    const f = make({ type: 'base64', mimeType: 'text/plain', data: b64 });
    expect(await f.toBase64()).toBe(b64);
    expect(await f.toBuffer()).toEqual(bytes);
  });

  it('buffer content round-trips both ways', async () => {
    const f = make({ type: 'buffer', mimeType: 'text/plain', data: bytes });
    expect(await f.toBase64()).toBe(b64);
    expect(await f.toBuffer()).toBe(bytes);
  });

  it('blob content round-trips both ways', async () => {
    const f = make({
      type: 'blob',
      mimeType: 'text/plain',
      data: new Blob([bytes], { type: 'text/plain' }),
    });
    expect(await f.toBase64()).toBe(b64);
    expect(await f.toBuffer()).toEqual(bytes);
  });

  it('path content is read from disk both ways', async () => {
    const path = join(dir, 'hello.txt');
    writeFileSync(path, 'hello');
    const f = make({ type: 'path', mimeType: 'text/plain', path });

    expect(await f.toBase64()).toBe(b64);
    expect(await f.toBuffer()).toEqual(bytes);
  });

  it('a path that does not exist surfaces the read error rather than empty content', async () => {
    const f = make({ type: 'path', mimeType: 'text/plain', path: join(dir, 'absent.txt') });
    await expect(f.toBase64()).rejects.toThrow();
    await expect(f.toBuffer()).rejects.toThrow();
  });

  it('url content refuses to materialise itself, and says why', async () => {
    // Loading it would be an un-queued HTTP call from inside a value object;
    // fetching belongs to the caller, which has the engine fetch.
    const f = make({ type: 'url', url: 'https://example.com/a.png', mimeType: 'image/png' });
    await expect(f.toBase64()).rejects.toThrow('Cannot convert URL content to base64');
    await expect(f.toBuffer()).rejects.toThrow('Cannot load URL content without fetching');
  });
});

describe('FileAttachment — export', () => {
  it('is a plain snapshot: uploads flattened, metadata copied', () => {
    const f = new FileAttachment({
      id: 'file_1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 42,
      content: { type: 'base64', mimeType: 'application/pdf', data: 'AA' },
      metadata: { tag: 'q3' },
    });
    f.setUploaded('anthropic', 'ant_1', null);
    f.setError('openai', 'too big');

    const snap = f.export();

    expect(snap.id).toBe('file_1');
    expect(snap.filename).toBe('report.pdf');
    expect(snap.mimeType).toBe('application/pdf');
    expect(snap.sizeBytes).toBe(42);
    expect(snap.createdAt).toBe(f.createdAt);
    expect(snap.metadata).toEqual({ tag: 'q3' });
    expect(snap.uploads.map((u) => [u.provider, u.status])).toEqual([
      ['anthropic', 'uploaded'],
      ['openai', 'error'],
    ]);
    // The snapshot deliberately omits the bytes.
    expect('content' in snap).toBe(false);
  });

  it('mutating the snapshot cannot reach back into the attachment', () => {
    const f = make({ type: 'base64', mimeType: 'text/plain', data: 'AA' });
    f.setUploaded('p', 'r1', null);

    const snap = f.export();
    snap.metadata.injected = true;
    snap.uploads.length = 0;

    expect(f.metadata).toEqual({});
    expect(f.uploads.size).toBe(1);
  });
});
