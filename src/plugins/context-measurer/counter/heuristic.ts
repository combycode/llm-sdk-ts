/** Heuristic token counter — chars-per-token with optional calibration. */

import type { Message } from '../../../llm/types/messages';
import type { TokenCountContext, TokenCounter, LearnInput } from '../../../agent/types';
import type { ModelCatalog } from '../../model-catalog/catalog';
import type { CalibrationStore } from '../types';
import { CONTEXT_DEFAULTS } from '../types';

/** Count chars across a message's content parts. */
export function messageChars(msg: Message): number {
  const content = msg.content;
  if (typeof content === 'string') return content.length;

  let chars = 0;
  for (const part of content) {
    switch (part.type) {
      case 'text':
        chars += part.text.length;
        break;
      case 'tool_call':
        chars += part.name.length + JSON.stringify(part.arguments).length + 10;
        break;
      case 'tool_result':
        chars +=
          typeof part.content === 'string'
            ? part.content.length
            : JSON.stringify(part.content).length;
        break;
      case 'image':
      case 'audio':
      case 'video':
      case 'document':
        chars += 250 * 4;
        break;
      case 'image_output':
      case 'audio_output':
      case 'video_output':
        chars += 250 * 4;
        break;
    }
  }
  return chars;
}

export class HeuristicCounter implements TokenCounter {
  private readonly cache = new Map<string, number>();

  constructor(
    private readonly catalog: ModelCatalog | null,
    private readonly calibrationStore: CalibrationStore | null = null,
  ) {}

  estimate(text: string, ctx?: TokenCountContext): number {
    const rate = this.rateSync(ctx);
    return Math.ceil(text.length / rate);
  }

  estimateMessage(msg: Message, ctx?: TokenCountContext): number {
    const rate = this.rateSync(ctx);
    return Math.ceil(messageChars(msg) / rate);
  }

  async measure(text: string, ctx?: TokenCountContext): Promise<number> {
    const rate = await this.rate(ctx);
    return Math.ceil(text.length / rate);
  }

  async measureMessage(msg: Message, ctx?: TokenCountContext): Promise<number> {
    const rate = await this.rate(ctx);
    return Math.ceil(messageChars(msg) / rate);
  }

  learn(input: LearnInput): void {
    if (!this.calibrationStore) return;
    if (input.bytesSent <= 0 || input.actualTokens <= 0) return;

    const ratio = input.bytesSent / input.actualTokens;
    this.calibrationStore
      .update({
        provider: input.provider,
        model: input.model,
        contentClass: input.contentClass,
        charsPerToken: ratio,
        samples: 1,
      })
      .catch(() => {
        /* swallow — calibration is best-effort */
      });
  }

  /** Pre-warm the sync cache from the calibration store. */
  async warmCache(): Promise<void> {
    if (!this.calibrationStore) return;
    const entries = await this.calibrationStore.list();
    for (const e of entries) {
      this.cache.set(this.cacheKeyFor(e.provider, e.model, e.contentClass), e.charsPerToken);
    }
  }

  private rateSync(ctx?: TokenCountContext): number {
    if (ctx?.provider && ctx.model) {
      const cached = this.cache.get(this.cacheKey(ctx));
      if (cached !== undefined) return cached;
    }
    return this.catalogDefault(ctx);
  }

  private async rate(ctx?: TokenCountContext): Promise<number> {
    if (this.calibrationStore && ctx?.provider && ctx.model) {
      const entry = await this.calibrationStore.get(ctx.provider, ctx.model, ctx.contentClass);
      if (entry && entry.samples > 0) {
        this.cache.set(this.cacheKey(ctx), entry.charsPerToken);
        return entry.charsPerToken;
      }
    }
    return this.catalogDefault(ctx);
  }

  private catalogDefault(ctx?: TokenCountContext): number {
    if (ctx?.provider && ctx.model && this.catalog) {
      const info = this.catalog.get(ctx.provider, ctx.model);
      const rate = info?.tokenizer?.charsPerTokenDefault;
      if (rate && rate > 0) return rate;
    }
    return CONTEXT_DEFAULTS.charsPerTokenFallback;
  }

  private cacheKey(ctx: TokenCountContext): string {
    return this.cacheKeyFor(ctx.provider!, ctx.model!, ctx.contentClass);
  }

  private cacheKeyFor(provider: string, model: string, contentClass?: string): string {
    return `${provider}/${model}:${contentClass ?? ''}`;
  }
}
