/** Google file adapter — resumable upload to Files API. 48h auto-delete.
 *  All HTTP flows through the injected EngineFetch (NetworkEngine queue). */

import type { EngineFetch } from '../../../network/types';
import { header } from '../../../util/http';
import type { FileAttachment } from '../../../plugins/files/attachment';
import type {
  FileProviderAdapter,
  FileUploadResult,
  RemoteFileInfo,
} from '../../../plugins/files/provider-adapter';

const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;

/** Reduce any form of Google file id to the bare name the REST path wants.
 *
 *  Three forms reach this, and only two used to work:
 *
 *    https://.../v1beta/files/abc  the `uri` this adapter hands back from
 *                                 upload() and list() — matched on `/files/`
 *    abc                          a bare name — passed through
 *    files/abc                    Google's CANONICAL resource name, the `name`
 *                                 field its own API returns
 *
 *  The third fell through the `/files/` test (no leading slash) and produced
 *  `/v1beta/files/files/abc` — a 404. It never broke this library's own
 *  round-trip, because upload() and list() return the `uri`; it broke the
 *  moment a caller passed the id Google itself gave them. */
export function googleFileName(remoteId: string): string {
  if (remoteId.includes('/files/')) return remoteId.split('/files/').pop() ?? remoteId;
  if (remoteId.startsWith('files/')) return remoteId.slice('files/'.length);
  return remoteId;
}

export interface GoogleFileAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class GoogleFileAdapter implements FileProviderAdapter {
  readonly name = 'google';
  readonly expiresAfter = FORTY_EIGHT_HOURS;
  readonly maxFileSize = 2_000_000_000;
  readonly supportedTypes = null;

  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: GoogleFileAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://generativelanguage.googleapis.com';
  }

  async upload(file: FileAttachment, fetch: EngineFetch): Promise<FileUploadResult> {
    const data = await file.toBuffer();

    const startRes = await fetch({
      url: `${this.baseURL}/upload/v1beta/files?key=${this.apiKey}`,
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(data.length),
        'X-Goog-Upload-Header-Content-Type': file.mimeType,
        'Content-Type': 'application/json',
      },
      body: { file: { display_name: file.filename } },
      provider: 'google',
      model: 'files',
      responseType: 'json',
    });

    if (startRes.status >= 400) {
      throw new Error(
        `Google file upload start failed (${startRes.status}): ${JSON.stringify(startRes.body)}`,
      );
    }

    // Header names are case-insensitive; guessing three casings still missed any
    // fourth one the server or runtime might send (e.g. `X-GOOG-UPLOAD-URL`).
    const uploadUrl = header(startRes.headers ?? {}, 'x-goog-upload-url');
    if (!uploadUrl) throw new Error('No upload URL returned from Google');

    const uploadRes = await fetch({
      url: uploadUrl,
      method: 'POST',
      headers: {
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
        'Content-Type': file.mimeType,
      },
      body: data,
      rawBody: true,
      provider: 'google',
      model: 'files',
      responseType: 'json',
    });

    if (uploadRes.status >= 400) {
      throw new Error(
        `Google file upload failed (${uploadRes.status}): ${JSON.stringify(uploadRes.body)}`,
      );
    }

    const body = (uploadRes.body as Record<string, unknown>) ?? {};
    const fileObj = (body.file as Record<string, unknown>) ?? body;
    const uri = fileObj.uri as string;
    const expirationTime = fileObj.expirationTime as string | undefined;

    return {
      remoteId: uri,
      expiresAt: expirationTime
        ? new Date(expirationTime).getTime()
        : Date.now() + FORTY_EIGHT_HOURS,
    };
  }

  async delete(remoteId: string, fetch: EngineFetch): Promise<void> {
    const name = googleFileName(remoteId);
    await fetch({
      url: `${this.baseURL}/v1beta/files/${name}?key=${this.apiKey}`,
      method: 'DELETE',
      headers: {},
      body: undefined,
      provider: 'google',
      model: 'files',
      responseType: 'json',
    });
  }

  async getInfo(remoteId: string, fetch: EngineFetch): Promise<RemoteFileInfo | null> {
    const name = googleFileName(remoteId);
    const res = await fetch({
      url: `${this.baseURL}/v1beta/files/${name}?key=${this.apiKey}`,
      method: 'GET',
      headers: {},
      body: undefined,
      provider: 'google',
      model: 'files',
      responseType: 'json',
    });
    if (res.status >= 400) return null;
    const body = (res.body as Record<string, unknown>) ?? {};
    return {
      remoteId: body.uri as string,
      filename: (body.displayName as string) ?? '',
      sizeBytes: Number.parseInt((body.sizeBytes as string) ?? '0', 10),
      createdAt: new Date(body.createTime as string).getTime(),
      expiresAt: body.expirationTime
        ? new Date(body.expirationTime as string).getTime()
        : undefined,
    };
  }

  async list(fetch: EngineFetch): Promise<RemoteFileInfo[]> {
    const res = await fetch({
      url: `${this.baseURL}/v1beta/files?key=${this.apiKey}&pageSize=100`,
      method: 'GET',
      headers: {},
      body: undefined,
      provider: 'google',
      model: 'files',
      responseType: 'json',
    });
    if (res.status >= 400) return [];
    const body = (res.body as Record<string, unknown>) ?? {};
    const files = (body.files as Array<Record<string, unknown>>) ?? [];
    return files.map((f) => ({
      remoteId: f.uri as string,
      filename: (f.displayName as string) ?? '',
      sizeBytes: Number.parseInt((f.sizeBytes as string) ?? '0', 10),
      createdAt: new Date(f.createTime as string).getTime(),
      expiresAt: f.expirationTime ? new Date(f.expirationTime as string).getTime() : undefined,
    }));
  }
}
