/** xAI (Grok) provider adapter — OpenAI-compatible Chat Completions.
 *  Key differences from OpenAI:
 *  - Uses max_tokens (not max_completion_tokens)
 *  - Reasoning via model variant (grok-*-reasoning), not reasoning param
 *  - Returns reasoning_content in message (plain text, unlike OpenAI which hides it)
 */

import type { ProviderAdapter } from '../../types/provider';
import type { CompletionResponse } from '../../types/response';
import { OpenAIAdapter } from '../openai/completions';

export interface XAIAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

export class XAIAdapter extends OpenAIAdapter {
  override readonly name: ProviderAdapter['name'] = 'xai';

  constructor(config: XAIAdapterConfig) {
    super({ apiKey: config.apiKey, baseURL: config.baseURL ?? 'https://api.x.ai' });
  }

  override baseURL(): string {
    return this._baseURL ?? 'https://api.x.ai';
  }

  /** Everything this class used to do to `super.buildRequest()` — the max_tokens
   *  rename, the reasoning strip, the tier remap, the routing passthrough — is the
   *  `xai` overlay in the shared spec. Naming the flavor IS the override now. */
  protected override readonly wireFlavor: string = 'xai';

  override parseResponse(raw: unknown, latencyMs: number): CompletionResponse {
    const result = super.parseResponse(raw, latencyMs);

    // xAI returns reasoning_content as plain text in Chat Completions
    const r = raw as Record<string, unknown>;
    const choices = (r.choices as Array<Record<string, unknown>>) ?? [];
    const message = (choices[0]?.message as Record<string, unknown>) ?? {};
    const reasoningContent = message.reasoning_content as string | null;

    if (reasoningContent) {
      result.thinking = reasoningContent;
    }

    return result;
  }
}
