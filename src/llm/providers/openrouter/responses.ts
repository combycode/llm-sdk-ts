/** OpenRouter Responses API adapter.
 *  Drop-in replacement for OpenAI Responses API at openrouter.ai/api/v1/responses.
 *  Stateless: no previous_response_id support (beta limitation). */

import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import type { NormalizedRequest } from '../../types/request';
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

  override buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    const result = super.buildRequest(req);

    // Pass through provider routing options
    if (req.providerOptions?.openrouter) {
      Object.assign(result.body, req.providerOptions.openrouter);
    }

    return result;
  }
}
