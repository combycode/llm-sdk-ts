/** Anthropic file adapter — POST /v1/files (beta).
 *  All HTTP flows through the injected EngineFetch (NetworkEngine queue). */

import { isBrowser } from '../../../runtime/runtime';
import type { EngineFetch } from '../../../network/types';
import type { FileAttachment } from '../../../plugins/files/attachment';
import type {
  FileProviderAdapter,
  FileUploadResult,
  RemoteFileInfo,
} from '../../../plugins/files/provider-adapter';
import { ANTHROPIC_API_VERSION } from './constants';

export interface AnthropicFileAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class AnthropicFileAdapter implements FileProviderAdapter {
  readonly name = 'anthropic';
  readonly expiresAfter = null;
  readonly maxFileSize = 500_000_000;
  readonly supportedTypes = [
    'application/pdf',
    'text/plain',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
  ];

  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: AnthropicFileAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.anthropic.com';
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
      'anthropic-beta': 'files-api-2025-04-14',
    };
    if (isBrowser()) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    return headers;
  }

  async upload(file: FileAttachment, fetch: EngineFetch): Promise<FileUploadResult> {
    const data = await file.toBuffer();
    const form = new FormData();
    form.append('file', new Blob([data as BlobPart], { type: file.mimeType }), file.filename);

    const res = await fetch({
      url: `${this.baseURL}/v1/files`,
      method: 'POST',
      headers: this.authHeaders(),
      body: form,
      rawBody: true,
      provider: 'anthropic',
      model: 'files',
      responseType: 'json',
    });

    if (res.status >= 400) {
      throw new Error(`Anthropic file upload failed (${res.status}): ${JSON.stringify(res.body)}`);
    }

    const body = (res.body as Record<string, unknown>) ?? {};
    return { remoteId: body.id as string, expiresAt: null };
  }

  async delete(remoteId: string, fetch: EngineFetch): Promise<void> {
    await fetch({
      url: `${this.baseURL}/v1/files/${remoteId}`,
      method: 'DELETE',
      headers: this.authHeaders(),
      body: undefined,
      provider: 'anthropic',
      model: 'files',
      responseType: 'json',
    });
  }

  async getInfo(remoteId: string, fetch: EngineFetch): Promise<RemoteFileInfo | null> {
    const res = await fetch({
      url: `${this.baseURL}/v1/files/${remoteId}`,
      method: 'GET',
      headers: this.authHeaders(),
      body: undefined,
      provider: 'anthropic',
      model: 'files',
      responseType: 'json',
    });
    if (res.status >= 400) return null;
    const body = (res.body as Record<string, unknown>) ?? {};
    return {
      remoteId: body.id as string,
      filename: body.filename as string,
      sizeBytes: body.size_bytes as number,
      createdAt: new Date(body.created_at as string).getTime(),
    };
  }

  async list(fetch: EngineFetch): Promise<RemoteFileInfo[]> {
    const res = await fetch({
      url: `${this.baseURL}/v1/files`,
      method: 'GET',
      headers: this.authHeaders(),
      body: undefined,
      provider: 'anthropic',
      model: 'files',
      responseType: 'json',
    });
    if (res.status >= 400) return [];
    const body = (res.body as Record<string, unknown>) ?? {};
    const data = (body.data as Array<Record<string, unknown>>) ?? [];
    return data.map((f) => ({
      remoteId: f.id as string,
      filename: f.filename as string,
      sizeBytes: f.size_bytes as number,
      createdAt: new Date(f.created_at as string).getTime(),
    }));
  }
}
