/** FileStrategy — pluggable decision maker for how to attach files. */

import type { ModelInfo } from '../model-catalog/catalog';
import type { FileAttachment } from './attachment';

export interface FileStrategyContext {
  file: FileAttachment;
  provider: string;
  model: string;
  isUploaded: boolean;
  isExpired: boolean;
  providerMaxSize: number;
  providerSupportsType: boolean;
  modelInfo: ModelInfo | null;
}

export type FileDecision =
  | { action: 'upload'; reason: string }
  | { action: 'reupload'; reason: string }
  | { action: 'inline'; reason: string }
  | { action: 'url'; reason: string }
  | { action: 'skip'; reason: string };

export interface FileStrategy {
  decide(ctx: FileStrategyContext): FileDecision;
}

/** Default: upload large files, inline small ones, use URL when available. */
export class DefaultFileStrategy implements FileStrategy {
  constructor(private inlineThreshold = 50_000) {}

  decide(ctx: FileStrategyContext): FileDecision {
    if (!ctx.providerSupportsType) {
      return { action: 'skip', reason: `${ctx.provider} does not support ${ctx.file.mimeType}` };
    }

    if (ctx.file.sizeBytes > ctx.providerMaxSize) {
      return {
        action: 'skip',
        reason: `File ${ctx.file.sizeBytes}B exceeds limit ${ctx.providerMaxSize}B`,
      };
    }

    if (ctx.isUploaded && !ctx.isExpired) {
      return { action: 'upload', reason: 'already uploaded, use existing ref' };
    }

    if (ctx.isExpired) {
      return { action: 'reupload', reason: 'expired, re-uploading' };
    }

    if (ctx.file.content.type === 'url' && ['openai', 'xai'].includes(ctx.provider)) {
      return { action: 'url', reason: 'URL source, provider supports direct URL' };
    }

    if (ctx.file.sizeBytes < this.inlineThreshold) {
      return {
        action: 'inline',
        reason: `small file (${ctx.file.sizeBytes}B < ${this.inlineThreshold}B threshold)`,
      };
    }

    return { action: 'upload', reason: 'file above inline threshold, uploading' };
  }
}
