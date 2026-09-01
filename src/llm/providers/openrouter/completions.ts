/** OpenRouter provider adapter — OpenAI-compatible with extensions. */

import type { ProviderAdapter } from '../../types/provider';
import { OpenAIAdapter } from '../openai/completions';
import type { Registry } from '../../../wire/interpreter';
import { OPENROUTER_RESPONSE_REGISTRY } from './response-registry';
import { OPENROUTER_STREAM_REGISTRY } from './stream-registry';

export interface OpenRouterAdapterConfig {
  apiKey: string;
  baseURL?: string;
}

/** OpenRouter's `:online` web search surfaces as `url_citation` annotations on the
 *  message/delta (there is no discrete tool-call item). Their presence is the signal
 *  that web search ran, so it maps to a unified `web_search` builtin-tool call. */
function _hasUrlCitation(annotations: unknown): boolean {
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

  /** The `:online` web-search rule that used to live in an override is the
   *  `openrouter` delta of the shared response spec. Naming the spec IS the
   *  override now, exactly as `wireFlavor` is for the request side. */
  protected override responseSpecId(): string {
    return 'openrouter/completions.response';
  }

  protected override responseRegistry(): Registry {
    return OPENROUTER_RESPONSE_REGISTRY;
  }

  /** The `:online` web-search pair is the `openrouter` delta of the shared
   *  stream spec, so naming the spec IS the override -- as it already is for the
   *  request side and the buffered response. */
  protected override streamSpecId(): string {
    return 'openrouter/completions.stream';
  }

  protected override streamRegistry(): Registry {
    return OPENROUTER_STREAM_REGISTRY;
  }
}
