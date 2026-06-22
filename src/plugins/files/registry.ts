/** FilesRegistry — manages files across providers. Subscribes to
 *  onMessageResolve and resolves file refs into provider-friendly content
 *  parts (provider_ref / inline base64 / url). */

import type { HookBus } from '../../bus/hook-bus';
import type { MessageResolveContext } from '../../bus/hook-map';
import type { ContentPart, DataSource } from '../../llm/types/messages';
import type { EngineFetch } from '../../network/types';
import type { ModelCatalog } from '../model-catalog/catalog';
import { FileAttachment, type FileContent } from './attachment';
import type { FileProviderAdapter, RemoteFileInfo } from './provider-adapter';
import { DefaultFileStrategy, type FileDecision, type FileStrategy } from './strategy';

export interface FilesRegistryConfig {
  hooks: HookBus;
  catalog?: ModelCatalog;
  strategy?: FileStrategy;
  /** Engine fetch — every adapter HTTP call dispatches through this so it
   *  inherits NetworkEngine queue semantics (rate limits, retry, hooks). */
  fetch: EngineFetch;
}

type FilePartType = 'image' | 'document' | 'audio' | 'video';

export class FilesRegistry {
  private files = new Map<string, FileAttachment>();
  private providers = new Map<string, FileProviderAdapter>();
  private hooks: HookBus;
  private catalog: ModelCatalog | null;
  private strategy: FileStrategy;
  private fetch: EngineFetch;
  private unsub: (() => void) | null = null;

  constructor(config: FilesRegistryConfig) {
    this.hooks = config.hooks;
    this.catalog = config.catalog ?? null;
    this.strategy = config.strategy ?? new DefaultFileStrategy();
    this.fetch = config.fetch;

    this.unsub = this.hooks.on('onMessageResolve', (ctx) => this.resolveMessages(ctx));
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
  }

  // ─── Provider management ──────────────────────────────────────────────

  registerProvider(name: string, adapter: FileProviderAdapter): void {
    this.providers.set(name, adapter);
  }

  // ─── File management ──────────────────────────────────────────────────

  add(opts: {
    filename: string;
    mimeType: string;
    content: FileContent;
    sizeBytes?: number;
    metadata?: Record<string, unknown>;
  }): FileAttachment {
    const sizeBytes = opts.sizeBytes ?? this.estimateSize(opts.content);
    const file = new FileAttachment({ ...opts, sizeBytes });
    this.files.set(file.id, file);
    return file;
  }

  get(id: string): FileAttachment | null {
    return this.files.get(id) ?? null;
  }

  list(): FileAttachment[] {
    return [...this.files.values()];
  }

  remove(id: string): void {
    this.files.delete(id);
  }

  // ─── Upload operations ────────────────────────────────────────────────

  async upload(fileId: string, provider: string): Promise<string> {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);

    const adapter = this.providers.get(provider);
    if (!adapter) throw new Error(`No file adapter for provider: ${provider}`);

    const start = performance.now();
    const result = await adapter.upload(file, this.fetch);
    const latencyMs = performance.now() - start;

    file.setUploaded(provider, result.remoteId, result.expiresAt);

    this.hooks.emitSync('onWarning', {
      source: 'files',
      code: 'file_uploaded',
      message: `Uploaded ${file.filename} to ${provider}: ${result.remoteId}`,
      details: { fileId, provider, remoteId: result.remoteId, latencyMs },
    });

    return result.remoteId;
  }

  async deleteRemote(fileId: string, provider: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file) return;

    const ref = file.getRef(provider);
    if (!ref) return;

    const adapter = this.providers.get(provider);
    if (!adapter) return;

    await adapter.delete(ref, this.fetch);
    file.setDeleted(provider);
  }

  async listRemote(provider: string): Promise<RemoteFileInfo[]> {
    const adapter = this.providers.get(provider);
    if (!adapter) return [];
    return adapter.list(this.fetch);
  }

  // ─── Message resolution (called via hook) ─────────────────────────────

  private async resolveMessages(ctx: MessageResolveContext): Promise<void> {
    const { provider, model, messages } = ctx;
    const adapter = this.providers.get(provider);

    for (const msg of messages) {
      if (typeof msg.content === 'string') continue;
      if (!Array.isArray(msg.content)) continue;

      for (let i = 0; i < msg.content.length; i++) {
        const part = msg.content[i];
        if (!this.hasFileSource(part)) continue;

        const resolved = await this.resolveFilePart(part, provider, model, adapter);
        if (resolved) {
          msg.content[i] = resolved;
        }
      }
    }
  }

  private hasFileSource(part: ContentPart): boolean {
    if (
      part.type === 'image' ||
      part.type === 'document' ||
      part.type === 'audio' ||
      part.type === 'video'
    ) {
      const source = (part as { source?: DataSource }).source;
      if (!source) return false;
      return source.type === 'path' || source.type === 'buffer' || source.type === 'file';
    }
    return false;
  }

  private async resolveFilePart(
    part: ContentPart,
    provider: string,
    model: string,
    adapter: FileProviderAdapter | undefined,
  ): Promise<ContentPart | null> {
    const source = (part as { source: DataSource }).source;
    const partType = part.type as FilePartType;

    let file: FileAttachment | null = null;

    if (source.type === 'file') {
      file = this.files.get(source.fileId) ?? null;
      if (!file) {
        this.hooks.emitSync('onWarning', {
          source: 'files',
          code: 'file_not_found',
          message: `File ${source.fileId} not found in registry`,
        });
        return null;
      }
    } else if (source.type === 'path') {
      const fs = await import('node:fs');
      const stats = fs.statSync(source.path);
      file = this.add({
        filename: source.path.replace(/\\/g, '/').split('/').pop() ?? 'file',
        mimeType: source.mimeType,
        content: { type: 'path', mimeType: source.mimeType, path: source.path },
        sizeBytes: stats.size,
      });
    } else if (source.type === 'buffer') {
      file = this.add({
        filename: 'buffer-file',
        mimeType: source.mimeType,
        content: { type: 'buffer', mimeType: source.mimeType, data: source.data },
        sizeBytes: source.data.length,
      });
    }

    if (!file) return null;

    const modelInfo = this.catalog?.get(provider, model) ?? null;
    const decision = this.strategy.decide({
      file,
      provider,
      model,
      isUploaded: file.isAvailable(provider),
      isExpired: file.uploads.get(provider)?.status === 'expired',
      providerMaxSize: adapter?.maxFileSize ?? 500_000_000,
      providerSupportsType:
        adapter?.supportedTypes === null ||
        (adapter?.supportedTypes?.some((t) => file.mimeType.startsWith(t.split('/')[0])) ?? true),
      modelInfo,
    });

    return this.executeDecision(file, decision, provider, partType, adapter);
  }

  private async executeDecision(
    file: FileAttachment,
    decision: FileDecision,
    provider: string,
    partType: FilePartType,
    adapter: FileProviderAdapter | undefined,
  ): Promise<ContentPart> {
    switch (decision.action) {
      case 'upload':
      case 'reupload': {
        if (!adapter) {
          return this.makeInlinePart(file, partType);
        }

        if (file.needsUpload(provider)) {
          await this.upload(file.id, provider);
        }

        const refId = file.getRef(provider);
        if (!refId) {
          return this.makeInlinePart(file, partType);
        }

        return {
          type: partType,
          source: { type: 'provider_ref', mimeType: file.mimeType, refId },
        } as ContentPart;
      }

      case 'inline': {
        return this.makeInlinePart(file, partType);
      }

      case 'url': {
        if (file.content.type === 'url') {
          return {
            type: partType,
            source: { type: 'url', url: file.content.url },
          } as ContentPart;
        }
        return this.makeInlinePart(file, partType);
      }

      case 'skip': {
        this.hooks.emitSync('onWarning', {
          source: 'files',
          code: 'file_skipped',
          message: decision.reason,
          details: { fileId: file.id, provider },
        });
        return { type: 'text', text: `[File ${file.filename} skipped: ${decision.reason}]` };
      }
    }
  }

  private async makeInlinePart(file: FileAttachment, partType: FilePartType): Promise<ContentPart> {
    const b64 = await file.toBase64();
    return {
      type: partType,
      source: { type: 'base64', mimeType: file.mimeType, data: b64 },
    } as ContentPart;
  }

  private estimateSize(content: FileContent): number {
    switch (content.type) {
      case 'buffer':
        return content.data.length;
      case 'blob':
        return content.data.size;
      case 'base64':
        return Math.floor((content.data.length * 3) / 4);
      case 'path':
        return 0;
      case 'url':
        return 0;
    }
  }
}
