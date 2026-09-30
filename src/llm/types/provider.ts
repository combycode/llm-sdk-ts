/** ProviderAdapter — each provider implements this. The LLMClient calls
 *  buildRequest(NormalizedRequest) → ProviderHttpRequest, sends via the
 *  injected fetch fn, then parseResponse(raw, latencyMs) → CompletionResponse. */

import type { SSEEvent } from '../../network/types';
import type { NormalizedRequest } from './request';
import type { CompletionResponse } from './response';
import type { StreamEvent } from './stream';

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'xai' | 'openrouter';

/** The same five names at runtime. A `"vendor/model"` prefix can only be read as
 *  a provider if it IS one — OpenRouter's own ids are all `vendor/model`, so
 *  without this check `openai/gpt-5.4-nano` on OpenRouter parses as the provider
 *  `openai`, and `qwen/qwen3` parses as a provider named `qwen`. */
export const PROVIDER_NAMES = ['anthropic', 'openai', 'google', 'xai', 'openrouter'] as const;

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

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
  /** What the build deliberately left out, and why — a hosted tool this provider
   *  refuses to run beside the attached content, for instance. The client emits
   *  each as `onWarning`, because dropping a capability the caller asked for and
   *  saying nothing is how a missing feature gets mistaken for a working one. */
  notes?: string[];
}

export interface ProviderAdapter {
  readonly name: ProviderName;

  /** Convert universal NormalizedRequest to provider HTTP body. */
  buildRequest(req: NormalizedRequest): ProviderHttpRequest;

  /** Parse provider's raw HTTP response body to a normalized CompletionResponse. */
  parseResponse(raw: unknown, latencyMs: number): CompletionResponse;

  /** Convert one SSE event from the provider stream into zero or more StreamEvents.
   *  Stateless per-event primitive — see `createStreamParser` for the per-stream
   *  entry point the client actually calls. */
  parseStreamEvent(event: SSEEvent): StreamEvent[];

  /** Create a per-stream parser. Returns a function that converts each SSE event
   *  into zero or more StreamEvents, holding any per-stream state (e.g. whether the
   *  turn has begun hosted code execution) in its closure. The client calls this
   *  once per `stream()` so each stream gets isolated state. Stateless adapters
   *  return `parseStreamEvent` bound to themselves. */
  createStreamParser(): (event: SSEEvent) => StreamEvent[];

  /** Auth headers (Bearer / x-api-key / etc.). */
  authHeaders(): Record<string, string>;

  /** Base URL — provider's domain root. */
  baseURL(): string;

  /** The tenancy this client acts in, when the provider has one and the caller
   *  named it. Only Anthropic does today (`anthropic-workspace-id`), which is
   *  why it is optional: it exists so requests built OUTSIDE the completion
   *  path -- retrieving a hosted-tool file, say -- can be sent to the same
   *  place the completion was billed to, rather than to the default. */
  workspaceId?: string;

  /** Path appended to baseURL for the completion endpoint. */
  completionPath(): string;

  /** Optional: mutate provider request to enable streaming (set stream:true,
   *  switch URL, etc.). */
  enableStreaming?(providerReq: ProviderHttpRequest, req: NormalizedRequest): void;
}
