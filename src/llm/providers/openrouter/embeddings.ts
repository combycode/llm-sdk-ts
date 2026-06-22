/** OpenRouter embeddings adapter — OpenAI-compatible at openrouter.ai/api/v1. */

import { OpenAIEmbeddingAdapter, type OpenAIEmbeddingAdapterConfig } from '../openai/embeddings';

export class OpenRouterEmbeddingAdapter extends OpenAIEmbeddingAdapter {
  override readonly name: string = 'openrouter';

  constructor(config: OpenAIEmbeddingAdapterConfig) {
    super({ apiKey: config.apiKey, baseURL: config.baseURL ?? 'https://openrouter.ai' });
  }

  protected override embeddingsPath(): string {
    return '/api/v1/embeddings';
  }
}
