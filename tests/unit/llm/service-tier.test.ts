/** Service-tier support across the request → bill → cost loop. */

import { describe, expect, it } from 'bun:test';
import type { CompletionContext } from '../../../src/bus/hook-map';
import { HookBus } from '../../../src/bus/hook-bus';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { OpenAIAdapter } from '../../../src/llm/providers/openai/completions';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import type { NormalizedRequest } from '../../../src/llm/types/request';
import { parseModelTier } from '../../../src/helpers/client-resolver';
import { CostCollector } from '../../../src/plugins/cost-collector/collector';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';

const req = (over: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  ...over,
});

// ─── request mapping (per-provider, owned by the adapter) ───
describe('serviceTier → provider request param', () => {
  const openai = new OpenAIResponsesAdapter({ apiKey: 'k' });
  const completions = new OpenAIAdapter({ apiKey: 'k' });
  const anthropic = new AnthropicAdapter({ apiKey: 'k' });

  it('omits service_tier when no tier requested', () => {
    expect(openai.buildRequest(req()).body.service_tier).toBeUndefined();
    expect(anthropic.buildRequest(req()).body.service_tier).toBeUndefined();
  });

  it('openai maps standard→default, priority→priority, flex→flex, scale→scale', () => {
    expect(openai.buildRequest(req({ serviceTier: 'standard' })).body.service_tier).toBe('default');
    expect(openai.buildRequest(req({ serviceTier: 'priority' })).body.service_tier).toBe('priority');
    expect(openai.buildRequest(req({ serviceTier: 'flex' })).body.service_tier).toBe('flex');
    expect(openai.buildRequest(req({ serviceTier: 'scale' })).body.service_tier).toBe('scale');
    expect(completions.buildRequest(req({ serviceTier: 'priority' })).body.service_tier).toBe('priority');
  });

  it('openai passes an unknown-but-allowed tier through, else falls back to auto', () => {
    // 'auto' is allowed
    expect(openai.buildRequest(req({ serviceTier: 'auto' })).body.service_tier).toBe('auto');
    // a tier OpenAI doesn't accept → auto
    expect(openai.buildRequest(req({ serviceTier: 'turbo' as 'auto' })).body.service_tier).toBe('auto');
  });

  it('anthropic maps standard→standard_only, priority→auto, flex→standard_only, scale→auto', () => {
    expect(anthropic.buildRequest(req({ serviceTier: 'standard' })).body.service_tier).toBe('standard_only');
    expect(anthropic.buildRequest(req({ serviceTier: 'priority' })).body.service_tier).toBe('auto');
    expect(anthropic.buildRequest(req({ serviceTier: 'flex' })).body.service_tier).toBe('standard_only');
    expect(anthropic.buildRequest(req({ serviceTier: 'scale' })).body.service_tier).toBe('auto');
    expect(anthropic.buildRequest(req({ serviceTier: 'unknown' as 'auto' })).body.service_tier).toBe('auto');
  });
});

// ─── billed tier parsed onto Usage (raw + normalized) ───
describe('billed serviceTier → Usage', () => {
  it('openai responses: response.service_tier → serviceTier + pricingTier (default→standard)', () => {
    const a = new OpenAIResponsesAdapter({ apiKey: 'k' });
    const flex = a.parseResponse({ id: 'r', model: 'm', output: [], usage: {}, service_tier: 'flex' }, 1);
    expect(flex.usage.serviceTier).toBe('flex');
    expect(flex.usage.pricingTier).toBe('flex');
    const def = a.parseResponse({ id: 'r', model: 'm', output: [], usage: {}, service_tier: 'default' }, 1);
    expect(def.usage.pricingTier).toBe('standard');
  });

  it('anthropic: usage.service_tier → serviceTier + pricingTier (identity)', () => {
    const a = new AnthropicAdapter({ apiKey: 'k' });
    const r = a.parseResponse(
      { id: 'r', model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1, service_tier: 'batch' } },
      1,
    );
    expect(r.usage.serviceTier).toBe('batch');
    expect(r.usage.pricingTier).toBe('batch');
  });

  it('no provider tier → fields stay undefined', () => {
    const a = new AnthropicAdapter({ apiKey: 'k' });
    const r = a.parseResponse({ id: 'r', model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } }, 1);
    expect(r.usage.serviceTier).toBeUndefined();
    expect(r.usage.pricingTier).toBeUndefined();
  });
});

// ─── model:tier selector sugar ───
describe('parseModelTier', () => {
  it('strips a recognized tier suffix', () => {
    expect(parseModelTier('anthropic/claude-opus-4.8:priority')).toEqual({
      modelId: 'anthropic/claude-opus-4.8',
      serviceTier: 'priority',
    });
  });
  it('leaves OpenRouter :free / :online untouched', () => {
    expect(parseModelTier('openrouter/qwen/qwen3-coder:free')).toEqual({
      modelId: 'openrouter/qwen/qwen3-coder:free',
    });
    expect(parseModelTier('openrouter/perplexity/sonar:online')).toEqual({
      modelId: 'openrouter/perplexity/sonar:online',
    });
  });
  it('leaves a plain model id untouched', () => {
    expect(parseModelTier('anthropic/claude-opus-4.8')).toEqual({ modelId: 'anthropic/claude-opus-4.8' });
  });
});

// ─── cost prices by billed tier ───
function ctx(model: string, pricingTier?: string, serviceTier?: string): CompletionContext {
  return {
    provider: 'anthropic',
    model,
    response: {
      id: 'r',
      model,
      content: [],
      finishReason: 'stop',
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        serviceTier,
        pricingTier,
      },
      text: '',
      toolCalls: [],
      thinking: null,
      media: [],
      latencyMs: 1,
      raw: null,
    },
    request: { estimatedInputTokens: 0, inputChars: 0, messageCount: 1, hasTools: false },
    ctx: {},
  };
}

describe('cost prices by service tier', () => {
  const makeCollector = () => {
    const hooks = new HookBus();
    const catalog = new ModelCatalog();
    catalog.set('anthropic', 'opus', {
      pricing: {
        inputPerMTok: 5,
        outputPerMTok: 25, // standard: 1M in + 1M out = 5 + 25 = 30
        tiers: {
          batch: { inputPerMTok: 2.5, outputPerMTok: 12.5 }, // half
          priority: { inputPerMTok: 10, outputPerMTok: 50 }, // 2x
        },
      },
    });
    return { hooks, collector: new CostCollector({ hooks, catalog }) };
  };

  it('standard (no tier) = flat rates', async () => {
    const { hooks, collector } = makeCollector();
    await hooks.emit('onCompletion', ctx('opus'));
    expect(collector.total().total).toBeCloseTo(30, 5);
  });

  it('batch tier = half cost (the 2x overcount fix)', async () => {
    const { hooks, collector } = makeCollector();
    await hooks.emit('onCompletion', ctx('opus', 'batch', 'batch'));
    expect(collector.total().total).toBeCloseTo(15, 5);
  });

  it('priority tier = premium rates', async () => {
    const { hooks, collector } = makeCollector();
    await hooks.emit('onCompletion', ctx('opus', 'priority', 'priority'));
    expect(collector.total().total).toBeCloseTo(60, 5);
  });

  it('records the billed serviceTier on the entry', async () => {
    const { hooks, collector } = makeCollector();
    await hooks.emit('onCompletion', ctx('opus', 'batch', 'batch'));
    expect(collector.entries()[0].serviceTier).toBe('batch');
  });

  it('unknown tier falls back to flat standard', async () => {
    const { hooks, collector } = makeCollector();
    await hooks.emit('onCompletion', ctx('opus', 'mystery', 'mystery'));
    expect(collector.total().total).toBeCloseTo(30, 5);
  });
});
