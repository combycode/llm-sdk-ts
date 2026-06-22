/** Model listing.
 *
 *  `listModels()` — the SDK's curated local catalog (sync, no network). The
 *  fast primary answer: ModelInfo with pricing + capabilities.
 *
 *  `listModelsLive()` — live availability from the provider's /models endpoint,
 *  ENRICHED by default (merged with the frozen catalog; for OpenRouter, which
 *  isn't bundled, built straight from the live API incl. prices). Pass
 *  `{ raw: true }` for bare id strings. Results are cached IN MEMORY for 24h
 *  (override with `refresh: true`). */

import type { ProviderName } from '../llm/types/provider';
import type { ModelCapabilities, ModelInfo, ModelPricing } from '../plugins/model-catalog/catalog';
import { isBrowser } from '../runtime/runtime';
import { coreRegistry, type EngineHandle } from './engine';
import { ANTHROPIC_API_VERSION } from '../llm/providers/anthropic/constants';

/** Curated local catalog (the main answer). */
export function listModels(
  opts: { provider?: ProviderName; engine?: EngineHandle } = {},
): ModelInfo[] {
  const engine = opts.engine ?? coreRegistry.get();
  return engine.catalog.list(opts.provider);
}

export interface ListModelsLiveOptions {
  provider: ProviderName;
  apiKey?: string;
  engine?: EngineHandle;
  /** Return bare id strings instead of enriched ModelInfo. */
  raw?: boolean;
  /** Bypass the 24h memory cache and re-fetch. */
  refresh?: boolean;
}

interface LiveSpec {
  url: string;
  headers: (key: string) => Record<string, string>;
  /** Provider response body → array of raw model objects. */
  items: (body: Record<string, unknown>) => Array<Record<string, unknown>>;
  /** raw object → callable id. */
  id: (m: Record<string, unknown>) => string;
}

const LIVE: Partial<Record<ProviderName, LiveSpec>> = {
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (k) => ({ authorization: `Bearer ${k}` }),
    items: (b) => (b.data as Array<Record<string, unknown>>) ?? [],
    id: (m) => m.id as string,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/models',
    headers: (k) => ({ authorization: `Bearer ${k}` }),
    items: (b) => (b.data as Array<Record<string, unknown>>) ?? [],
    id: (m) => m.id as string,
  },
  xai: {
    url: 'https://api.x.ai/v1/models',
    headers: (k) => ({ authorization: `Bearer ${k}` }),
    items: (b) => (b.data as Array<Record<string, unknown>>) ?? [],
    id: (m) => m.id as string,
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    // Mirror the chat adapter: Anthropic rejects browser requests without the
    // explicit opt-in header, so the /models call must send it too.
    headers: (k) => ({
      'x-api-key': k,
      'anthropic-version': ANTHROPIC_API_VERSION,
      ...(isBrowser() ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
    }),
    items: (b) => (b.data as Array<Record<string, unknown>>) ?? [],
    id: (m) => m.id as string,
  },
  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    headers: (k) => ({ 'x-goog-api-key': k }),
    items: (b) => (b.models as Array<Record<string, unknown>>) ?? [],
    id: (m) => (m.name as string).replace(/^models\//, ''),
  },
};

// ─── in-memory cache (24h TTL) ───
const TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; body: Record<string, unknown> }>();
/** Per-provider in-flight fetches, so concurrent callers share one request. */
const inflight = new Map<string, Promise<Record<string, unknown>>>();
/** Test/maintenance hook. */
export function clearLiveModelsCache(): void {
  cache.clear();
}

const minimalCaps = (): ModelCapabilities => ({
  toolUse: true,
  streaming: true,
  structuredOutput: false,
  vision: false,
  audio: false,
  video: false,
  imageGeneration: false,
  audioGeneration: false,
  videoGeneration: false,
});
const noReasoning = () => ({ supported: false, automatic: false, effortControl: false, encryptedContent: false, summaryAvailable: false });

/** OpenRouter object → ModelInfo (OR isn't bundled, so we build it live). */
function orToModelInfo(m: Record<string, unknown>): ModelInfo {
  const id = m.id as string;
  const pr = (m.pricing as Record<string, string>) ?? {};
  const num = (v?: string) => {
    if (v == null) return undefined;
    const n = Number(v) * 1e6;
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6) / 1e6 : undefined;
  };
  const params = (m.supported_parameters as string[]) ?? [];
  const inMods = ((m.architecture as Record<string, unknown>)?.input_modalities as string[]) ?? [];
  const pricing: ModelPricing = {};
  const input = num(pr.prompt);
  const output = num(pr.completion);
  if (input != null) pricing.inputPerMTok = input;
  if (output != null) pricing.outputPerMTok = output;
  const capabilities: ModelCapabilities = {
    ...minimalCaps(),
    toolUse: params.includes('tools'),
    structuredOutput: params.includes('structured_outputs'),
    vision: inMods.includes('image'),
    audio: inMods.includes('audio'),
  };
  return {
    provider: 'openrouter',
    model: id,
    providerModelName: id,
    pricing,
    preferredApi: 'completions',
    supportedApis: ['completions'],
    contextWindow: m.context_length as number | undefined,
    capabilities,
    reasoning: { ...noReasoning(), supported: params.includes('reasoning') },
    active: true,
  };
}

/** Live items → enriched ModelInfo[]: native = frozen entry per live id (live-only
 *  ids get a minimal entry); openrouter = built straight from the live API. */
function enrichLive(
  provider: ProviderName,
  items: Array<Record<string, unknown>>,
  engine: EngineHandle,
): ModelInfo[] {
  if (provider === 'openrouter') return items.map(orToModelInfo);
  const spec = LIVE[provider]!;
  return items.map((m) => {
    const id = spec.id(m);
    const known = engine.catalog.get(provider, id);
    if (known) return known;
    return {
      provider,
      model: id,
      providerModelName: id,
      pricing: {},
      preferredApi: engine.catalog.getPreferredApi(provider, id) ?? 'completions',
      supportedApis: ['completions'],
      capabilities: minimalCaps(),
      reasoning: noReasoning(),
      active: true,
    } satisfies ModelInfo;
  });
}

async function fetchLiveBody(opts: ListModelsLiveOptions): Promise<Record<string, unknown>> {
  const engine = opts.engine ?? coreRegistry.get();
  const spec = LIVE[opts.provider];
  if (!spec) throw new Error(`listModelsLive: no live models endpoint for provider "${opts.provider}".`);

  if (!opts.refresh) {
    const cached = cache.get(opts.provider);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.body;
    // Share an already-running fetch — concurrent callers (e.g. a React effect
    // double-fired by StrictMode) must not each hit the network.
    const pending = inflight.get(opts.provider);
    if (pending) return pending;
  }

  const apiKey = opts.apiKey ?? engine.apiKeys[opts.provider];
  if (!apiKey) throw new Error(`listModelsLive: no API key for provider "${opts.provider}".`);

  const p = (async () => {
    const res = await engine.fetch(
      {
        url: spec.url,
        method: 'GET',
        headers: spec.headers(apiKey),
        body: undefined,
        provider: opts.provider,
        // Model-agnostic endpoint — name the queue explicitly so it isn't the
        // dangling `provider/` derived from an empty model.
        model: 'models',
        responseType: 'json',
      },
      { queueName: `${opts.provider}/models` },
    );
    const body = res.body as Record<string, unknown>;
    cache.set(opts.provider, { at: Date.now(), body });
    return body;
  })();

  inflight.set(opts.provider, p);
  try {
    return await p;
  } finally {
    inflight.delete(opts.provider);
  }
}

/** Live models — enriched ModelInfo by default; `raw:true` → bare id strings.
 *  Cached in memory for 24h (use `refresh:true` to force). Routes through
 *  engine.fetch like every other call (central queue, hooks, rate-limit). */
export async function listModelsLive(opts: ListModelsLiveOptions & { raw: true }): Promise<string[]>;
export async function listModelsLive(opts: ListModelsLiveOptions): Promise<ModelInfo[]>;
export async function listModelsLive(opts: ListModelsLiveOptions): Promise<ModelInfo[] | string[]> {
  const engine = opts.engine ?? coreRegistry.get();
  const spec = LIVE[opts.provider];
  if (!spec) throw new Error(`listModelsLive: no live models endpoint for provider "${opts.provider}".`);
  const body = await fetchLiveBody(opts);
  const items = spec.items(body);
  if (opts.raw) return items.map((m) => spec.id(m));
  return enrichLive(opts.provider, items, engine);
}
