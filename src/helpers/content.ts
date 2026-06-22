/** Content helpers — small builders for inline message parts.
 *
 *  loadImageContent does the dirty work of fetching / reading / base64-
 *  encoding / mime-detecting an image and returns a ready-to-send
 *  `ContentPart` (type: 'image', source: { type: 'base64', mimeType, data }).
 *
 *  Accepts:
 *    - string starting with 'http://' or 'https://' → fetch
 *    - any other string                              → read from disk
 *    - Uint8Array                                    → use bytes directly
 *
 *  Mime is auto-detected from URL extension OR file extension OR magic
 *  bytes (PNG / JPEG / GIF / WebP) when neither path applies. */

import { nodeFsPromises } from '../runtime/runtime';
import { bytesToBase64 } from '../util/base64';
import type { ContentPart } from '../llm/types/messages';

/** Lowercased file extension incl. the dot (e.g. '.png'), or '' if none.
 *  Pure + browser-safe — avoids pulling node:path onto the bundle path. */
function extOf(p: string): string {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const dot = p.lastIndexOf('.');
  return dot > slash ? p.slice(dot).toLowerCase() : '';
}

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

export interface LoadImageOptions {
  /** Optional override for the auto-detected mime type. */
  mimeType?: string;
  /** Optional User-Agent for URL fetches (some hosts e.g. Wikipedia 429 the default). */
  userAgent?: string;
}

export async function loadImageContent(
  source: string | Uint8Array,
  options: LoadImageOptions = {},
): Promise<ContentPart> {
  const { bytes, mimeType } = await loadBytes(source, options);
  return {
    type: 'image',
    source: { type: 'base64', mimeType, data: bytesToBase64(bytes) },
  };
}

/** Load any inline content part (image / PDF document / audio / video), choosing
 *  the part type from the detected MIME. Use this for mixed attachments;
 *  `loadImageContent` forces an image part. */
export async function loadContent(
  source: string | Uint8Array,
  options: LoadImageOptions = {},
): Promise<ContentPart> {
  const { bytes, mimeType } = await loadBytes(source, options);
  const src = { type: 'base64' as const, mimeType, data: bytesToBase64(bytes) };
  if (mimeType === 'application/pdf' || mimeType === 'text/plain')
    return { type: 'document', source: src };
  if (mimeType.startsWith('audio/')) return { type: 'audio', source: src };
  if (mimeType.startsWith('video/')) return { type: 'video', source: src };
  return { type: 'image', source: src };
}

async function loadBytes(
  source: string | Uint8Array,
  options: LoadImageOptions,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (source instanceof Uint8Array) {
    return {
      bytes: source,
      mimeType: options.mimeType ?? detectMimeFromBytes(source) ?? 'image/png',
    };
  }
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const headers: Record<string, string> = options.userAgent
      ? { 'user-agent': options.userAgent }
      : {};
    const res = await fetch(source, { headers });
    if (!res.ok) throw new Error(`loadImageContent: fetch failed (${res.status}) for ${source}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime =
      options.mimeType ??
      mimeFromUrl(source) ??
      res.headers.get('content-type') ??
      detectMimeFromBytes(bytes) ??
      'image/png';
    return { bytes, mimeType: mime };
  }
  // Filesystem path (Node/Bun only — throws a friendly error in the browser).
  const { readFile } = await nodeFsPromises();
  const buf = await readFile(source);
  const bytes = new Uint8Array(buf);
  const mime =
    options.mimeType ?? EXT_TO_MIME[extOf(source)] ?? detectMimeFromBytes(bytes) ?? 'image/png';
  return { bytes, mimeType: mime };
}

function mimeFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return EXT_TO_MIME[extOf(u.pathname)] ?? null;
  } catch {
    return null;
  }
}

function detectMimeFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // GIF: 47 49 46 38
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  // RIFF container: WEBP (image) or WAVE (audio).
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return 'image/webp';
    }
    if (bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) {
      return 'audio/wav';
    }
  }
  // PDF: %PDF
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf';
  }
  // MP3: ID3 tag or MPEG frame sync (FF Ex/Fx).
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'audio/mpeg';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}
