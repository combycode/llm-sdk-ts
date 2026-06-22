import { describe, expect, it } from 'bun:test';
import { conversationToZip } from '../../../src/helpers/conversation-zip';
import type { Message } from '../../../src/llm/types/messages';

// ─── Independent ZIP reader (validates the writer without circular logic) ──

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ReadEntry {
  name: string;
  bytes: Uint8Array;
  crcOk: boolean;
  stored: boolean;
}

function readZip(buf: Uint8Array): ReadEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22; // no archive comment → EOCD is the last 22 bytes
  expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ReadEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50); // central header signature
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));

    expect(dv.getUint32(localOff, true)).toBe(0x04034b50); // local header signature
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtra = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtra;
    const bytes = buf.subarray(dataStart, dataStart + size);

    out.push({ name, bytes, crcOk: crc32(bytes) === crc, stored: method === 0 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('conversationToZip', () => {
  it('extracts media to files and links them relatively in the Markdown', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'aGk=' } },
        ],
      },
    ];
    const { bytes, markdown, mediaCount } = conversationToZip(msgs, { title: 'Chat' });

    expect(mediaCount).toBe(1);
    expect(markdown).toContain('# Chat');
    expect(markdown).toContain('look at this');
    expect(markdown).toContain('![image](media/media-001.png)');
    expect(markdown).not.toContain('data:image'); // NOT inlined

    const entries = readZip(bytes);
    expect(entries.map((e) => e.name).sort()).toEqual(['conversation.md', 'media/media-001.png']);
    for (const e of entries) {
      expect(e.stored).toBe(true);
      expect(e.crcOk).toBe(true);
    }
    // The extracted image is the decoded base64 ("hi" = 0x68,0x69).
    const img = entries.find((e) => e.name === 'media/media-001.png')!;
    expect([...img.bytes]).toEqual([0x68, 0x69]);
    // The markdown file round-trips to the returned string.
    const md = entries.find((e) => e.name === 'conversation.md')!;
    expect(new TextDecoder().decode(md.bytes)).toBe(markdown);
  });

  it('numbers multiple media sequentially and picks extensions by mime', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'image', source: { type: 'base64', mimeType: 'image/jpeg', data: 'AQID' } },
          { type: 'audio', source: { type: 'base64', mimeType: 'audio/wav', data: 'BAUG' } },
          { type: 'video', source: { type: 'buffer', mimeType: 'video/mp4', data: new Uint8Array([7, 8]) } },
        ],
      },
    ];
    const { markdown, mediaCount } = conversationToZip(msgs);
    expect(mediaCount).toBe(3);
    expect(markdown).toContain('![image](media/media-001.jpg)');
    expect(markdown).toContain('[audio](media/media-002.wav)');
    expect(markdown).toContain('[video](media/media-003.mp4)');
  });

  it('data-URL in a url source is extracted; a remote url stays a link', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: 'data:image/gif;base64,Zm9v' } },
          { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
        ],
      },
    ];
    const { markdown, mediaCount, bytes } = conversationToZip(msgs);
    expect(mediaCount).toBe(1); // only the data-URL became a file
    expect(markdown).toContain('![image](media/media-001.gif)');
    expect(markdown).toContain('![image](https://example.com/cat.png)');
    expect(readZip(bytes).length).toBe(2); // md + 1 extracted
  });

  it('produces a valid empty archive (markdown only) for a text-only chat', () => {
    const { bytes, mediaCount } = conversationToZip([{ role: 'user', content: 'hi' }]);
    expect(mediaCount).toBe(0);
    const entries = readZip(bytes);
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe('conversation.md');
    expect(entries[0].crcOk).toBe(true);
  });
});
