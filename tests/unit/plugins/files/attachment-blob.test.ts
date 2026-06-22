/** Browser-native Blob attachment source: FileAttachment.fromBlob + the 'blob'
 *  branch of toBuffer/toBase64. Works on Node/Bun too (Blob is a global). */

import { describe, expect, it } from 'bun:test';
import { FileAttachment } from '../../../../src/plugins/files/attachment';

describe('FileAttachment blob source', () => {
  it('fromBlob fills mimeType + sizeBytes from the Blob', () => {
    const blob = new Blob(['hello'], { type: 'text/plain' });
    const att = FileAttachment.fromBlob(blob);
    expect(att.mimeType).toContain('text/plain'); // runtime may append ;charset=utf-8
    expect(att.sizeBytes).toBe(5);
    expect(att.content.type).toBe('blob');
  });

  it('honors filename/mimeType overrides', () => {
    const att = FileAttachment.fromBlob(new Blob(['x']), {
      filename: 'note.txt',
      mimeType: 'text/markdown',
    });
    expect(att.filename).toBe('note.txt');
    expect(att.mimeType).toBe('text/markdown');
  });

  it('toBuffer round-trips the bytes', async () => {
    const att = FileAttachment.fromBlob(new Blob(['hi']));
    const bytes = await att.toBuffer();
    expect(new TextDecoder().decode(bytes)).toBe('hi');
  });

  it('toBase64 encodes the bytes', async () => {
    const att = FileAttachment.fromBlob(new Blob(['hi']));
    expect(await att.toBase64()).toBe(btoa('hi'));
  });
});
