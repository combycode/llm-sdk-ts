/** OpenAI embeddings adapter — POST /v1/embeddings. Also the base for the
 *  OpenAI-compatible OpenRouter adapter. */

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

  /** Named code the spec cannot express as data — the array coercion. */
  protected readonly wireRegistry: Registry = makeRegistry({});

  protected embeddingsPath(): string {
    return '/v1/embeddings';
  }

  /** Which spec builds the request. OpenRouter is the same wire on a different
   *  host and path, expressed as a one-line override of this spec. */
  protected specId(): string {
    return 'openai/embeddings';
  }

  /** The request, built and inspectable without performing it.
   *
   *  `input` is always an array on the wire even when the caller passes one
   *  string, which is the sort of rule that belongs in data rather than in a
   *  ternary nobody re-reads. */
  buildEmbedRequest(req: EmbedRequest): HttpRequest {
    const built = buildFromSpec(
      serviceSpec(this.specId()),
      req as never,
      this.wireRegistry,
      this.name,
      undefined,
      { baseURL: this._baseURL, apiKey: this.apiKey },
    );
    return {
      ...(built as object),
      provider: this.name,
      model: req.model,
      responseType: 'json',
    } as HttpRequest;
  }

  async embed(req: EmbedRequest, fetch: EngineFetch): Promise<EmbedResult> {
    const res = await fetch(this.buildEmbedRequest(req));
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
