/** Google file adapter — resumable upload to Files API. 48h auto-delete.
 *  All HTTP flows through the injected EngineFetch (NetworkEngine queue). */

import type { EngineFetch } from '../../../network/types';
import type { FileAttachment } from '../../../plugins/files/attachment';
import type {
  FileProviderAdapter,
  FileUploadResult,
  RemoteFileInfo,
} from '../../../plugins/files/provider-adapter';

const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;

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

    const headers = startRes.headers ?? {};
    const uploadUrl =
      headers['x-goog-upload-url'] ?? headers['X-Goog-Upload-URL'] ?? headers['X-Goog-Upload-Url'];
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
    const name = remoteId.includes('/files/') ? remoteId.split('/files/').pop() : remoteId;
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
    const name = remoteId.includes('/files/') ? remoteId.split('/files/').pop() : remoteId;
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
