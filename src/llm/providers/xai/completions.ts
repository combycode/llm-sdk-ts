/** xAI (Grok) provider adapter — OpenAI-compatible Chat Completions.
 *  Key differences from OpenAI:
 *  - Uses max_tokens (not max_completion_tokens)
 *  - Reasoning via model variant (grok-*-reasoning), not reasoning param
 *  - Returns reasoning_content in message (plain text, unlike OpenAI which hides it)
 */

import type { SSEEvent } from '../../../network/types';
import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import type { NormalizedRequest } from '../../types/request';
import type { CompletionResponse } from '../../types/response';
import type { StreamEvent } from '../../types/stream';
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

  override buildRequest(req: NormalizedRequest): ProviderHttpRequest {
    const result = super.buildRequest(req);

    const body = result.body as Record<string, unknown>;
    // xAI uses max_tokens, not max_completion_tokens
    if (body.max_completion_tokens) {
      body.max_tokens = body.max_completion_tokens;
      delete body.max_completion_tokens;
    }

    // xAI reasoning is via model variant, not parameter
    // grok-4.20-reasoning, grok-4-1-fast-reasoning reason automatically
    delete body.reasoning;

    return result;
  }

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

  override parseStreamEvent(event: SSEEvent): StreamEvent[] {
    const events = super.parseStreamEvent(event);

    // Check for reasoning_content in streaming delta
    try {
      const data = JSON.parse(event.data) as Record<string, unknown>;
      const choices = (data.choices as Array<Record<string, unknown>>) ?? [];
      const delta = (choices[0]?.delta as Record<string, unknown>) ?? {};

      if (delta.reasoning_content) {
        // Insert thinking event before text events
        events.unshift({ type: 'thinking', text: delta.reasoning_content as string });
      }
    } catch {}

    return events;
  }
}
