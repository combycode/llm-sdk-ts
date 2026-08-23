/** Google file adapter — resumable upload to Files API. 48h auto-delete.
 *  All HTTP flows through the injected EngineFetch (NetworkEngine queue). */

import { buildFromSpec } from '../../../wire/interpreter';
import type { MultipartField, Registry } from '../../../wire/interpreter';
import { serviceSpec } from '../../../wire/service-specs';
import { makeRegistry } from '../../wire-transforms';
import { toFormData, type MultipartFile } from '../../wire-multipart';
import type { EngineFetch, HttpRequest } from '../../../network/types';
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

  /** File rules need no adapter handles. */
  private readonly wireRegistry: Registry = makeRegistry({});

  /** Build one file request from its spec, then add the engine metadata.
   *
   *  A multipart spec describes the FIELDS but not the bytes, so an upload passes
   *  its attachment in and the descriptor is filled here. `bodyKind: none` arrives
   *  as `noBody`; the engine wants the field simply absent. */
  private fromSpec(specId: string, input: object, file?: MultipartFile): HttpRequest {
    const built = buildFromSpec(serviceSpec(specId), input as never, this.wireRegistry, 'google', undefined, { baseURL: this.baseURL, apiKey: this.apiKey }) as unknown as Record<string, unknown>;
    const { noBody, body, multipart, ...rest } = built;
    const form = multipart && file ? toFormData(multipart as MultipartField[], file) : undefined;
    return {
      ...rest,
      ...(form ? { body: form, rawBody: true } : noBody ? {} : { body }),
      provider: 'google',
      model: 'files',
      responseType: 'json',
    } as HttpRequest;
  }

  /** Step ONE of the resumable upload. The second call goes to a URL the server
   *  returns in a response header, so no spec can describe it — it stays here. */
  buildStartUploadRequest(file: FileAttachment, byteLength: number): HttpRequest {
    return this.fromSpec('google/files.startUpload', {
      filename: file.filename,
      mimeType: file.mimeType,
      byteLength,
    });
  }
  buildDeleteRequest(remoteId: string): HttpRequest {
    return this.fromSpec('google/files.delete', { name: googleFileName(remoteId) });
  }
  buildGetInfoRequest(remoteId: string): HttpRequest {
    return this.fromSpec('google/files.getInfo', { name: googleFileName(remoteId) });
  }
  buildListRequest(): HttpRequest {
    return this.fromSpec('google/files.list', {});
  }

  async upload(file: FileAttachment, fetch: EngineFetch): Promise<FileUploadResult> {
    const data = await file.toBuffer();

    const startRes = await fetch(this.buildStartUploadRequest(file, data.length));

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
    const _name = googleFileName(remoteId);
    await fetch(this.buildDeleteRequest(remoteId));
  }

  async getInfo(remoteId: string, fetch: EngineFetch): Promise<RemoteFileInfo | null> {
    const _name = googleFileName(remoteId);
    const res = await fetch(this.buildGetInfoRequest(remoteId));
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
    const res = await fetch(this.buildListRequest());
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
