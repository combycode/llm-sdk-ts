/** Retrieve the bytes of a hosted-tool output file (e.g. code-execution files).
 *
 *  A `FileOutput` may carry inline base64 `data` (Google), a `url` (OpenAI
 *  code-interpreter images), or an `id` fetched from the provider's files API
 *  (Anthropic, OpenAI container files). These helpers resolve all three into
 *  bytes — buffered (`retrieveFile` → Blob) or streamed (`streamFile` →
 *  ReadableStream, for large files piped straight to a sink).
 *
 *  All HTTP flows through the injected `EngineFetch` (auth, queue, cost, traces). */

import { isBrowser } from '../../runtime/runtime';
import { base64ToBytes } from '../../util/base64';
import { header } from '../../util/http';
import type { EngineFetch } from '../../network/types';
import type { ProviderName } from '../types/provider';
import type { FileOutput } from '../types/response';

export interface RetrieveContext {
  provider: ProviderName;
  apiKey: string;
  fetch: EngineFetch;
  /** Provider API base URL; defaults per provider when omitted. */
  baseURL?: string;
}

/** A retrieved file's bytes plus the metadata an end user needs to display and
 *  open it as an attachment (correct name + type). */
export interface RetrievedFile {
  blob: Blob;
  /** Filename (from Content-Disposition, else the FileOutput name). */
  name?: string;
  /** MIME type (from Content-Type, else the FileOutput mime). */
  mimeType: string;
  /** Size in bytes. */
  size: number;
}

/** A streamed file: its byte stream plus best-effort metadata (from the response
 *  headers). The stream itself carries only bytes — name/type/size come from here. */
export interface FileStream {
  stream: ReadableStream<Uint8Array>;
  name?: string;
  mimeType?: string;
  /** From Content-Length, when the provider sends it. */
  size?: number;
}

const DEFAULT_BASE: Record<ProviderName, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  xai: 'https://api.x.ai',
  google: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai/api',
};

const OCTET_STREAM = 'application/octet-stream';

/** Build the authenticated content-download request for a file fetched by id. */
function contentRequest(
  ctx: RetrieveContext,
  file: FileOutput,
): { url: string; headers: Record<string, string> } {
  const base = ctx.baseURL ?? DEFAULT_BASE[ctx.provider];
  const id = file.id as string;
  if (ctx.provider === 'anthropic') {
    return {
      url: `${base}/v1/files/${id}/content?beta=true`,
      headers: {
        'x-api-key': ctx.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
        accept: 'application/binary',
        // Enable CORS for direct browser requests (same header the completion
        // adapter sets); harmless on Node/Bun. Without it the browser blocks the
        // file download by CORS.
        ...(isBrowser() ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
      },
    };
  }
  if (ctx.provider === 'openai' || ctx.provider === 'xai' || ctx.provider === 'openrouter') {
    // Code-execution output files live inside a container.
    const containerId = file.ref?.containerId as string | undefined;
    const path = containerId
      ? `/v1/containers/${containerId}/files/${id}/content`
      : `/v1/files/${id}/content`;
    return { url: `${base}${path}`, headers: { authorization: `Bearer ${ctx.apiKey}` } };
  }
  if (ctx.provider === 'google') {
    return {
      url: `${base}/v1beta/files/${id}:download?alt=media`,
      headers: { 'x-goog-api-key': ctx.apiKey },
    };
  }
  throw new Error(`retrieveFile: no file-content endpoint for provider "${ctx.provider}"`);
}

/** Only send the provider's credentials to the provider's own host. */
function providerAuth(ctx: RetrieveContext, url: string): Record<string, string> {
  const base = ctx.baseURL ?? DEFAULT_BASE[ctx.provider];
  if (!url.startsWith(base)) return {};
  if (ctx.provider === 'anthropic') {
    return {
      'x-api-key': ctx.apiKey,
      'anthropic-version': '2023-06-01',
      ...(isBrowser() ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
    };
  }
  if (ctx.provider === 'google') return { 'x-goog-api-key': ctx.apiKey };
  return { authorization: `Bearer ${ctx.apiKey}` };
}

async function fetchFileResponse(
  ctx: RetrieveContext,
  file: FileOutput,
  responseType: 'arraybuffer' | 'stream',
) {
  if (file.url) {
    return ctx.fetch({
      url: file.url,
      method: 'GET',
      headers: providerAuth(ctx, file.url),
      body: undefined,
      provider: ctx.provider,
      model: 'files',
      responseType,
    });
  }
  if (file.id) {
    const { url, headers } = contentRequest(ctx, file);
    return ctx.fetch({
      url,
      method: 'GET',
      headers,
      body: undefined,
      provider: ctx.provider,
      model: 'files',
      responseType,
    });
  }
  throw new Error('retrieveFile: FileOutput has neither `data`, `url`, nor `id`');
}

/** Wrap bytes in a Blob via a concrete ArrayBuffer (a Uint8Array may be
 *  SharedArrayBuffer-backed, which isn't a valid BlobPart under strict DOM types). */
function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Blob([ab], { type });
}

function singleChunkStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain',
  json: 'application/json', xml: 'application/xml', html: 'text/html', md: 'text/markdown',
  pdf: 'application/pdf', zip: 'application/zip', parquet: 'application/vnd.apache.parquet',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Best-effort MIME from a filename extension (fallback when no Content-Type). */
function mimeFromName(name?: string): string | undefined {
  const ext = name?.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
  return ext ? EXT_MIME[ext] : undefined;
}

/** Filename from a Content-Disposition header. Prefers the RFC 5987
 *  `filename*=utf-8''<pct-encoded>` form (the real UTF-8 name) over `filename="…"`. */
function filenameFromDisposition(cd?: string): string | undefined {
  if (!cd) return undefined;
  const ext = cd.match(/filename\*=[^']*''([^;]+)/i);
  if (ext) {
    try {
      return decodeURIComponent(ext[1].trim());
    } catch {
      /* fall through to the plain filename */
    }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : undefined;
}

/** Fetch the whole file as bytes (buffered) plus its name/type/size. */
export async function retrieveFile(file: FileOutput, ctx: RetrieveContext): Promise<RetrievedFile> {
  if (file.data) {
    const blob = bytesToBlob(base64ToBytes(file.data), file.mimeType ?? OCTET_STREAM);
    return { blob, name: file.name, mimeType: blob.type, size: blob.size };
  }
  const res = await fetchFileResponse(ctx, file, 'arraybuffer');
  const headers = res.headers ?? {};
  const name = filenameFromDisposition(header(headers, 'content-disposition')) ?? file.name;
  const mimeType =
    header(headers, 'content-type')?.split(';')[0].trim() ||
    file.mimeType ||
    mimeFromName(name) ||
    OCTET_STREAM;
  const blob = new Blob([res.body as ArrayBuffer], { type: mimeType });
  return { blob, name, mimeType, size: blob.size };
}

/** Stream the file's bytes (un-buffered) plus best-effort name/type/size. Pipe the
 *  stream straight to a file, GridFS, or an HTTP response — nothing is buffered. */
export async function streamFile(file: FileOutput, ctx: RetrieveContext): Promise<FileStream> {
  if (file.data) {
    const bytes = base64ToBytes(file.data);
    return { stream: singleChunkStream(bytes), name: file.name, mimeType: file.mimeType, size: bytes.byteLength };
  }
  const res = await fetchFileResponse(ctx, file, 'stream');
  const headers = res.headers ?? {};
  const len = header(headers, 'content-length');
  const name = filenameFromDisposition(header(headers, 'content-disposition')) ?? file.name;
  return {
    stream: res.body as ReadableStream<Uint8Array>,
    name,
    mimeType:
      header(headers, 'content-type')?.split(';')[0].trim() || file.mimeType || mimeFromName(name),
    size: len ? Number(len) : undefined,
  };
}
