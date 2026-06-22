/** Embeddings subsystem — text → vector. Mirrors the media adapter contract:
 *  a thin per-provider adapter whose HTTP flows through the injected EngineFetch
 *  (so it shares the NetworkEngine queue / retry / hooks). */

import type { EngineFetch } from '../../network/types';

export interface EmbedRequest {
  model: string;
  /** One string or a batch. */
  input: string | string[];
}

export interface EmbedResult {
  /** One vector per input, in order. */
  embeddings: number[][];
  model: string;
  /** Vector length (0 when empty). */
  dimensions: number;
  usage?: { inputTokens: number };
}

export interface EmbeddingProviderAdapter {
  readonly name: string;
  embed(req: EmbedRequest, fetch: EngineFetch): Promise<EmbedResult>;
}
