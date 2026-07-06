/** OpenRouter provider adapter — OpenAI-compatible with extensions. */

import type { SSEEvent } from '../../../network/types';
import type { ProviderAdapter, ProviderHttpRequest } from '../../types/provider';
import type { NormalizedRequest } from '../../types/request';
import type { CompletionResponse } from '../../types/response';
import type { StreamEvent } from '../../types/stream';
import { isFunctionTool } from '../../types/tools';
import { OpenAIAdapter } from '../openai/completions';

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
    return (event: SSEEvent): StreamEvent[] => {
      const events = this.parseStreamEvent(event);
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
