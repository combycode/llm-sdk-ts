/** Conversation export as a ZIP archive — Markdown with media pulled OUT into
 *  separate files (`media/media-001.png`) and referenced by relative link,
 *  instead of inlined as multi-megabyte data-URLs.
 *
 *  The ZIP is written by hand in STORE mode (no compression) so the library
 *  keeps its zero-runtime-dependency promise — no `jszip`. Store mode is a
 *  trivial container (local headers + central directory + EOCD); media blobs
 *  (PNG/MP4/…) are already compressed, so store costs almost nothing. */

import type { Content, ContentPart, DataSource, Message } from '../llm/types/messages';
import { base64ToBytes } from '../util/base64';

export interface ConversationZipOptions {
  /** Document title (H1 at the top of the Markdown). */
  title?: string;
  /** Markdown file name inside the archive. Default 'conversation.md'. */
  markdownName?: string;
  /** Folder for extracted media. Default 'media'. */
  mediaDir?: string;
}

export interface ConversationZipResult {
  /** The .zip file bytes — wrap in a Blob to download. */
  bytes: Uint8Array;
  /** The Markdown document (also embedded in the zip), for preview/debug. */
  markdown: string;
  /** How many media files were extracted into the archive. */
  mediaCount: number;
}

/** Build a downloadable ZIP of the conversation: one Markdown file plus every
 *  embedded media blob as its own file under `media/`. */
export function conversationToZip(
  messages: Message[],
  opts: ConversationZipOptions = {},
): ConversationZipResult {
  const mediaDir = opts.mediaDir ?? 'media';
  const mdName = opts.markdownName ?? 'conversation.md';
  const enc = new TextEncoder();
  const files: ZipEntry[] = [];
  let counter = 0;

  // Sink: take raw media bytes, write them as a file, return the relative link.
  const sink = (bytes: Uint8Array, mime: string): string => {
    counter++;
    const name = `${mediaDir}/media-${String(counter).padStart(3, '0')}.${extOf(mime)}`;
    files.push({ name, bytes });
    return name;
  };

  const markdown = renderMarkdown(messages, opts.title, sink);
  // Markdown first so it sits at the top of the archive listing.
  files.unshift({ name: mdName, bytes: enc.encode(markdown) });
  return { bytes: buildZip(files), markdown, mediaCount: counter };
}

// ─── Markdown rendering (media → relative file link via sink) ─────────────

type MediaSink = (bytes: Uint8Array, mime: string) => string;

function renderMarkdown(messages: Message[], title: string | undefined, sink: MediaSink): string {
  const out: string[] = [];
  if (title) out.push(`# ${title}\n`);
  for (const m of messages) {
    out.push(`## ${m.role}\n`);
    out.push(renderContent(m.content, sink));
    out.push('');
  }
  return `${out.join('\n').trim()}\n`;
}

function renderContent(content: Content, sink: MediaSink): string {
  if (typeof content === 'string') return content;
  return content.map((p) => renderPart(p, sink)).join('\n\n');
}

function renderPart(part: ContentPart, sink: MediaSink): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'image':
      return mediaLink('image', part.source, sink);
    case 'audio':
      return mediaLink('audio', part.source, sink);
    case 'video':
      return mediaLink('video', part.source, sink);
    case 'document':
      return mediaLink('document', part.source, sink);
    case 'image_output':
    case 'audio_output':
    case 'video_output':
      return `[generated ${part.type.replace('_output', '')}: ${part.mediaId}]`;
    case 'tool_call':
      return `\`\`\`tool_call ${part.name}\n${JSON.stringify(part.arguments ?? {}, null, 2)}\n\`\`\``;
    case 'tool_result':
      return `\`\`\`tool_result\n${typeof part.content === 'string' ? part.content : JSON.stringify(part.content)}\n\`\`\``;
    default:
      return '';
  }
}

/** A media part → a Markdown link. Inline bytes (base64/buffer/data-URL) are
 *  extracted to a file via the sink and linked relatively; a remote/opaque URL
 *  is linked as-is; anything else degrades to a `[label]` placeholder. */
function mediaLink(label: string, src: DataSource, sink: MediaSink): string {
  const got = bytesOf(src);
  const href = got ? ('bytes' in got ? sink(got.bytes, got.mime) : got.url) : null;
  if (!href) return `[${label}]`;
  return label === 'image' ? `![image](${href})` : `[${label}](${href})`;
}

/** DataSource → raw bytes (+ mime) when embedded, else an external URL. */
function bytesOf(src: DataSource): { bytes: Uint8Array; mime: string } | { url: string } | null {
  switch (src.type) {
    case 'base64':
      return { bytes: base64ToBytes(src.data), mime: src.mimeType };
    case 'buffer':
      return { bytes: src.data, mime: src.mimeType };
    case 'url': {
      const m = /^data:(.*?);base64,(.*)$/.exec(src.url);
      return m ? { bytes: base64ToBytes(m[2]), mime: m[1] } : { url: src.url };
    }
    case 'path':
      return { url: src.path };
    case 'file':
      return { url: `file:${src.fileId}` };
    case 'provider_ref':
      return { url: `ref:${src.refId}` };
    default:
      return null;
  }
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
};

/** mime → file extension (subtype fallback, sanitized). */
function extOf(mime: string): string {
  const key = mime.toLowerCase().split(';')[0].trim();
  if (EXT[key]) return EXT[key];
  const sub = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key;
  return sub.replace(/[^a-z0-9]/g, '') || 'bin';
}

// ─── Minimal STORE-mode ZIP writer (no dependency) ────────────────────────

interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/** CRC-32 (IEEE 802.3) lookup table — required by the ZIP format. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed DOS timestamp (1980-01-01 00:00) keeps the writer deterministic and
// free of any clock dependency. Extractors don't care about the value.
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;
const UTF8_FLAG = 0x0800; // general-purpose bit 11: filenames are UTF-8

function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.bytes);
    const size = e.bytes.length;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size (== uncompressed for store)
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(name, 30);
    chunks.push(local, e.bytes);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attributes
    cv.setUint32(38, 0, true); // external attributes
    cv.setUint32(42, offset, true); // local header offset
    cd.set(name, 46);
    central.push(cd);

    offset += local.length + e.bytes.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) {
    chunks.push(c);
    centralSize += c.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(4, 0, true); // this disk
  ev.setUint16(6, 0, true); // disk with central dir
  ev.setUint16(8, central.length, true); // records on this disk
  ev.setUint16(10, central.length, true); // total records
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true); // comment length
  chunks.push(eocd);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
