/** FileProviderAdapter — provider-specific file operations.
 *  Implemented by per-provider files.ts (anthropic/openai/google/xai).
 *
 *  All HTTP calls flow through an injected EngineFetch (NetworkEngine queue)
 *  — adapters do not hold their own fetch fn. FilesRegistry threads
 *  `engine.fetch` into adapter methods on every call, so rate-limit, retry,
 *  and observability hooks apply uniformly. */

import type { EngineFetch } from '../../network/types';
import type { FileAttachment } from './attachment';

export interface FileUploadResult {
  remoteId: string;
  expiresAt: number | null;
}

export interface RemoteFileInfo {
  remoteId: string;
  filename: string;
  sizeBytes: number;
  createdAt: number;
  expiresAt?: number;
}

export interface FileProviderAdapter {
  readonly name: string;

  /** Upload a file. Returns remote id + optional expiry. */
  upload(file: FileAttachment, fetch: EngineFetch): Promise<FileUploadResult>;

  /** Delete a remote file. */
  delete(remoteId: string, fetch: EngineFetch): Promise<void>;

  /** Get info about a remote file. Returns null if not found. */
  getInfo(remoteId: string, fetch: EngineFetch): Promise<RemoteFileInfo | null>;

  /** List all remote files for the configured account. */
  list(fetch: EngineFetch): Promise<RemoteFileInfo[]>;

  /** Auto-expiry window in ms, or null for persistent. */
  expiresAfter: number | null;

  /** Max file size in bytes. */
  maxFileSize: number;

  /** Supported MIME types — null means accept all. */
  supportedTypes: string[] | null;
}
