/** xAI file adapter — POST /v1/files (purpose=assistants).
 *  All HTTP flows through the injected EngineFetch (NetworkEngine queue). */

import type { EngineFetch } from '../../../network/types';
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

  private bearer(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  async upload(file: FileAttachment, fetch: EngineFetch): Promise<FileUploadResult> {
    const data = await file.toBuffer();
    const form = new FormData();
    form.append('file', new Blob([data as BlobPart], { type: file.mimeType }), file.filename);
    form.append('purpose', 'assistants');

    const res = await fetch({
      url: `${this.baseURL}/v1/files`,
      method: 'POST',
      headers: this.bearer(),
      body: form,
      rawBody: true,
      provider: 'xai',
      model: 'files',
      responseType: 'json',
    });

    if (res.status >= 400) {
      throw new Error(`xAI file upload failed (${res.status}): ${JSON.stringify(res.body)}`);
    }

    const body = (res.body as Record<string, unknown>) ?? {};
    return { remoteId: body.id as string, expiresAt: null };
  }

  async delete(remoteId: string, fetch: EngineFetch): Promise<void> {
    await fetch({
      url: `${this.baseURL}/v1/files/${remoteId}`,
      method: 'DELETE',
      headers: this.bearer(),
      body: undefined,
      provider: 'xai',
      model: 'files',
      responseType: 'json',
    });
  }

  async getInfo(remoteId: string, fetch: EngineFetch): Promise<RemoteFileInfo | null> {
    const res = await fetch({
      url: `${this.baseURL}/v1/files/${remoteId}`,
      method: 'GET',
      headers: this.bearer(),
      body: undefined,
      provider: 'xai',
      model: 'files',
      responseType: 'json',
    });
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
    const res = await fetch({
      url: `${this.baseURL}/v1/files`,
      method: 'GET',
      headers: this.bearer(),
      body: undefined,
      provider: 'xai',
      model: 'files',
      responseType: 'json',
    });
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
