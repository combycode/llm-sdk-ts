/** OpenRouter provider adapter — OpenAI-compatible with extensions. */

import type { SSEEvent } from '../../../network/types';
import type { ProviderAdapter, } from '../../types/provider';
import type { CompletionResponse } from '../../types/response';
import type { StreamEvent } from '../../types/stream';
import { OpenAIAdapter, type OpenAIStreamState } from '../openai/completions';

export interface OpenRouterAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** OpenRouter's `:online` web search surfaces as `url_citation` annotations on the
 *  message/delta (there is no discrete tool-call item). Their presence is the signal
 *  that web search ran, so it maps to a unified `web_search` builtin-tool call. */
function hasUrlCitation(annotations: unknown): boolean {
  return (
    Array.isArray(annotations) &&
    annotations.some((a) => (a as Record<string, unknown>)?.type === 'url_citation')
  );
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

  /** Everything this class used to do to `super.buildRequest()` — the max_tokens
   *  rename, the reasoning strip, the tier remap, the routing passthrough — is the
   *  `openrouter` overlay in the shared spec. Naming the flavor IS the override now. */
  protected override readonly wireFlavor: string = 'openrouter';

  override parseResponse(raw: unknown, latencyMs: number): CompletionResponse {
    const result = super.parseResponse(raw, latencyMs);
    const choices = (raw as Record<string, unknown>).choices as Array<Record<string, unknown>>;
    const annotations = (choices?.[0]?.message as Record<string, unknown>)?.annotations;
    if (hasUrlCitation(annotations)) {
      result.builtinToolCalls = [...(result.builtinToolCalls ?? []), { tool: 'web_search' }];
    }
    return result;
  }

  /** Stateful — emit a single `web_search` builtin-tool pair the first time
   *  `url_citation` annotations appear in the stream (the `:online` search signal). */
  override createStreamParser(): (event: SSEEvent) => StreamEvent[] {
    let webSearchEmitted = false;
    const state: OpenAIStreamState = { toolIdByIndex: new Map() };
    return (event: SSEEvent): StreamEvent[] => {
      const events = this.parseStreamEvent(event, state);
      if (!webSearchEmitted) {
        const choice = (JSON.parse(event.data).choices as Array<Record<string, unknown>>)?.[0];
        const annotations =
          (choice?.delta as Record<string, unknown>)?.annotations ??
          (choice?.message as Record<string, unknown>)?.annotations;
        if (hasUrlCitation(annotations)) {
          webSearchEmitted = true;
          events.push(
            { type: 'builtin_tool_start', tool: 'web_search' },
            { type: 'builtin_tool_end', tool: 'web_search' },
          );
        }
      }
      return events;
    };
  }
}
