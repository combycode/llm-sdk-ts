/** OpenAI embeddings adapter — POST /v1/embeddings. Also the base for the
 *  OpenAI-compatible OpenRouter adapter. */

import type { EngineFetch } from '../../../network/types';
import type {
  EmbedRequest,
  EmbedResult,
  EmbeddingProviderAdapter,
} from '../../../plugins/embeddings/types';

export interface OpenAIEmbeddingAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class OpenAIEmbeddingAdapter implements EmbeddingProviderAdapter {
  readonly name: string = 'openai';
  protected readonly apiKey: string;
  protected readonly _baseURL: string;

  constructor(config: OpenAIEmbeddingAdapterConfig) {
    this.apiKey = config.apiKey;
    this._baseURL = config.baseURL ?? 'https://api.openai.com';
  }

  protected embeddingsPath(): string {
    return '/v1/embeddings';
  }

  async embed(req: EmbedRequest, fetch: EngineFetch): Promise<EmbedResult> {
    const input = Array.isArray(req.input) ? req.input : [req.input];
    const res = await fetch({
      url: `${this._baseURL}${this.embeddingsPath()}`,
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: { model: req.model, input },
      provider: this.name,
      model: req.model,
      responseType: 'json',
    });
    const data = res.body as {
      data?: Array<{ embedding: number[] }>;
      usage?: { prompt_tokens?: number };
    };
    const embeddings = (data.data ?? []).map((d) => d.embedding);
    return {
      embeddings,
      model: req.model,
      dimensions: embeddings[0]?.length ?? 0,
      usage: data.usage ? { inputTokens: data.usage.prompt_tokens ?? 0 } : undefined,
    };
  }
}
