/** ClientResolver — turns a `"provider/model"` string into a pooled LLMClient.
 *
 *  Lives on the orchestrator so every module registered with it can share one
 *  pool of clients (one per provider, keyed per-model only when the catalog
 *  marks `requiresDedicatedClient`). Wraps the same ClientPool used by
 *  internal-tool-runners — one keying policy across the SDK. */

import type { LLMClient } from '../llm/client';
import type { LLMClientConfig } from '../llm/client-config';
import type { HookBus } from '../bus/hook-bus';
import type { ProviderName } from '../llm/types/provider';
import type { ServiceTier } from '../llm/types/tiers';
import type { ModelCatalog } from '../plugins/model-catalog/catalog';
import type { EngineFetch, EngineFetchStream, HttpRequest, HttpResponse } from '../network/types';
import { ClientPool } from './client-pool';

/** Direct-HTTP EngineFetch — bypasses NetworkEngine queue/retry. Used as a
 *  zero-config fallback when ClientResolver isn't given an explicit fetch
 *  (e.g. tests). Production callers should pass `engine.fetch`. */
function directFetch(): EngineFetch {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const init: RequestInit = {
      method: req.method ?? 'POST',
      headers: req.headers,
      body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
    };
    if (req.signal) init.signal = req.signal;
    const res = await globalThis.fetch(req.url, init);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, headers, body };
  };
}

export interface ClientResolverConfig {
  /** provider → API key. Providers absent from this map can't be resolved. */
  apiKeys: Partial<Record<ProviderName, string>>;
  /** Hooks piped to every constructed LLMClient. */
  hooks: HookBus;
  /** Fetch function (typically engine.fetch). When absent, falls back to
   *  `globalThis.fetch.bind(globalThis)` — fine for simple direct-call use,
   *  bypasses the NetworkEngine queue + retry. Pass engine.fetch for
   *  production. */
  fetch?: EngineFetch;
  /** Streaming fetch (typically engine.fetchStream). Optional. */
  fetchStream?: EngineFetchStream;
  /** Catalog drives pool keying (requiresDedicatedClient) + capability hints. */
  catalog?: ModelCatalog;
  /** Extra LLMClient options applied to every resolved client. */
  clientOptions?: Partial<
    Omit<
      LLMClientConfig,
      'provider' | 'apiKey' | 'hooks' | 'catalog' | 'model' | 'fetch' | 'fetchStream'
    >
  >;
}

export interface ResolvedClient {
  client: LLMClient;
  provider: ProviderName;
  model: string;
}

export class ClientResolver {
  private readonly pool: ClientPool;

  constructor(private readonly cfg: ClientResolverConfig) {
    this.pool = new ClientPool(cfg.catalog);
  }

  /** Turn `"anthropic/claude-haiku-4-5"` → resolved client. */
  resolve(modelId: string): ResolvedClient {
    const [provider, model] = parseModelId(modelId);
    const apiKey = this.cfg.apiKeys[provider];
    if (!apiKey) {
      const known = Object.keys(this.cfg.apiKeys).filter(
        (k) => !!this.cfg.apiKeys[k as ProviderName],
      );
      throw new Error(
        `ClientResolver: no API key for provider "${provider}". Configured providers: [${known.join(', ') || 'none'}]`,
      );
    }
    const fetchFn = this.cfg.fetch ?? directFetch();
    const client = this.pool.get(provider, model, {
      provider,
      apiKey,
      hooks: this.cfg.hooks,
      model,
      fetch: fetchFn,
      fetchStream: this.cfg.fetchStream,
      ...this.cfg.clientOptions,
    });
    return { client, provider, model };
  }

  availableProviders(): ProviderName[] {
    return (Object.keys(this.cfg.apiKeys) as ProviderName[]).filter((p) => !!this.cfg.apiKeys[p]);
  }

  async destroy(): Promise<void> {
    await this.pool.destroy();
  }

  get size(): number {
    return this.pool.size;
  }
}

export function parseModelId(modelId: string): [ProviderName, string] {
  const slash = modelId.indexOf('/');
  if (slash <= 0 || slash === modelId.length - 1) {
    throw new Error(`Invalid model id "${modelId}" — expected format "provider/model"`);
  }
  const provider = modelId.slice(0, slash) as ProviderName;
  const model = modelId.slice(slash + 1);
  return [provider, model];
}

export function isNamespacedModelId(modelId: string): boolean {
  const slash = modelId.indexOf('/');
  return slash > 0 && slash < modelId.length - 1;
}

/** Resolve a model + optional provider to a concrete { provider, model }.
 *  A namespaced id ("provider/model") yields its own provider; a bare model
 *  requires an explicit `provider`. `label` names the caller in the error. */
export function resolveModel(
  model: string,
  provider: ProviderName | undefined,
  label: string,
): { provider: ProviderName; model: string } {
  if (isNamespacedModelId(model)) {
    const [p, m] = parseModelId(model);
    return { provider: p, model: m };
  }
  if (!provider) {
    throw new Error(
      `${label}: bare model "${model}" requires a provider — pass it explicitly or use "provider/model".`,
    );
  }
  return { provider, model };
}

/** Recognized tier suffixes for the `model:tier` selector sugar. Deliberately an
 *  ALLOWLIST — OpenRouter ids legitimately end in `:free` / `:online`, which must
 *  NOT be mistaken for a service tier. */
const TIER_SUFFIXES = new Set(['auto', 'standard', 'priority', 'flex', 'scale']);

/** Split a trailing `:tier` off a model id, but only when the suffix is a known
 *  service tier. `"anthropic/claude-opus-4.8:priority"` → { modelId:
 *  "anthropic/claude-opus-4.8", serviceTier: "priority" }; `"…/qwen3-coder:free"`
 *  → unchanged (`:free` is an OpenRouter variant, not a tier). */
export function parseModelTier(modelId: string): { modelId: string; serviceTier?: ServiceTier } {
  const colon = modelId.lastIndexOf(':');
  if (colon <= 0) return { modelId };
  const suffix = modelId.slice(colon + 1);
  if (!TIER_SUFFIXES.has(suffix)) return { modelId };
  return { modelId: modelId.slice(0, colon), serviceTier: suffix as ServiceTier };
}
