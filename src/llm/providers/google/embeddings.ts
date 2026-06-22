/** Google embeddings adapter — POST /v1beta/models/{model}:embedContent.
 *  One call per input text (batch via a simple loop). */

import type { EngineFetch } from '../../../network/types';
import type {
  EmbedRequest,
  EmbedResult,
  EmbeddingProviderAdapter,
} from '../../../plugins/embeddings/types';

export interface GoogleEmbeddingAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class GoogleEmbeddingAdapter implements EmbeddingProviderAdapter {
  readonly name = 'google';
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(config: GoogleEmbeddingAdapterConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? 'https://generativelanguage.googleapis.com';
  }

  async embed(req: EmbedRequest, fetch: EngineFetch): Promise<EmbedResult> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const model = req.model.startsWith('models/') ? req.model : `models/${req.model}`;
    const embeddings: number[][] = [];
    for (const text of inputs) {
      const res = await fetch({
        url: `${this.baseURL}/v1beta/${model}:embedContent`,
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
        body: { model, content: { parts: [{ text }] } },
        provider: 'google',
        model: req.model,
        responseType: 'json',
      });
      const data = res.body as { embedding?: { values: number[] } };
      embeddings.push(data.embedding?.values ?? []);
    }
    return { embeddings, model: req.model, dimensions: embeddings[0]?.length ?? 0 };
  }
}
