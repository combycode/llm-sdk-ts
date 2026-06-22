/** createLLM — convenience helper that builds an LLMClient using the
 *  current EngineHandle (or the global coreRegistry default) for fetch +
 *  hooks. Auto-resolves a default ProviderAdapter when none is supplied
 *  (anthropic/openai/google/xai/openrouter). Accepts model in either
 *  flat form (`{provider, model, apiKey}`) or namespaced form
 *  (`{model: 'provider/name'}` — apiKey looked up on engine.apiKeys). */

import { LLMClient } from '../llm/client';
import type { LLMClientConfig } from '../llm/client-config';
import type { ApiType, ProviderAdapter, ProviderName } from '../llm/types/provider';
import { AnthropicAdapter } from '../llm/providers/anthropic/messages';
import { OpenAIAdapter } from '../llm/providers/openai/completions';
import { OpenAIResponsesAdapter } from '../llm/providers/openai/responses';
import { GoogleAdapter } from '../llm/providers/google/generate';
import { GoogleInteractionsAdapter } from '../llm/providers/google/interactions';
import { XAIAdapter } from '../llm/providers/xai/completions';
import { XAIResponsesAdapter } from '../llm/providers/xai/responses';
import { OpenRouterAdapter } from '../llm/providers/openrouter/completions';
import { OpenRouterResponsesAdapter } from '../llm/providers/openrouter/responses';
import { resolveModel } from './client-resolver';
import type { EngineHandle } from './engine';
import { coreRegistry } from './engine';

export interface CreateLLMOptions
  extends Omit<
    LLMClientConfig,
    'provider' | 'apiKey' | 'model' | 'fetch' | 'fetchStream' | 'hooks'
  > {
  /** Model string. Either bare (e.g. `claude-haiku-4-5` — pair with `provider`)
   *  or namespaced (e.g. `anthropic/claude-haiku-4-5` — provider parsed). */
  model: string;
  /** Required when `model` is bare. Ignored when `model` is namespaced. */
  provider?: ProviderName;
  /** Optional — falls back to `engine.apiKeys[provider]` when omitted. */
  apiKey?: string;
  engine?: EngineHandle;
  hooks?: LLMClientConfig['hooks'];
  fetch?: LLMClientConfig['fetch'];
  fetchStream?: LLMClientConfig['fetchStream'];
}

export function createLLM(opts: CreateLLMOptions): LLMClient {
  const engine = opts.engine ?? coreRegistry.get();
  const { provider, model } = resolveModel(opts.model, opts.provider, 'createLLM');
  // Translate our normalised slug → the exact provider-callable id (the catalog's
  // alias index). An already-callable id or an unknown model passes through.
  const sendModel = engine.catalog.resolveModelId(provider, model);
  const apiKey = opts.apiKey ?? engine.apiKeys[provider];
  if (!apiKey) {
    throw new Error(
      `createLLM: no API key for provider "${provider}". ` +
        `Pass apiKey directly or set engine.apiKeys["${provider}"] via createEngine.`,
    );
  }
  const adapter = opts.adapter ?? defaultAdapterFactory();
  return new LLMClient({
    ...opts,
    provider,
    model: sendModel,
    apiKey,
    adapter,
    fetch: opts.fetch ?? engine.fetch,
    fetchStream: opts.fetchStream ?? engine.fetchStream,
    hooks: opts.hooks ?? engine.hooks,
    sessionId: engine.sessionId,
    catalog: engine.catalog,
  });
}

function defaultAdapterFactory() {
  return (
    provider: ProviderName,
    apiKey: string,
    api: ApiType,
    baseURL?: string,
  ): ProviderAdapter => {
    const cfg = { apiKey, baseURL };
    switch (provider) {
      case 'anthropic':
        return new AnthropicAdapter(cfg);
      case 'openai':
        return api === 'responses' ? new OpenAIResponsesAdapter(cfg) : new OpenAIAdapter(cfg);
      case 'google':
        return api === 'interactions' ? new GoogleInteractionsAdapter(cfg) : new GoogleAdapter(cfg);
      case 'xai':
        return api === 'responses' ? new XAIResponsesAdapter(cfg) : new XAIAdapter(cfg);
      case 'openrouter':
        return api === 'responses'
          ? new OpenRouterResponsesAdapter(cfg)
          : new OpenRouterAdapter(cfg);
      default:
        throw new Error(`createLLM: no default adapter for provider '${provider}'`);
    }
  };
}
