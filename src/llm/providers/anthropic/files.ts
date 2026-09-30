/** Anthropic file adapter — POST /v1/files (beta).
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
  FileUploadOptions,
} from '../../../plugins/files/provider-adapter';
import { ANTHROPIC_API_VERSION } from './constants';

export interface AnthropicFileAdapterConfig {
  apiKey: string;
  baseURL?: string;
  /** Workspace to act in, sent as `anthropic-workspace-id`. Only needed for a
   *  credential spanning several Workspaces; omitted from the request when
   *  unset. */
  workspaceId?: string;
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
  private readonly workspaceId?: string;

  constructor(config: AnthropicFileAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://api.anthropic.com';
    this.workspaceId = config.workspaceId;
  }

  /** File rules need no adapter handles. */
  private readonly wireRegistry: Registry = makeRegistry({});

  /** Build one file request from its spec, then add the engine metadata.
   *
   *  A multipart spec describes the FIELDS but not the bytes, so an upload passes
   *  its attachment in and the descriptor is filled here. `bodyKind: none` arrives
   *  as `noBody`; the engine wants the field simply absent. */
  private fromSpec(specId: string, input: object, file?: MultipartFile): HttpRequest {
    const built = buildFromSpec(serviceSpec(specId), input as never, this.wireRegistry, 'anthropic', undefined, { baseURL: this.baseURL, apiKey: this.apiKey, apiVersion: ANTHROPIC_API_VERSION, workspaceId: this.workspaceId }) as unknown as Record<string, unknown>;
    const { noBody, body, multipart, ...rest } = built;
    const form = multipart && file ? toFormData(multipart as MultipartField[], file) : undefined;
    return {
      ...rest,
      ...(form ? { body: form, rawBody: true } : noBody ? {} : { body }),
      provider: 'anthropic',
      model: 'files',
      responseType: 'json',
    } as HttpRequest;
  }

  buildUploadRequest(
    file: FileAttachment,
    data: Uint8Array,
    opts?: FileUploadOptions,
  ): HttpRequest {
    return this.fromSpec('anthropic/files.upload', { lifetimeSeconds: opts?.lifetimeSeconds }, {
      data,
      filename: file.filename,
      mimeType: file.mimeType,
    });
  }
  buildDeleteRequest(remoteId: string): HttpRequest {
    return this.fromSpec('anthropic/files.delete', { remoteId });
  }
  buildGetInfoRequest(remoteId: string): HttpRequest {
    return this.fromSpec('anthropic/files.getInfo', { remoteId });
  }
  buildListRequest(): HttpRequest {
    return this.fromSpec('anthropic/files.list', {});
  }

  async upload(
    file: FileAttachment,
    fetch: EngineFetch,
    opts?: FileUploadOptions,
  ): Promise<FileUploadResult> {
    const data = await file.toBuffer();
    const res = await fetch(this.buildUploadRequest(file, data, opts));

    if (res.status >= 400) {
      throw new Error(`Anthropic file upload failed (${res.status}): ${JSON.stringify(res.body)}`);
    }

    const body = (res.body as Record<string, unknown>) ?? {};
    // Anthropic returns an ISO STRING here, where OpenAI and xAI return unix
    // seconds. Measured, not assumed -- `expiresAt` used to be hardcoded null.
    const expiresAt =
      typeof body.expires_at === 'string' ? Date.parse(body.expires_at) || null : null;
    return { remoteId: body.id as string, expiresAt };
  }

  async delete(remoteId: string, fetch: EngineFetch): Promise<void> {
    await fetch(this.buildDeleteRequest(remoteId));
  }

  async getInfo(remoteId: string, fetch: EngineFetch): Promise<RemoteFileInfo | null> {
    const res = await fetch(this.buildGetInfoRequest(remoteId));
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
    const res = await fetch(this.buildListRequest());
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
