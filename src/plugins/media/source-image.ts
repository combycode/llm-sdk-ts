/** Source/reference image handling for media edit + image-to-video.
 *
 *  Normalizes a DataSource (base64 / buffer / url / file-id) into a neutral
 *  shape, then each provider adapter maps it to its own wire field:
 *    - OpenAI: `{ image_url }` (data-URL) or `{ file_id }`
 *    - xAI:    `{ url }` (data-URL) or `{ file_id }`
 *    - Google: `inline_data {mime_type,data}` or `file_data {file_uri}` */

import type { DataSource } from '../../llm/types/messages';
import { base64ToBytes, bytesToBase64 } from '../../util/base64';
import { sniffImageMime } from '../../util/image-mime';

export interface NormalizedImageRef {
  /** Raw base64 (no `data:` prefix), when inline. */
  base64?: string;
  mimeType?: string;
  /** A remote URL, when the source is a URL. */
  url?: string;
  /** A provider Files-API id, when the source is an uploaded file. */
  fileId?: string;
}

/** Sniff a mime from a base64 string by decoding only its leading magic bytes.
 *  Decodes a 4-char-aligned prefix and swallows any decode error → undefined. */
function mimeFromBase64Prefix(b64: string): string | undefined {
  try {
    const n = Math.min(24, b64.length - (b64.length % 4));
    if (n < 4) return undefined;
    return sniffImageMime(base64ToBytes(b64.slice(0, n)));
  } catch {
    return undefined;
  }
}

/** Collapse any DataSource into base64 / url / fileId. The declared mime is
 *  cross-checked against the actual bytes (and corrected on mismatch) so a
 *  mislabeled source image — e.g. JPEG bytes tagged "image/png" — doesn't get
 *  rejected by strict validators downstream (Google Veo, OpenAI edits). */
export function normalizeImageSource(src: DataSource): NormalizedImageRef {
  switch (src.type) {
    case 'base64':
      return { base64: src.data, mimeType: mimeFromBase64Prefix(src.data) ?? src.mimeType };
    case 'buffer':
      return { base64: bytesToBase64(src.data), mimeType: sniffImageMime(src.data) ?? src.mimeType };
    case 'url':
      return { url: src.url };
    case 'file':
      return { fileId: src.fileId };
    case 'provider_ref':
      return { fileId: src.refId, mimeType: src.mimeType };
    case 'path':
      throw new Error(
        'media source image: `path` DataSource is not supported here — read the file and pass base64/buffer.',
      );
  }
}

/** Build a `data:<mime>;base64,…` URL (or pass a plain URL through). */
export function toDataUrl(ref: NormalizedImageRef): string {
  if (ref.url) return ref.url;
  if (ref.base64) return `data:${ref.mimeType ?? 'image/png'};base64,${ref.base64}`;
  throw new Error('media source image: needs inline base64 or a url (got a file id only).');
}

/** OpenAI image-ref object (`/v1/images/edits` images[], video input_reference). */
export function openaiImageRef(ref: NormalizedImageRef): Record<string, string> {
  return ref.fileId ? { file_id: ref.fileId } : { image_url: toDataUrl(ref) };
}

/** xAI image-ref object (`/v1/images/edits` image, video image). */
export function xaiImageRef(ref: NormalizedImageRef): Record<string, string> {
  return ref.fileId ? { file_id: ref.fileId } : { url: toDataUrl(ref) };
}

/** xAI video-ref object (`/v1/videos/extensions` + `/v1/videos/edits` `video`
 *  field) — `{ url }` (public URL or base64 data-URL) or `{ file_id }`. Kept
 *  separate from the image path so it doesn't run image mime-sniffing over
 *  video bytes; the video mime is taken from the DataSource as declared. */
export function xaiVideoRef(src: DataSource): { url: string } | { file_id: string } {
  switch (src.type) {
    case 'url':
      return { url: src.url };
    case 'file':
      return { file_id: src.fileId };
    case 'provider_ref':
      return { file_id: src.refId };
    case 'base64':
      return { url: `data:${src.mimeType};base64,${src.data}` };
    case 'buffer':
      return { url: `data:${src.mimeType};base64,${bytesToBase64(src.data)}` };
    case 'path':
      throw new Error(
        'media source video: `path` DataSource is not supported here — read the file and pass base64/buffer.',
      );
  }
}

/** Google generateContent image part (inline base64 or Files-API file_uri). */
export function googleImagePart(ref: NormalizedImageRef): Record<string, unknown> {
  const mimeType = ref.mimeType ?? 'image/png';
  if (ref.base64) return { inline_data: { mime_type: mimeType, data: ref.base64 } };
  const uri = ref.url ?? (ref.fileId as string);
  return { file_data: { file_uri: uri, mime_type: mimeType } };
}

/** Google Veo instance image (`:predictLongRunning` instances[].image).
 *  The predict API uses the Image proto — `bytesBase64Encoded` + `mimeType` —
 *  NOT the `inlineData` shape of generateContent (Veo rejects inlineData with a
 *  400). The Gemini Developer API accepts only inline bytes here (no gcsUri /
 *  file URI), so the URL fallback exists for Vertex-style callers only. */
export function googleVeoImage(ref: NormalizedImageRef): Record<string, unknown> {
  const mimeType = ref.mimeType ?? 'image/png';
  if (ref.base64) return { bytesBase64Encoded: ref.base64, mimeType };
  return { gcsUri: ref.url ?? ref.fileId, mimeType };
}
