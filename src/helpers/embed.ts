/** embed() — one-shot text→vector helper, mirroring complete().
 *
 *    const { embeddings, dimensions } = await embed({
 *      model: 'openai/text-embedding-3-small',
 *      input: 'hello',
 *    });
 *    // embeddings[0] is the vector; dimensions is its length.
 *
 *  Providers: openai, openrouter (OpenAI-compat), google. (anthropic/xai have no
 *  first-party embeddings endpoint.) HTTP flows through engine.fetch. */

import type { ProviderName } from '../llm/types/provider';
import { GoogleEmbeddingAdapter } from '../llm/providers/google/embeddings';
import { OpenAIEmbeddingAdapter } from '../llm/providers/openai/embeddings';
import { OpenRouterEmbeddingAdapter } from '../llm/providers/openrouter/embeddings';
import { emptyUsage } from '../llm/types/response';
import type { EmbedResult, EmbeddingProviderAdapter } from '../plugins/embeddings/types';
import { resolveModel } from './client-resolver';
import { coreRegistry, type EngineHandle } from './engine';

export interface EmbedOptions {
  /** Model string. Bare (pair with `provider`) or namespaced (`openai/text-embedding-3-small`). */
  model: string;
  provider?: ProviderName;
  apiKey?: string;
  input: string | string[];
  /** Override the auto-built provider adapter. */
  adapter?: EmbeddingProviderAdapter;
  engine?: EngineHandle;
}

export async function embed(opts: EmbedOptions): Promise<EmbedResult> {
  const engine = opts.engine ?? coreRegistry.get();
  const { provider, model } = resolveModel(opts.model, opts.provider, 'embed');
  const apiKey = opts.apiKey ?? engine.apiKeys[provider];
  if (!apiKey) {
    throw new Error(
      `embed: no API key for provider "${provider}". Pass apiKey or set engine.apiKeys["${provider}"].`,
    );
  }
  const adapter = opts.adapter ?? defaultEmbeddingAdapter(provider, apiKey);
  const result = await adapter.embed({ model, input: opts.input }, engine.fetch);
  emitEmbedCompletion(engine, provider, model, result);
  return result;
}

/** Emit onCompletion so cost-collector accounts for embedding token usage. */
function emitEmbedCompletion(engine: EngineHandle, provider: string, model: string, result: EmbedResult): void {
  const usage = result.usage;
  if (!usage) return;
  const inputTokens = usage.inputTokens;
  const fullUsage = { ...emptyUsage(), inputTokens, totalTokens: inputTokens };
  engine.hooks.emitSync('onCompletion', {
    provider,
    model,
    response: {
      id: `embed_${crypto.randomUUID().slice(0, 12)}`,
      model,
      content: [],
      finishReason: 'stop',
      usage: fullUsage,
      text: '',
      toolCalls: [],
      thinking: null,
      media: [],
      latencyMs: 0,
      raw: null,
    },
    request: {
      estimatedInputTokens: inputTokens,
      inputChars: 0,
      messageCount: 0,
      hasTools: false,
    },
    ctx: {},
  });
}

function defaultEmbeddingAdapter(provider: ProviderName, apiKey: string): EmbeddingProviderAdapter {
  switch (provider) {
    case 'openai':
      return new OpenAIEmbeddingAdapter({ apiKey });
    case 'openrouter':
      return new OpenRouterEmbeddingAdapter({ apiKey });
    case 'google':
      return new GoogleEmbeddingAdapter({ apiKey });
    default:
      throw new Error(
        `embed: no embedding adapter for provider "${provider}" (supported: openai, openrouter, google).`,
      );
  }
}
