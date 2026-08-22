/** The catalog, not a regex, decides how to talk to a model.
 *
 *  Two shipped bugs came from adapters parsing the model id to pick a wire shape:
 *  2.2.1 (Anthropic flipped `thinking` at 4.6) and the 4.0 date-suffix defect in
 *  039 A1. The catalog already knew what a model could DO; nothing knew how to
 *  SAY it. `ModelInfo.wire` closes that, and `LLMClient` resolves it onto each
 *  request as `NormalizedRequest.wire`.
 *
 *  What has to be true, and is tested here:
 *    1. when the catalog carries a trait, the adapter follows it — even when it
 *       CONTRADICTS what the id would imply, which is the only way to prove the
 *       catalog is actually driving;
 *    2. when the catalog is silent, the id-parse fallback still works, so a
 *       catalog-less engine is unaffected.
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { ModelCatalog } from '../../../src/catalog/catalog';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const anthropic = new AnthropicAdapter({ apiKey: 'k' });
const google = new GoogleAdapter({ apiKey: 'k' });

const req = (extra: Partial<NormalizedRequest>): NormalizedRequest =>
  ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra }) as NormalizedRequest;

describe('catalog-driven wire traits', () => {
  it('the bundled catalog carries wire traits for every Anthropic chat model', () => {
    const c = new ModelCatalog();
    c.loadProviderDefaults();
    const sonnet5 = c.get('anthropic', 'claude-sonnet-5');
    expect(sonnet5?.wire).toEqual({ thinking: 'adaptive', topK: false });
    const haiku = c.get('anthropic', 'claude-haiku-4.5');
    expect(haiku?.wire).toEqual({ thinking: 'budgeted', topK: true });
    // The 039 A1 model: 4.0 predates adaptive thinking.
    expect(c.get('anthropic', 'claude-opus-4')?.wire?.thinking).toBe('budgeted');
  });

  it('and for Google chat models, split at the 2.5 / 3.x boundary', () => {
    const c = new ModelCatalog();
    c.loadProviderDefaults();
    expect(c.get('google', 'gemini-2.5-flash')?.wire?.thinking).toBe('budget');
    expect(c.get('google', 'gemini-3-flash')?.wire?.thinking).toBe('level');
  });

  describe('the catalog OVERRIDES the id', () => {
    it('anthropic: a budgeted trait beats an id that parses as adaptive', () => {
      // `claude-sonnet-5` parses as adaptive; the catalog says otherwise here.
      const body = anthropic.buildRequest(
        req({ model: 'claude-sonnet-5', thinking: { mode: 'on' }, wire: { thinking: 'budgeted' } }),
      ).body as any;
      expect(body.thinking.type).toBe('enabled');
      expect(body.thinking.budget_tokens).toBeGreaterThan(0);
    });

    it('anthropic: an adaptive trait beats an id that parses as budgeted', () => {
      const body = anthropic.buildRequest(
        req({ model: 'claude-3-5-sonnet-latest', thinking: { mode: 'on' }, wire: { thinking: 'adaptive' } }),
      ).body as any;
      expect(body.thinking).toEqual({ type: 'adaptive' });
    });

    it('anthropic: topK:false suppresses top_k on a model whose id accepts it', () => {
      const body = anthropic.buildRequest(
        req({ model: 'claude-opus-4-6', topK: 20, wire: { topK: false } }),
      ).body as any;
      expect(body.top_k).toBeUndefined();
    });

    it('anthropic: topK:true sends top_k on a model whose id rejects it', () => {
      const body = anthropic.buildRequest(
        req({ model: 'claude-sonnet-5', topK: 20, wire: { topK: true } }),
      ).body as any;
      expect(body.top_k).toBe(20);
    });

    it('google: a level trait beats a 2.5 id', () => {
      const body = google.buildRequest(
        req({ model: 'gemini-2.5-flash', thinking: { mode: 'on' }, wire: { thinking: 'level' } }),
      ).body as any;
      expect(body.generationConfig.thinkingConfig.thinkingLevel).toBeDefined();
      expect(body.generationConfig.thinkingConfig.thinkingBudget).toBeUndefined();
    });

    it('google: a budget trait beats a 3.x id', () => {
      const body = google.buildRequest(
        req({ model: 'gemini-3-flash', thinking: { mode: 'on' }, wire: { thinking: 'budget' } }),
      ).body as any;
      expect(body.generationConfig.thinkingConfig.thinkingBudget).toBeGreaterThan(0);
      expect(body.generationConfig.thinkingConfig.thinkingLevel).toBeUndefined();
    });
  });

  describe('falls back to the id when the catalog is silent', () => {
    it('anthropic thinking', () => {
      expect((anthropic.buildRequest(req({ model: 'claude-sonnet-5', thinking: { mode: 'on' } })).body as any).thinking.type).toBe('adaptive');
      expect((anthropic.buildRequest(req({ model: 'claude-3-5-sonnet-latest', thinking: { mode: 'on' } })).body as any).thinking.type).toBe('enabled');
    });

    it('anthropic top_k', () => {
      expect((anthropic.buildRequest(req({ model: 'claude-opus-4-6', topK: 20 })).body as any).top_k).toBe(20);
      expect((anthropic.buildRequest(req({ model: 'claude-sonnet-5', topK: 20 })).body as any).top_k).toBeUndefined();
    });

    it('google thinking', () => {
      const b25 = google.buildRequest(req({ model: 'gemini-2.5-flash', thinking: { mode: 'on' } })).body as any;
      const b3 = google.buildRequest(req({ model: 'gemini-3-flash', thinking: { mode: 'on' } })).body as any;
      expect(b25.generationConfig.thinkingConfig.thinkingBudget).toBeGreaterThan(0);
      expect(b3.generationConfig.thinkingConfig.thinkingLevel).toBeDefined();
    });
  });
});

/** The adapter tests above pass `wire` directly. This one proves the LINK: that
 *  `LLMClient` resolves the trait from its catalog onto every request it builds.
 *  Without it the field would be dead weight and the adapters would silently keep
 *  using the id parse. The catalog here deliberately CONTRADICTS the model id, so
 *  a pass can only mean the catalog reached the wire. */
describe('LLMClient resolves wire traits from its catalog', () => {
  it('sends the catalog shape, not the one the model id implies', async () => {
    const { LLMClient } = await import('../../../src/llm/client');
    const { AnthropicAdapter } = await import('../../../src/llm/providers/anthropic/messages');

    const catalog = new ModelCatalog();
    // claude-sonnet-5 parses as `adaptive`; the catalog says `budgeted`.
    catalog.set('anthropic', 'claude-sonnet-5', {
      pricing: { inputPerMTok: 1, outputPerMTok: 1 },
      wire: { thinking: 'budgeted', topK: true },
    });

    let sent: any;
    const client = new LLMClient({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: 'k',
      adapter: new AnthropicAdapter({ apiKey: 'k' }),
      catalog,
      fetch: (async (r: any) => {
        sent = r;
        return {
          status: 200,
          headers: {},
          body: {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
      }) as any,
    } as any);

    await client.complete('hi', { thinking: { mode: 'on' }, topK: 20 });

    expect(sent.body.thinking.type).toBe('enabled'); // budgeted, per the catalog
    expect(sent.body.thinking.budget_tokens).toBeGreaterThan(0);
    expect(sent.body.top_k).toBe(20); // topK:true, though the id would drop it
  });
});
