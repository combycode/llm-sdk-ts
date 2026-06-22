/** ProviderAdapter — each provider implements this. The LLMClient calls
 *  buildRequest(NormalizedRequest) → ProviderHttpRequest, sends via the
 *  injected fetch fn, then parseResponse(raw, latencyMs) → CompletionResponse. */

import type { SSEEvent } from '../../network/types';
import type { NormalizedRequest } from './request';
import type { CompletionResponse } from './response';
import type { StreamEvent } from './stream';

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'xai' | 'openrouter';

export type ApiType = 'completions' | 'responses' | 'messages' | 'interactions' | 'generate';

export interface ProviderConfig {
  provider: ProviderName;
  apiKey: string;
  baseURL?: string;
}

export interface ProviderHttpRequest {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Override of the default completion path. Used by providers that route
   *  per-API or per-modality. */
  path?: string;
}

export interface ProviderAdapter {
  readonly name: ProviderName;

  /** Convert universal NormalizedRequest to provider HTTP body. */
  buildRequest(req: NormalizedRequest): ProviderHttpRequest;

  /** Parse provider's raw HTTP response body to a normalized CompletionResponse. */
  parseResponse(raw: unknown, latencyMs: number): CompletionResponse;

  /** Convert one SSE event from the provider stream into zero or more StreamEvents. */
  parseStreamEvent(event: SSEEvent): StreamEvent[];

  /** Auth headers (Bearer / x-api-key / etc.). */
  authHeaders(): Record<string, string>;

  /** Base URL — provider's domain root. */
  baseURL(): string;

  /** Path appended to baseURL for the completion endpoint. */
  completionPath(): string;

  /** Optional: mutate provider request to enable streaming (set stream:true,
   *  switch URL, etc.). */
  enableStreaming?(providerReq: ProviderHttpRequest, req: NormalizedRequest): void;
}
