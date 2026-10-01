/** LLMClient configuration types. */

import type { HookBus } from '../bus/hook-bus';
import type { EngineFetch, EngineFetchStream } from '../network/types';
import type { ModelCatalog } from '../catalog/catalog';
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
  /** OpenAI only: call a named region's host instead of writing one by hand.
   *
   *  `'global' | 'us' | 'eu' | 'ae'`, resolving to `api.openai.com` and
   *  `{region}.api.openai.com`. A project provisioned for one region must use that
   *  region's host, and the wrong choice fails loudly rather than leaking: measured
   *  2026-10-01 from an unrestricted project, `us.` answers `Attempted to access
   *  resource with incorrect regional hostname` and `eu.` answers `This endpoint is
   *  only accessible by projects with geography restrictions enabled`.
   *
   *  **Mutually exclusive with `baseURL`**, and setting both THROWS rather than
   *  picking a winner: they are two different answers to "which host", so honouring
   *  one would silently discard a configuration the caller wrote.
   *
   *  Setting it on any other provider also THROWS -- none of them has regional
   *  hosts, and ignoring it would let a caller believe their data was pinned to a
   *  region when the option did nothing at all. */
  dataResidency?: import('./providers/openai/data-residency').OpenAIDataResidency;
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

  /** Warn when a provider's response stops looking like the one we learned to
   *  read — a field we have never seen, a field that was always there and is now
   *  absent, or a discriminator carrying a value nothing branches on.
   *
   *  OFF by default and never changes what is parsed: it only emits `onWarning`.
   *  `createEngine({ checkResponseShapes: true })` turns it on for every client
   *  the engine builds. See `src/llm/response-shape.ts`. */
  checkResponseShapes?: boolean;
}
