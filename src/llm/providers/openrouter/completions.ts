/** OpenRouter provider adapter — OpenAI-compatible with extensions. */

import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import type { NormalizedRequest } from '../../types/request';
import { isFunctionTool } from '../../types/tools';
import { OpenAIAdapter } from '../openai/completions';

export interface OpenRouterAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class OpenRouterAdapter extends OpenAIAdapter {
  override readonly name: ProviderAdapter['name'] = 'openrouter';

  constructor(config: OpenRouterAdapterConfig) {
    super({ apiKey: config.apiKey, baseURL: config.baseURL ?? 'https://openrouter.ai' });
  }

  override baseURL(): string {
    return this._baseURL ?? 'https://openrouter.ai';
  }

  override completionPath(): string {
    return '/api/v1/chat/completions';
  }

  override buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    const result = super.buildRequest(req);
    const body = result.body as Record<string, unknown>;

    // OpenRouter uses max_tokens (not max_completion_tokens)
    if (body.max_completion_tokens) {
      body.max_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
    }

    // Unified web_search builtin → OpenRouter web search via the `:online` model
    // suffix. (super.buildRequest drops the builtin; openrouter has no tool form.)
    if (req.tools?.some((t) => !isFunctionTool(t) && t.type === 'web_search')) {
      const model = body.model as string | undefined;
      if (model && !model.endsWith(':online')) body.model = `${model}:online`;
      if (Array.isArray(body.tools) && body.tools.length === 0) delete body.tools;
    }

    // Pass through provider routing options
    if (req.providerOptions?.openrouter) {
      Object.assign(body, req.providerOptions.openrouter);
    }

    return result;
  }
}
