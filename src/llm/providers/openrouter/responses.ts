/** OpenRouter Responses API adapter.
 *  Drop-in replacement for OpenAI Responses API at openrouter.ai/api/v1/responses.
 *  Stateless: no previous_response_id support (beta limitation). */

import type { ProviderAdapter, } from '../../types/provider';
import { OpenAIResponsesAdapter } from '../openai/responses';

export interface OpenRouterResponsesAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class OpenRouterResponsesAdapter extends OpenAIResponsesAdapter {
  override readonly name: ProviderAdapter['name'] = 'openrouter';

  constructor(config: OpenRouterResponsesAdapterConfig) {
    super({ apiKey: config.apiKey, baseURL: config.baseURL ?? 'https://openrouter.ai' });
  }

  override baseURL(): string {
    return this._baseURL ?? 'https://openrouter.ai';
  }

  override completionPath(): string {
    return '/api/v1/responses';
  }

  /** Everything this class used to do to `super.buildRequest()` — the max_tokens
   *  rename, the reasoning strip, the tier remap, the routing passthrough — is the
   *  `openrouter` overlay in the shared spec. Naming the flavor IS the override now. */
  protected override readonly wireFlavor: string = 'openrouter';
}
