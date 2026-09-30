/** A reasoning effort the catalog advertises has to reach the wire.
 *
 *  The xAI overlay deleted `reasoning` for every model whose id did not contain
 *  `multi-agent`, on the belief that only that model used the field. The catalog
 *  meanwhile advertised `effortControl: true` with `effortValues` including
 *  `xhigh` for grok-4.5 and 4.6 — so the catalog promised a control the request
 *  never carried, and a caller asking for `xhigh` silently got the default. The
 *  usual shape of this bug: two layers each correct about themselves.
 *
 *  Measured 2026-09-30 on `/v1/responses`, reasoning tokens on a hard prompt
 *  (a trivial one cannot separate the efforts, which is how "accepted and inert"
 *  hides):
 *
 *    grok-4.6   low  449 → xhigh 3066   ×6.8
 *    grok-4.5   low   95 → xhigh 3475   ×36.6
 *    grok-4.3   low 1307 → xhigh 9729   ×7.4
 *    grok-4.20  400 "does not support parameter reasoningEffort"
 *
 *  That last row is why this is a table and not a version comparison: 4.20
 *  refuses the field while the numerically LOWER 4.3 honours it.
 */

import { describe, expect, it } from 'bun:test';
import { XAIResponsesAdapter } from '../../../src/llm/providers/xai/responses';
import {
  xaiTakesReasoningEffort,
  xaiUsesEffortAsAgentCount,
} from '../../../src/llm/providers/xai/reasoning';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const adapter = new XAIResponsesAdapter({ apiKey: 'k' });

/** The `reasoning` object the request would carry, or undefined when dropped. */
function reasoningFor(model: string, effort = 'xhigh'): Record<string, unknown> | undefined {
  const body = adapter.buildRequest({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    thinking: { mode: 'on', effort },
  } as unknown as NormalizedRequest).body as { reasoning?: Record<string, unknown> };
  return body.reasoning;
}

describe('the capability table', () => {
  it('says yes for the models measured to honour it', () => {
    for (const m of ['grok-4.3', 'grok-4.5', 'grok-4.6', 'grok-4.7']) {
      expect(xaiTakesReasoningEffort(m)).toBe(true);
    }
  });

  it('says no for the 4.20 line, which refuses the parameter by name', () => {
    // A 400 is not a failure mode worth risking on a guess, and this is the
    // case that rules out any rule shaped like a version comparison: 4.20 is a
    // separate line, not a later 4.2.
    for (const m of ['grok-4.20', 'grok-4.20-non-reasoning', 'grok-4.20-0309-reasoning']) {
      expect(xaiTakesReasoningEffort(m)).toBe(false);
    }
  });

  it('says no for the multi-agent grok, where the field means an agent COUNT', () => {
    // Accepted there, but it buys a different thing than the caller asked for.
    expect(xaiTakesReasoningEffort('grok-4.20-multi-agent')).toBe(false);
    expect(xaiUsesEffortAsAgentCount('grok-4.20-multi-agent')).toBe(true);
  });

  it('defaults to no for a model released after this build', () => {
    // The conservative direction: an unsent field costs the caller the control
    // they asked for, a rejected one costs them the whole request.
    expect(xaiTakesReasoningEffort('grok-5')).toBe(false);
    expect(xaiTakesReasoningEffort('grok-build-0.1')).toBe(false);
  });

  it('does not depend on whether the id carries the provider prefix', () => {
    expect(xaiTakesReasoningEffort('xai/grok-4.6')).toBe(true);
    expect(xaiTakesReasoningEffort('XAI/GROK-4.20')).toBe(false);
  });
});

describe('the request the adapter builds', () => {
  it('carries the effort for a model that honours it', () => {
    // `summary: 'auto'` rides along from the shared spec. Probed 2026-09-30: xAI
    // answers 200 to effort alone, to summary alone, and to both -- worth
    // checking, because un-deleting the object starts sending a field the
    // measurement that unblocked this had never sent.
    expect(reasoningFor('grok-4.6')?.effort).toBe('xhigh');
  });

  it('carries xhigh specifically, which is what this row was about', () => {
    expect(reasoningFor('grok-4.5', 'xhigh')?.effort).toBe('xhigh');
  });

  it('still drops it for the 4.20 line, which would 400', () => {
    expect(reasoningFor('grok-4.20')).toBeUndefined();
    expect(reasoningFor('grok-4.20-non-reasoning')).toBeUndefined();
  });

  it('still carries it for multi-agent, which wants the field for its own reason', () => {
    expect(reasoningFor('grok-4.20-multi-agent')?.effort).toBe('xhigh');
  });

  it('sends nothing when the caller asked for no thinking', () => {
    const body = adapter.buildRequest({
      model: 'grok-4.6',
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as NormalizedRequest).body as { reasoning?: unknown };
    expect(body.reasoning).toBeUndefined();
  });
});

/** The same field on chat-completions, where it had the wrong NAME.
 *
 *  That API takes `reasoning_effort`, a top-level string. The spec built
 *  `reasoning: {effort}` — the Responses shape — and OpenAI answers
 *  `400 Unknown parameter: 'reasoning'` to it (measured 2026-09-30), so asking
 *  for thinking on that surface failed every single time. xAI hid the identical
 *  bug behind an overlay that deleted the field outright, which is why only one
 *  of the two ever produced a visible error.
 *
 *  The frozen wire corpus did not catch it: it exercises each model on ONE
 *  surface, and every OpenAI chat model in it routes to Responses. Nothing
 *  built an OpenAI chat-completions request with thinking on.
 */
describe('chat-completions sends reasoning_effort, not a reasoning object', () => {
  const completions = async () => {
    const { OpenAIAdapter } = await import('../../../src/llm/providers/openai/completions');
    const { XAIAdapter } = await import('../../../src/llm/providers/xai/completions');
    const { OpenRouterAdapter } = await import('../../../src/llm/providers/openrouter/completions');
    return {
      openai: new OpenAIAdapter({ apiKey: 'k' }),
      xai: new XAIAdapter({ apiKey: 'k' }),
      openrouter: new OpenRouterAdapter({ apiKey: 'k' }),
    };
  };

  const build = (adapter: { buildRequest: (r: never) => { body: unknown } }, model: string, effort = 'high') =>
    adapter.buildRequest({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 4096,
      thinking: { mode: 'on', effort },
    } as never).body as Record<string, unknown>;

  it('openai: the string, and no object at all', async () => {
    const b = build((await completions()).openai, 'gpt-5.4-nano');
    expect(b.reasoning_effort).toBe('high');
    expect(b.reasoning).toBeUndefined();
  });

  it('xai: the same, for a model that takes it', async () => {
    const b = build((await completions()).xai, 'grok-4.6');
    expect(b.reasoning_effort).toBe('high');
  });

  it('xai: nothing for the 4.20 line, which refuses it on this surface too', async () => {
    // Measured 2026-09-30: 400 "Model grok-4.20 does not support parameter
    // reasoningEffort" on /v1/chat/completions as well as /v1/responses.
    const b = build((await completions()).xai, 'grok-4.20');
    expect(b.reasoning_effort).toBeUndefined();
    expect(b.reasoning).toBeUndefined();
  });

  it('openrouter keeps the OBJECT, which is the shape it documents', async () => {
    // Probed 2026-09-30: OpenRouter accepts both forms and honours both, but the
    // object is the only one that can also carry its `max_tokens`/`exclude`. The
    // 400 is an OpenAI fact, not an OpenRouter one, so it is not imposed here.
    const b = build((await completions()).openrouter, 'anthropic/claude-fable-5');
    expect(b.reasoning).toEqual({ effort: 'high' });
    expect(b.reasoning_effort).toBeUndefined();
  });

  it('max maps to the top rung on every one of them', async () => {
    const a = await completions();
    expect(build(a.openai, 'gpt-5.4-nano', 'max').reasoning_effort).toBe('xhigh');
    expect(build(a.xai, 'grok-4.6', 'max').reasoning_effort).toBe('xhigh');
    expect(build(a.openrouter, 'anthropic/claude-fable-5', 'max').reasoning).toEqual({
      effort: 'xhigh',
    });
  });
});
