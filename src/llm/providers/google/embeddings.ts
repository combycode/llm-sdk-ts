/** Google embeddings adapter — POST /v1beta/models/{model}:embedContent.
 *  One call per input text (batch via a simple loop). */

import type { EngineFetch, HttpRequest } from '../../../network/types';
import { buildFromSpec } from '../../../wire/interpreter';
import type { Registry } from '../../../wire/interpreter';
import { serviceSpec } from '../../../wire/service-specs';
import { makeRegistry } from '../../wire-transforms';
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

  /** One request, for ONE input text.
   *
   *  Google embeds a single text per call, so `embed` loops and this builds one
   *  iteration. The spec's input context is `{ model, text }` accordingly. */
  buildEmbedRequest(req: EmbedRequest, text: string): HttpRequest {
    const built = buildFromSpec(
      serviceSpec('google/embeddings'),
      { model: req.model, text } as never,
      this.wireRegistry,
      'google',
      undefined,
      { baseURL: this.baseURL, apiKey: this.apiKey },
    );
    return {
      ...(built as object),
      provider: 'google',
      model: req.model,
      responseType: 'json',
    } as HttpRequest;
  }

  /** Named code the spec cannot express as data — the models/ path prefix. */
  private readonly wireRegistry: Registry = makeRegistry({});

  async embed(req: EmbedRequest, fetch: EngineFetch): Promise<EmbedResult> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const embeddings: number[][] = [];
    for (const text of inputs) {
      const res = await fetch(this.buildEmbedRequest(req, text));
      const data = res.body as { embedding?: { values: number[] } };
      embeddings.push(data.embedding?.values ?? []);
    }
    return { embeddings, model: req.model, dimensions: embeddings[0]?.length ?? 0 };
  }
}
