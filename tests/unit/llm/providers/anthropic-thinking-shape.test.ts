/** Anthropic has two incompatible `thinking` shapes, split by model version.
 *
 *  The adapter sent `{type:'enabled', budget_tokens}` to everything, on the reasoning that
 *  it was the universally accepted form. That was true when written and then reversed:
 *  Anthropic removed `budget_tokens` on 4.7+, so Sonnet 5 / Opus 5 / 4.8 / 4.7 / Fable 5
 *  reject it outright —
 *
 *    "thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive"
 *
 *  — while Haiku 4.5 and everything older has no `adaptive` at all and still requires the
 *  budget. Reported from a live app on 2.0.1; a 400 at request time, invisible to types.
 *
 *  Both halves are tested here because fixing one by breaking the other is the obvious
 *  failure mode: a blanket switch to `adaptive` would take out Haiku 4.5, which most of
 *  this repo's own examples run on.
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '../../../../src/llm/providers/anthropic/messages';
import { anthropicThinkingShape } from '../../../../src/llm/providers/anthropic/constants';
import type { NormalizedRequest } from '../../../../src/llm/types/request';

const a = new AnthropicAdapter({ apiKey: 'k' });
const req = (model: string, extra: Partial<NormalizedRequest> = {}): NormalizedRequest => ({
  model,
  messages: [{ role: 'user', content: 'hello' }],
  ...extra,
});

describe('anthropicThinkingShape', () => {
  it('sends adaptive to 4.6 and later', () => {
    for (const model of [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-sonnet-4-6-20251114', // dated snapshot
      'claude-opus-4.6', // dot-separated catalog form
      'anthropic/claude-sonnet-5', // namespaced
    ]) {
      expect([model, anthropicThinkingShape(model)]).toEqual([model, 'adaptive']);
    }
  });

  it('keeps the budget for everything below 4.6', () => {
    for (const model of [
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-opus-4',
      'claude-sonnet-4',
      'claude-3-5-sonnet-latest', // legacy version-first id
      'claude-3-opus-20240229',
    ]) {
      expect([model, anthropicThinkingShape(model)]).toEqual([model, 'budgeted']);
    }
  });

  it('defaults an unrecognised id to adaptive', () => {
    // `budget_tokens` is the shape being retired, so an id we do not know is far more
    // likely to be newer than this code than older than it.
    expect(anthropicThinkingShape('claude-something-new')).toBe('adaptive');
    expect(anthropicThinkingShape('some-vendor-model')).toBe('adaptive');
  });
});

describe('AnthropicAdapter — thinking on 4.6+', () => {
  it('sends adaptive and never budget_tokens', () => {
    const r = a.buildRequest(req('claude-sonnet-5', { thinking: { mode: 'auto' } }));
    expect(r.body.thinking).toEqual({ type: 'adaptive' });
    // The exact field the API rejects with a 400.
    expect(JSON.stringify(r.body)).not.toContain('budget_tokens');
  });

  it('steers depth with output_config.effort instead of a token budget', () => {
    const r = a.buildRequest(
      req('claude-sonnet-5', { thinking: { mode: 'on', effort: 'high' }, maxTokens: 512 }),
    );
    expect(r.body.thinking).toEqual({ type: 'adaptive' });
    expect(r.body.output_config).toEqual({ effort: 'high' });
    // No budget exists, so max_tokens must be left exactly as the caller set it.
    expect(r.body.max_tokens).toBe(512);
  });

  it('keeps hidden visibility working on the adaptive shape', () => {
    const r = a.buildRequest(
      req('claude-opus-4-8', { thinking: { mode: 'auto', visibility: 'hidden' } }),
    );
    expect(r.body.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
  });

  it('does not lose effort when structured output writes to output_config', () => {
    // Both features land in output_config, and thinking is built first — an assignment
    // rather than a merge downstream would silently drop the effort.
    const r = a.buildRequest(
      req('claude-sonnet-5', {
        thinking: { mode: 'auto', effort: 'max' },
        structured: { schema: { type: 'object', properties: { a: { type: 'string' } } } },
      } as Partial<NormalizedRequest>),
    );
    const oc = r.body.output_config as Record<string, unknown>;
    expect(oc.effort).toBe('max');
    expect(oc.format).toBeDefined();
  });

  it('still omits thinking entirely when mode is off', () => {
    const r = a.buildRequest(req('claude-sonnet-5', { thinking: { mode: 'off' } }));
    expect(r.body.thinking).toBeUndefined();
    expect(r.body.output_config).toBeUndefined();
  });
});

describe('AnthropicAdapter — thinking below 4.6', () => {
  it('still sends the budget, which those models require', () => {
    const r = a.buildRequest(req('claude-haiku-4-5', { thinking: { mode: 'auto' } }));
    expect(r.body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('still lifts max_tokens above the budget', () => {
    const r = a.buildRequest(
      req('claude-haiku-4-5', { thinking: { mode: 'auto', effort: 'high' }, maxTokens: 512 }),
    );
    expect(r.body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(r.body.max_tokens).toBe(8192 + 1024);
  });

  it('does not send adaptive to a model that has no such mode', () => {
    const r = a.buildRequest(req('claude-sonnet-4-5', { thinking: { mode: 'on', effort: 'low' } }));
    expect(JSON.stringify(r.body)).not.toContain('adaptive');
    expect(r.body.output_config).toBeUndefined();
  });
});

/** The one-shot helper dropped `thinking` on the floor.
 *
 *  `client.complete()` and agents both honoured it; `complete()` did not even declare the
 *  option, so it was silently discarded — the simplest entry point was the only one that
 *  could not reason. Found while live-testing the shape fix above: the run came back green
 *  because no thinking was sent at all, which made the whole verification vacuous.
 */
import { createEngine, complete } from '../../../../src/index';

describe('complete() forwards thinking', () => {
  /** Captures the wire body instead of calling a provider. `createEngine({ fetch })` takes
   *  the LOW-LEVEL transport, so this must behave like `globalThis.fetch` and return a
   *  real Response — returning a plain object fails inside header normalisation. */
  function captureEngine() {
    const seen: Array<Record<string, unknown>> = [];
    const fetch = async (_url: string, init?: { body?: string }) => {
      seen.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const engine = createEngine({ apiKeys: { anthropic: 'k' }, fetch: fetch as never });
    return { engine, seen };
  }

  it('reaches the provider on a plain one-shot', async () => {
    const { engine, seen } = captureEngine();
    await complete({
      model: 'anthropic/claude-sonnet-5',
      prompt: 'hi',
      thinking: { mode: 'on', effort: 'low' },
      engine,
    });
    expect(seen[0]!.thinking).toEqual({ type: 'adaptive' });
    expect(seen[0]!.output_config).toEqual({ effort: 'low' });
  });

  it('reaches the provider on the tools branch too', async () => {
    // These two branches diverged once before, dropping providerOptions and serviceTier
    // on whichever path the caller happened to take.
    const { engine, seen } = captureEngine();
    await complete({
      model: 'anthropic/claude-sonnet-5',
      prompt: 'hi',
      thinking: { mode: 'on', effort: 'low' },
      tools: [{ type: 'web_search' } as never],
      engine,
    });
    expect(seen[0]!.thinking).toEqual({ type: 'adaptive' });
  });
});
