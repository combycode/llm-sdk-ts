/** Count API adapter — exact token counting via provider endpoints. */

import type { Message } from '../../../llm/types/messages';
import type { TokenCountContext, TokenCounter, LearnInput } from '../../../agent/types';
import type { EngineFetch } from '../../../network/types';
import { buildFromSpec } from '../../../wire/interpreter';
import { utilitySpec } from '../../../wire/utility-specs';
import { makeRegistry } from '../../../llm/wire-transforms';
import type { ModelCatalog } from '../../../catalog/catalog';
import { HeuristicCounter, messageChars } from './heuristic';
import { ANTHROPIC_API_VERSION } from '../../../llm/providers/anthropic/constants';


/** Build a count request from its spec and add the engine metadata.
 *
 *  These two endpoints used to call `globalThis.fetch` directly, which meant every
 *  exact token count went out around the NetworkEngine: no queue, no rate limit,
 *  no retry, no telemetry span — while every other file in the library says all
 *  HTTP goes through the injected fetch. The fetch is now REQUIRED rather than
 *  defaulted, because a default that silently bypasses the engine is the trap that
 *  produced this. */
function countRequest(
  specId: string,
  input: object,
  config: Record<string, unknown>,
  provider: string,
): Record<string, unknown> {
  const built = buildFromSpec(utilitySpec(specId), input as never, makeRegistry({}), provider, undefined, config) as unknown as Record<string, unknown>;
  return { ...built, provider, model: 'count_tokens', responseType: 'json' };
}

/** Anthropic count endpoint: POST /v1/messages/count_tokens */
export class AnthropicCountApi {
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: EngineFetch,
    private readonly baseURL: string = 'https://api.anthropic.com',
  ) {}

  async countMessages(
    model: string,
    messages: Array<{ role: string; content: unknown }>,
    system?: string,
  ): Promise<number> {
    const res = await this.fetchFn(
      countRequest(
        'anthropic/count.messages',
        { model, messages, system },
        { baseURL: this.baseURL, apiKey: this.apiKey, apiVersion: ANTHROPIC_API_VERSION },
        'anthropic',
      ) as never,
    );

    if (res.status >= 400) {
      throw new Error(`Anthropic count_tokens failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const data = (res.body ?? {}) as Record<string, unknown>;
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
    private readonly fetchFn: EngineFetch,
    private readonly baseURL: string = 'https://generativelanguage.googleapis.com',
  ) {}

  async countText(model: string, text: string): Promise<number> {
    const res = await this.fetchFn(
      countRequest(
        'google/count.tokens',
        { model, text },
        { baseURL: this.baseURL, apiKey: this.apiKey },
        'google',
      ) as never,
    );

    if (res.status >= 400) {
      throw new Error(`Google countTokens failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const data = (res.body ?? {}) as Record<string, unknown>;
    return (data.totalTokens as number) ?? 0;
  }
}

/** TokenCounter backed by Anthropic/Google count APIs. Falls back to heuristic
 *  for fast estimates and unknown providers. */
export class CountApiCounter implements TokenCounter {
  private heuristic: HeuristicCounter;

  private readonly catalog: ModelCatalog | null;

  constructor(
    catalog: ModelCatalog | null,
    private readonly providers: {
      anthropic?: AnthropicCountApi;
      google?: GoogleCountApi;
    } = {},
  ) {
    this.catalog = catalog;
    this.heuristic = new HeuristicCounter(catalog);
  }

  /** The id to SEND. `ctx.model` is our canonical slug — `claude-haiku-4.5` —
   *  which is not what the provider answers to: its callable id is the dated
   *  `claude-haiku-4-5-20251001`. The chat path translates through the catalog;
   *  this one did not, so the moment a model's slug and api id differed the count
   *  endpoint returned 404. Nothing noticed while the strategy was never
   *  selected. */
  private apiModel(ctx: TokenCountContext): string {
    return this.catalog?.resolveModelId(ctx.provider!, ctx.model!) ?? ctx.model!;
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
    return api.countText(this.apiModel(ctx!), text);
  }

  async measureMessage(msg: Message, ctx?: TokenCountContext): Promise<number> {
    const api = this.apiFor(ctx);
    if (!api) return this.heuristic.measureMessage(msg, ctx);
    const content = msg.content;
    const model = this.apiModel(ctx!);
    if (typeof content === 'string') return api.countText(model, content);
    // Multi-part — best effort: serialize and count.
    void messageChars(msg);
    return api.countText(model, JSON.stringify(msg.content).slice(0, 100_000));
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
