/** complete() unit tests.
 *  Uses a stubbed engine.fetch that returns a canned Anthropic Messages API
 *  response, so no real provider is hit. Covers:
 *   - happy path: builds request, returns {text, response}
 *   - maxCostUsd budget guard: no maxCostUsd passes through; very high limit passes
 *   - string prompt, ContentPart[] prompt, Message[] prompt
 *   - attachments are prepended correctly
 *   - error from fetch propagates */

import { describe, expect, it } from 'bun:test';
import { complete } from '../../../src/helpers/one-shot';
import { HookBus } from '../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';
import { BudgetExceededError } from '../../../src/helpers/estimate-types';
import type { EngineHandle } from '../../../src/helpers/engine';
import type { EngineFetch, HttpResponse } from '../../../src/network/types';

// ─── Canned Anthropic response body ──────────────────────────────────────────

function anthropicOkBody(text: string, model = 'claude-haiku-4-5'): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

// ─── Engine stub that captures requests and returns canned bodies ─────────────

interface CapturedRequest { url: string; body: Record<string, unknown> }

function makeEngine(
  handler: (url: string, body: Record<string, unknown>) => { status: number; body: unknown },
  catalog?: ModelCatalog,
): EngineHandle & { captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const bus = new HookBus();
  const cat = catalog ?? new ModelCatalog();

  const fetch: EngineFetch = async (req): Promise<HttpResponse> => {
    const body = (req.body as Record<string, unknown>) ?? {};
    captured.push({ url: req.url, body });
    const { status, body: responseBody } = handler(req.url, body);
    if (status >= 400) {
      const err = new Error(`HTTP ${status}`);
      (err as unknown as Record<string, unknown>).status = status;
      throw err;
    }
    return { status, headers: {}, body: responseBody };
  };

  return {
    apiKeys: { anthropic: 'test-key' },
    catalog: cat,
    hooks: bus,
    fetch,
    fetchStream: async function* () {},
    sessionId: 'sess_test',
    destroy: () => {},
    captured,
  } as unknown as EngineHandle & { captured: CapturedRequest[] };
}

function okEngine(text: string, catalog?: ModelCatalog) {
  return makeEngine(() => ({ status: 200, body: anthropicOkBody(text) }), catalog);
}

/** Build a catalog with claude-haiku-4-5 registered (needed for budget guard). */
function catalogWithHaiku(): ModelCatalog {
  const cat = new ModelCatalog();
  cat.set('anthropic', 'claude-haiku-4-5', {
    pricing: { inputPerMTok: 0.25, outputPerMTok: 1.25 },
    maxOutput: 4096,
  });
  return cat;
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('complete — happy path', () => {
  it('returns {text, response} for a string prompt', async () => {
    const engine = okEngine('Hello from stub!');
    const result = await complete({
      model: 'anthropic/claude-haiku-4-5',
      prompt: 'Say hello',
      apiKey: 'test-key',
      engine,
    });
    expect(result.text).toBe('Hello from stub!');
    expect(result.response).toBeDefined();
    expect(result.response.finishReason).toBe('stop');
  });

  it('sends the correct model id to the provider', async () => {
    const engine = okEngine('ok');
    await complete({
      model: 'anthropic/claude-haiku-4-5',
      prompt: 'test',
      apiKey: 'test-key',
      engine,
    });
    expect(engine.captured[0].body.model).toBe('claude-haiku-4-5');
  });

  it('ContentPart[] prompt is accepted', async () => {
    const engine = okEngine('content part reply');
    const result = await complete({
      model: 'anthropic/claude-haiku-4-5',
      prompt: [{ type: 'text', text: 'From ContentPart' }],
      apiKey: 'test-key',
      engine,
    });
    expect(result.text).toBe('content part reply');
  });

  it('Message[] prompt is accepted', async () => {
    const engine = okEngine('message array reply');
    const result = await complete({
      model: 'anthropic/claude-haiku-4-5',
      prompt: [{ role: 'user', content: 'From Message array' }],
      apiKey: 'test-key',
      engine,
    });
    expect(result.text).toBe('message array reply');
  });

  it('system prompt is forwarded to the provider body', async () => {
    const engine = okEngine('ok');
    await complete({
      model: 'anthropic/claude-haiku-4-5',
      prompt: 'hi',
      apiKey: 'test-key',
      system: 'You are a test bot.',
      engine,
    });
    expect(engine.captured[0].body.system).toBe('You are a test bot.');
  });

  it('maxTokens is forwarded to the provider body', async () => {
    const engine = okEngine('ok');
    await complete({
      model: 'anthropic/claude-haiku-4-5',
      prompt: 'hi',
      apiKey: 'test-key',
      maxTokens: 42,
      engine,
    });
    expect(engine.captured[0].body.max_tokens).toBe(42);
  });

  it('parsed is undefined when no structured schema is given', async () => {
    const engine = okEngine('raw reply');
    const result = await complete({
      model: 'anthropic/claude-haiku-4-5',
      prompt: 'hi',
      apiKey: 'test-key',
      engine,
    });
    expect(result.parsed).toBeUndefined();
  });
});

// ─── Attachments ──────────────────────────────────────────────────────────────

describe('complete — attachments prepended', () => {
  it('ContentPart attachment prepended when prompt is a string', async () => {
    const engine = okEngine('ok');
    await complete({
      model: 'anthropic/claude-haiku-4-5',
      prompt: 'describe this',
      apiKey: 'test-key',
      attachments: [{ type: 'text', text: '[attachment text]' }],
      engine,
    });
    // The messages array should contain a user message with both parts
    const msgs = engine.captured[0].body.messages as Array<{ role: string; content: unknown }>;
    expect(msgs).toBeDefined();
    const userMsg = msgs.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    const content = userMsg!.content;
    // Should be an array with at least 2 parts (attachment + text)
    expect(Array.isArray(content)).toBe(true);
    expect((content as unknown[]).length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Budget guard smoke test ──────────────────────────────────────────────────

describe('complete — budget guard smoke', () => {
  it('no maxCostUsd: call goes through to provider (no budget error)', async () => {
    const engine = okEngine('no budget guard');
    const result = await complete({
      model: 'anthropic/claude-haiku-4-5',
      prompt: 'test',
      apiKey: 'test-key',
      // no maxCostUsd
      engine,
    });
    expect(result).not.toBeInstanceOf(BudgetExceededError);
    expect(result.text).toBe('no budget guard');
  });

  it('maxCostUsd=999 (very high): budget guard passes, normal result returned', async () => {
    // Budget guard calls estimate(), which needs the model in the catalog.
    const engine = okEngine('budget passed', catalogWithHaiku());
    const result = await complete({
      model: 'anthropic/claude-haiku-4-5',
      prompt: 'test',
      apiKey: 'test-key',
      maxCostUsd: 999,
      engine,
    });
    expect(result.text).toBe('budget passed');
  });

  it('maxCostUsd=0 with expensive model: throws BudgetExceededError before fetch', async () => {
    // Absurdly expensive pricing so even a tiny prompt overflows a $0 budget.
    const cat = new ModelCatalog();
    cat.set('anthropic', 'claude-haiku-4-5', {
      pricing: { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000 },
      maxOutput: 4096,
    });
    const engine = okEngine('should not reach', cat);
    await expect(
      complete({
        model: 'anthropic/claude-haiku-4-5',
        prompt: 'hello world',
        apiKey: 'test-key',
        maxCostUsd: 0.0000001,
        engine,
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    // fetch was never called (guard fired first)
    expect(engine.captured).toHaveLength(0);
  });
});

// ─── Error propagation ────────────────────────────────────────────────────────

describe('complete — fetch errors propagate', () => {
  it('rejects when the provider returns a 4xx error', async () => {
    const engine = makeEngine(() => ({ status: 400, body: { error: { message: 'bad request' } } }));
    await expect(
      complete({
        model: 'anthropic/claude-haiku-4-5',
        prompt: 'test',
        apiKey: 'test-key',
        engine,
      }),
    ).rejects.toBeDefined();
  });
});
