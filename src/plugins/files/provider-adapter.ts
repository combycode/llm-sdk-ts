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

/** What the caller asks for at upload time.
 *
 *  `lifetimeSeconds` is the one option so far, and it exists because files do
 *  NOT clean themselves up: OpenAI states that everything but `purpose=batch`
 *  "persists until manually deleted", so an agent attaching a document per turn
 *  grows an unbounded pile on the customer's account.
 *
 *  Three of the four providers accept a lifetime and one does not, which is the
 *  part worth knowing before using it: Google's `expiration_time` is marked
 *  "Output only" -- Google decides, and asking changes nothing. An adapter that
 *  cannot honour the request says so through `onWarning` with code
 *  `request_adjusted` rather than dropping it silently, because a unified option
 *  that quietly does nothing on one provider is how a caller ends up believing
 *  in a cleanup that never happens. */
export interface FileUploadOptions {
  /** Seconds from upload until the provider deletes the file. Each provider
   *  clamps to its own range; the request is sent as given and the provider's
   *  own error is surfaced if it is out of bounds. */
  lifetimeSeconds?: number;
  /** Raised when an adapter cannot honour an option. Supplied by the registry. */
  warn?: (message: string, details?: Record<string, unknown>) => void;
}

export interface FileProviderAdapter {
  readonly name: string;

  /** Upload a file. Returns remote id + optional expiry. */
  upload(file: FileAttachment, fetch: EngineFetch, opts?: FileUploadOptions): Promise<FileUploadResult>;

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
