/** Count API adapter — exact token counting via provider endpoints. */

import type { Message } from '../../../llm/types/messages';
import type { TokenCountContext, TokenCounter, LearnInput } from '../../../agent/types';
import type { FetchFn } from '../../../network/types';
import type { ModelCatalog } from '../../model-catalog/catalog';
import { HeuristicCounter, messageChars } from './heuristic';
import { ANTHROPIC_API_VERSION } from '../../../llm/providers/anthropic/constants';

/** Anthropic count endpoint: POST /v1/messages/count_tokens */
export class AnthropicCountApi {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
    private readonly baseURL: string = 'https://api.anthropic.com',
  ) {}

  async countMessages(
    model: string,
    messages: Array<{ role: string; content: unknown }>,
    system?: string,
  ): Promise<number> {
    const body: Record<string, unknown> = { model, messages };
    if (system) body.system = system;

    const res = await this.fetchFn(`${this.baseURL}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok)
      throw new Error(`Anthropic count_tokens failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;
    return (data.input_tokens as number) ?? 0;
  }

  async countText(model: string, text: string): Promise<number> {
    return this.countMessages(model, [{ role: 'user', content: text }]);
  }
}

/** Google count endpoint: POST /v1beta/models/{model}:countTokens */
export class GoogleCountApi {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
    private readonly baseURL: string = 'https://generativelanguage.googleapis.com',
  ) {}

  async countText(model: string, text: string): Promise<number> {
    const modelPath = model.startsWith('models/') ? model : `models/${model}`;
    const body = { contents: [{ parts: [{ text }] }] };

    const res = await this.fetchFn(`${this.baseURL}/v1beta/${modelPath}:countTokens`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Google countTokens failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;
    return (data.totalTokens as number) ?? 0;
  }
}

/** TokenCounter backed by Anthropic/Google count APIs. Falls back to heuristic
 *  for fast estimates and unknown providers. */
export class CountApiCounter implements TokenCounter {
  private heuristic: HeuristicCounter;

  constructor(
    catalog: ModelCatalog | null,
    private readonly providers: {
      anthropic?: AnthropicCountApi;
      google?: GoogleCountApi;
    } = {},
  ) {
    this.heuristic = new HeuristicCounter(catalog);
  }

  estimate(text: string, ctx?: TokenCountContext): number {
    return this.heuristic.estimate(text, ctx);
  }

  estimateMessage(msg: Message, ctx?: TokenCountContext): number {
    return this.heuristic.estimateMessage(msg, ctx);
  }

  async measure(text: string, ctx?: TokenCountContext): Promise<number> {
    const api = this.apiFor(ctx);
    if (!api) return this.heuristic.measure(text, ctx);
    return api.countText(ctx!.model!, text);
  }

  async measureMessage(msg: Message, ctx?: TokenCountContext): Promise<number> {
    const api = this.apiFor(ctx);
    if (!api) return this.heuristic.measureMessage(msg, ctx);
    const content = msg.content;
    if (typeof content === 'string') return api.countText(ctx!.model!, content);
    // Multi-part — best effort: serialize and count.
    void messageChars(msg);
    return api.countText(ctx!.model!, JSON.stringify(msg.content).slice(0, 100_000));
  }

  learn(input: LearnInput): void {
    this.heuristic.learn(input);
  }

  private apiFor(ctx?: TokenCountContext): AnthropicCountApi | GoogleCountApi | null {
    if (!ctx?.provider || !ctx.model) return null;
    if (ctx.provider === 'anthropic') return this.providers.anthropic ?? null;
    if (ctx.provider === 'google') return this.providers.google ?? null;
    return null;
  }
}
