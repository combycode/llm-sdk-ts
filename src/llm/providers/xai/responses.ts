/** xAI Responses API adapter.
 *  Mirrors OpenAI Responses API at api.x.ai/v1/responses.
 *  Differences:
 *  - System prompt via role:system in input (not instructions)
 *  - Reasoning automatic for reasoning models (no effort param needed)
 *  - Encrypted reasoning via include: ["reasoning.encrypted_content"]
 */

import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import type { NormalizedRequest } from '../../types/request';
import { OpenAIResponsesAdapter } from '../openai/responses';

export interface XAIResponsesAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class XAIResponsesAdapter extends OpenAIResponsesAdapter {
  override readonly name: ProviderAdapter['name'] = 'xai';

  constructor(config: XAIResponsesAdapterConfig) {
    super({ apiKey: config.apiKey, baseURL: config.baseURL ?? 'https://api.x.ai' });
  }

  override baseURL(): string {
    return this._baseURL ?? 'https://api.x.ai';
  }

  override buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    const result = super.buildRequest(req);
    const body = result.body as Record<string, unknown>;

    // xAI: system prompt goes in input as role:system, not as instructions
    if (req.system && body.instructions) {
      const input = body.input as unknown[];
      input.unshift({ role: 'system', content: req.system });
      delete body.instructions;
    }

    // xAI reasoning models reason automatically — remove reasoning param
    // Only grok-4.20-multi-agent uses reasoning.effort (for agent count)
    if (!req.model.includes('multi-agent')) {
      delete body.reasoning;
    }

    return result;
  }
}
