/** LLMClient configuration types. */

import type { HookBus } from '../bus/hook-bus';
import type { EngineFetch, EngineFetchStream } from '../network/types';
import type { ModelCatalog } from '../plugins/model-catalog/catalog';
import type { RequestContext } from '../types/request-context';
import type { ApiType, ProviderAdapter, ProviderName } from './types/provider';
import type { NormalizedRequest } from './types/request';

/** Function that builds a ProviderAdapter for a (provider, apiKey, api, baseURL). */
export type AdapterFactory = (
  provider: ProviderName,
  apiKey: string,
  api: ApiType,
  baseURL?: string,
) => ProviderAdapter;

export interface LLMClientConfig {
  // Required, immutable
  provider: ProviderName;
  model: string;
  apiKey: string;

  // Optional defaults
  system?: string;
  baseURL?: string;
  /** Trace session id. createLLM passes `engine.sessionId`; a standalone client
   *  mints its own. Flows onto every RequestContext built by this client. */
  sessionId?: string;
  hooks?: HookBus;
  fetch?: EngineFetch;
  fetchStream?: EngineFetchStream;

  /** Provider adapter factory. createLLM supplies a default;
   *  here you can also pass a pre-built adapter or a custom factory for tests. */
  adapter?: ProviderAdapter | AdapterFactory;

  // Routing identifiers (formulas not yet supported — string only in 1.7)
  queueName?: string;
  configName?: string;
  cacheName?: string;
  cacheKeyFn?: (req: NormalizedRequest, ctx: RequestContext) => string;

  // Mode + chain
  api?: ApiType | 'auto';
  mode?: 'foreground' | 'background';
  batchable?: boolean;
  priority?: number;

  /** Model catalog — source of truth for server-state retention / model-binding.
   *  createLLM supplies `engine.catalog`. An empty catalog still yields correct
   *  provider-level defaults, so this is optional. */
  catalog?: ModelCatalog;
}
