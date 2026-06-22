/** FileAttachment — represents a file with upload state tracking per provider. */

import { nodeFsPromises } from '../../runtime/runtime';
import { base64ToBytes, bytesToBase64 } from '../../util/base64';

export type FileContent =
  | { type: 'buffer'; mimeType: string; data: Uint8Array }
  | { type: 'path'; mimeType: string; path: string }
  | { type: 'blob'; mimeType: string; data: Blob }
  | { type: 'url'; url: string; mimeType?: string }
  | { type: 'base64'; mimeType: string; data: string };

export interface FileUploadState {
  provider: string;
  status: 'pending' | 'uploaded' | 'expired' | 'deleted' | 'error';
  remoteId: string | null;
  uploadedAt: number | null;
  expiresAt: number | null;
  error: string | null;
}

export interface FileAttachmentSnapshot {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploads: Array<Omit<FileUploadState, 'provider'> & { provider: string }>;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export class FileAttachment {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly content: FileContent;
  readonly createdAt: number;
  readonly metadata: Record<string, unknown>;
  readonly uploads = new Map<string, FileUploadState>();

  constructor(opts: {
    id?: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    content: FileContent;
    metadata?: Record<string, unknown>;
  }) {
    this.id = opts.id ?? crypto.randomUUID();
    this.filename = opts.filename;
    this.mimeType = opts.mimeType;
    this.sizeBytes = opts.sizeBytes;
    this.content = opts.content;
    this.createdAt = Date.now();
    this.metadata = opts.metadata ?? {};
  }

  /** Build an attachment from a browser File/Blob (e.g. an <input type="file">
   *  or drag-drop). Works on Node/Bun too (Blob is a global there). filename /
   *  mimeType / sizeBytes are taken from the Blob unless overridden. */
  static fromBlob(
    blob: Blob,
    opts?: { id?: string; filename?: string; mimeType?: string; metadata?: Record<string, unknown> },
  ): FileAttachment {
    const filename = opts?.filename ?? (blob as { name?: string }).name ?? 'file';
    const mimeType = opts?.mimeType ?? blob.type ?? 'application/octet-stream';
    return new FileAttachment({
      id: opts?.id,
      filename,
      mimeType,
      sizeBytes: blob.size,
      content: { type: 'blob', mimeType, data: blob },
      metadata: opts?.metadata,
    });
  }

  isAvailable(provider: string): boolean {
    const state = this.uploads.get(provider);
    if (state?.status !== 'uploaded') return false;
    if (state.expiresAt && Date.now() > state.expiresAt) {
      state.status = 'expired';
      return false;
    }
    return true;
  }

  needsUpload(provider: string): boolean {
    return !this.isAvailable(provider);
  }

  getRef(provider: string): string | null {
    if (!this.isAvailable(provider)) return null;
    return this.uploads.get(provider)?.remoteId ?? null;
  }

  setUploaded(provider: string, remoteId: string, expiresAt: number | null): void {
    this.uploads.set(provider, {
      provider,
      status: 'uploaded',
      remoteId,
      uploadedAt: Date.now(),
      expiresAt,
      error: null,
    });
  }

  setError(provider: string, error: string): void {
    this.uploads.set(provider, {
      provider,
      status: 'error',
      remoteId: null,
      uploadedAt: null,
      expiresAt: null,
      error,
    });
  }

  setDeleted(provider: string): void {
    const state = this.uploads.get(provider);
    if (state) state.status = 'deleted';
  }

  /** Load file content as base64 */
  async toBase64(): Promise<string> {
    switch (this.content.type) {
      case 'base64':
        return this.content.data;
      case 'buffer':
        return bytesToBase64(this.content.data);
      case 'blob':
        return bytesToBase64(new Uint8Array(await this.content.data.arrayBuffer()));
      case 'path': {
        const { readFile } = await nodeFsPromises();
        return bytesToBase64(new Uint8Array(await readFile(this.content.path)));
      }
      case 'url':
        throw new Error('Cannot convert URL content to base64 without fetching');
    }
  }

  /** Load raw bytes */
  async toBuffer(): Promise<Uint8Array> {
    switch (this.content.type) {
      case 'buffer':
        return this.content.data;
      case 'base64':
        return base64ToBytes(this.content.data);
      case 'blob':
        return new Uint8Array(await this.content.data.arrayBuffer());
      case 'path': {
        const { readFile } = await nodeFsPromises();
        return new Uint8Array(await readFile(this.content.path));
      }
      case 'url':
        throw new Error('Cannot load URL content without fetching');
    }
  }

  export(): FileAttachmentSnapshot {
    return {
      id: this.id,
      filename: this.filename,
      mimeType: this.mimeType,
      sizeBytes: this.sizeBytes,
      uploads: [...this.uploads.values()],
      metadata: { ...this.metadata },
      createdAt: this.createdAt,
    };
  }
}
