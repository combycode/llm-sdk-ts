/** xAI file adapter — POST /v1/files (purpose=assistants).
 *  All HTTP flows through the injected EngineFetch (NetworkEngine queue). */

import { buildFromSpec } from '../../../wire/interpreter';
import type { MultipartField, Registry } from '../../../wire/interpreter';
import { serviceSpec } from '../../../wire/service-specs';
import { makeRegistry } from '../../wire-transforms';
import { toFormData, type MultipartFile } from '../../wire-multipart';
import type { EngineFetch, HttpRequest } from '../../../network/types';
import type { FileAttachment } from '../../../plugins/files/attachment';
import type {
  FileProviderAdapter,
  FileUploadResult,
  RemoteFileInfo,
} from '../../../plugins/files/provider-adapter';

export interface XAIFileAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class XAIFileAdapter implements FileProviderAdapter {
  readonly name = 'xai';
  readonly expiresAfter = null;
  readonly maxFileSize = 48_000_000;
  readonly supportedTypes = [
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
    'application/pdf',
  ];

  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: XAIFileAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.x.ai';
  }


  /** File rules need no adapter handles. */
  private readonly wireRegistry: Registry = makeRegistry({});

  /** Build one file request from its spec, then add the engine metadata.
   *
   *  A multipart spec describes the FIELDS but not the bytes, so an upload passes
   *  its attachment in and the descriptor is filled here. `bodyKind: none` arrives
   *  as `noBody`; the engine wants the field simply absent. */
  private async fromSpec(
    specId: string,
    input: object,
    file?: MultipartFile,
  ): Promise<HttpRequest> {
    const built = buildFromSpec(serviceSpec(specId), input as never, this.wireRegistry, 'xai', undefined, { baseURL: this.baseURL, apiKey: this.apiKey }) as unknown as Record<string, unknown>;
    const { noBody, body, multipart, ...rest } = built;
    const form =
      multipart && file ? toFormData(multipart as MultipartField[], file) : undefined;
    return {
      ...rest,
      ...(form ? { body: form, rawBody: true } : noBody ? {} : { body }),
      provider: 'xai',
      model: 'files',
      responseType: 'json',
    } as HttpRequest;
  }

  buildUploadRequest(file: FileAttachment, data: Uint8Array): Promise<HttpRequest> {
    return this.fromSpec('xai/files.upload', {}, {
      data,
      filename: file.filename,
      mimeType: file.mimeType,
    });
  }
  buildDeleteRequest(remoteId: string): Promise<HttpRequest> {
    return this.fromSpec('xai/files.delete', { remoteId });
  }
  buildGetInfoRequest(remoteId: string): Promise<HttpRequest> {
    return this.fromSpec('xai/files.getInfo', { remoteId });
  }
  buildListRequest(): Promise<HttpRequest> {
    return this.fromSpec('xai/files.list', {});
  }

  async upload(file: FileAttachment, fetch: EngineFetch): Promise<FileUploadResult> {
    const data = await file.toBuffer();
    const res = await fetch(await this.buildUploadRequest(file, data));

    if (res.status >= 400) {
      throw new Error(`xAI file upload failed (${res.status}): ${JSON.stringify(res.body)}`);
    }

    const body = (res.body as Record<string, unknown>) ?? {};
    return { remoteId: body.id as string, expiresAt: null };
  }

  async delete(remoteId: string, fetch: EngineFetch): Promise<void> {
    await fetch(await this.buildDeleteRequest(remoteId));
  }

  async getInfo(remoteId: string, fetch: EngineFetch): Promise<RemoteFileInfo | null> {
    const res = await fetch(await this.buildGetInfoRequest(remoteId));
    if (res.status >= 400) return null;
    const body = (res.body as Record<string, unknown>) ?? {};
    return {
      remoteId: body.id as string,
      filename: body.filename as string,
      sizeBytes: body.bytes as number,
      createdAt: (body.created_at as number) * 1000,
    };
  }

  async list(fetch: EngineFetch): Promise<RemoteFileInfo[]> {
    const res = await fetch(await this.buildListRequest());
    if (res.status >= 400) return [];
    const body = (res.body as Record<string, unknown>) ?? {};
    const data = (body.data as Array<Record<string, unknown>>) ?? [];
    return data.map((f) => ({
      remoteId: f.id as string,
      filename: f.filename as string,
      sizeBytes: f.bytes as number,
      createdAt: (f.created_at as number) * 1000,
    }));
  }
}
