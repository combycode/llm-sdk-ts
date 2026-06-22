/** countTokens() — thin convenience over the existing ContextMeasurer token
 *  counters. Does NOT implement counting itself: it builds a HybridTokenCounter
 *  from the engine catalog (which routes per model to tiktoken / provider
 *  count-API / heuristic) and calls it.
 *
 *    const n = await countTokens({ model: 'openai/gpt-5.4-nano', input: 'hello' });
 *
 *  `exact:true` (default) uses the precise path where available — tiktoken for
 *  OpenAI, the count-API for Anthropic/Google (needs apiKey) — and falls back to
 *  the calibrated heuristic otherwise. `exact:false` is always a sync estimate. */

import type { Message } from '../llm/types/messages';
import type { ProviderName } from '../llm/types/provider';
import { HybridTokenCounter } from '../plugins/context-measurer/counter/hybrid';
import { resolveModel } from './client-resolver';
import { coreRegistry, type EngineHandle } from './engine';

const COUNT_API_NOTE = 'free: provider does not bill count endpoint';

export interface CountTokensOptions {
  /** Model string. Bare (`gpt-5.4-nano`, pair with `provider`) or namespaced. */
  model: string;
  provider?: ProviderName;
  /** Text or messages to count. */
  input: string | Message[];
  /** Key for the exact count-API path (Anthropic/Google). Falls back to engine.apiKeys. */
  apiKey?: string;
  /** Use the precise counter where available (default true). false = sync estimate. */
  exact?: boolean;
  engine?: EngineHandle;
}

export async function countTokens(opts: CountTokensOptions): Promise<number> {
  const engine = opts.engine ?? coreRegistry.get();
  const { provider, model } = resolveModel(opts.model, opts.provider, 'countTokens');
  const apiKey = opts.apiKey ?? engine.apiKeys[provider];

  const countApiKeys: { anthropic?: string; google?: string } = {};
  const usesCountApi = apiKey && (provider === 'anthropic' || provider === 'google');
  if (apiKey && provider === 'anthropic') countApiKeys.anthropic = apiKey;
  if (apiKey && provider === 'google') countApiKeys.google = apiKey;

  const counter = new HybridTokenCounter({ catalog: engine.catalog, countApiKeys });
  const ctx = { provider, model };
  const exact = opts.exact ?? true;

  let result: number;
  if (typeof opts.input === 'string') {
    result = exact ? await counter.measure(opts.input, ctx) : counter.estimate(opts.input, ctx);
  } else {
    result = 0;
    for (const m of opts.input) {
      result += exact ? await counter.measureMessage(m, ctx) : counter.estimateMessage(m, ctx);
    }
  }

  // Count-API paths (Anthropic /v1/messages/count_tokens, Google :countTokens)
  // hit a provider endpoint but are explicitly free — emit an honest zero so
  // the cost ledger has a record of the call rather than silent absence.
  if (usesCountApi && exact) {
    emitCountApiZero(engine, provider, model);
  }

  return result;
}

function emitCountApiZero(engine: EngineHandle, provider: string, model: string): void {
  const entry = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    provider,
    model,
    tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
      source: 'calculated' as const,
    },
    providerEvidence: { note: COUNT_API_NOTE },
    tags: {
      provider,
      model,
      type: 'count_tokens',
    } as Record<string, string | undefined>,
  };
  engine.hooks.emitSync('onCostEntry', { entry, runningTotal: 0 });
}
