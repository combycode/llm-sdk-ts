/** Why the prompt cache missed — one option, two providers, two wire shapes.
 *
 *  Every body below is one this desk MEASURED on 2026-09-29 (claude-haiku-4-5 on
 *  GA /v1/messages, gpt-5.6-luna on /v1/responses) with a prompt large enough to
 *  be cached. A short prompt produces nothing to diagnose on either provider and
 *  reads as a broken feature, which is how this would have been mis-specified.
 */

import { describe, expect, it } from 'bun:test';
import {
  anthropicCacheDiagnostics,
  openaiCacheDiagnostics,
} from '../../../src/llm/cache-diagnostics';

describe('anthropic: a miss reason, or silence', () => {
  it('reports the block that diverged, with the tokens it cost', () => {
    const d = anthropicCacheDiagnostics({
      cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 9197 },
    });
    expect(d).toEqual({
      status: 'miss',
      reason: 'system_changed',
      missedTokens: 9197,
      raw: { cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 9197 } },
    });
  });

  it('turns an unknown previous id into the unified not-found status', () => {
    // Measured: HTTP 200, not an error — so a stored id can be passed without
    // guarding its age.
    const d = anthropicCacheDiagnostics({
      cache_miss_reason: { type: 'previous_message_not_found' },
    });
    expect(d?.status).toBe('comparison_not_found');
    expect(d?.missedTokens).toBeUndefined();
  });

  it('passes `unavailable` through', () => {
    expect(anthropicCacheDiagnostics({ cache_miss_reason: { type: 'unavailable' } })?.status).toBe(
      'unavailable',
    );
  });

  it('says NOTHING when the prefix was reused', () => {
    // The load-bearing measurement: a cache HIT returns `diagnostics: null`,
    // byte for byte what an undiagnosed request returns. Anthropic has no hit
    // variant, so claiming one here would publish our inference as theirs.
    expect(anthropicCacheDiagnostics(null)).toBeUndefined();
    expect(anthropicCacheDiagnostics({ cache_miss_reason: null })).toBeUndefined();
    expect(anthropicCacheDiagnostics(undefined)).toBeUndefined();
  });

  it('keeps an unrecognised reason rather than flattening it', () => {
    const d = anthropicCacheDiagnostics({
      cache_miss_reason: { type: 'something_new', cache_missed_input_tokens: 5 },
    });
    expect(d).toMatchObject({ status: 'miss', reason: 'something_new', missedTokens: 5 });
  });
});

describe('openai: a status for every case, including the hit', () => {
  it('reports a hit', () => {
    expect(openaiCacheDiagnostics({ type: 'cache_hit' })).toEqual({
      status: 'hit',
      raw: { type: 'cache_hit' },
    });
  });

  it('reports a miss with both token counts', () => {
    const raw = {
      type: 'cache_miss',
      reason: 'input_changed',
      cache_missed_tokens: 10052,
      comparison_reusable_tokens: 10052,
    };
    expect(openaiCacheDiagnostics(raw)).toEqual({
      status: 'miss',
      reason: 'input_changed',
      missedTokens: 10052,
      reusableTokens: 10052,
      raw,
    });
  });

  it('normalises its not-found spelling onto the unified one', () => {
    // `comparison_response_not_found` and Anthropic's `previous_message_not_found`
    // are the same fact under two names; that one IS safe to unify.
    expect(openaiCacheDiagnostics({ type: 'comparison_response_not_found' })?.status).toBe(
      'comparison_not_found',
    );
  });

  it('passes `unavailable` through, which is what a small prompt gets', () => {
    expect(openaiCacheDiagnostics({ type: 'unavailable' })?.status).toBe('unavailable');
  });

  it('passes an unknown type through instead of collapsing it to a neighbour', () => {
    // R1: the enum has grown twice already. A value nothing branches on must
    // reach the caller.
    expect(openaiCacheDiagnostics({ type: 'cache_partial_hit' })?.status).toBe('cache_partial_hit');
  });

  it('ignores a body with no type', () => {
    expect(openaiCacheDiagnostics({ reason: 'input_changed' })).toBeUndefined();
    expect(openaiCacheDiagnostics(null)).toBeUndefined();
  });
});

describe('the two vocabularies are NOT translated into each other', () => {
  it('keeps each provider’s own reason word', () => {
    // `system_changed` and `input_changed` are not the same claim, and picking
    // one to stand for the other would be a guess wearing a unified name.
    expect(
      anthropicCacheDiagnostics({
        cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 1 },
      })?.reason,
    ).toBe('system_changed');
    expect(
      openaiCacheDiagnostics({ type: 'cache_miss', reason: 'input_changed', cache_missed_tokens: 1 })
        ?.reason,
    ).toBe('input_changed');
  });
});

// ─── the request side ────────────────────────────────────────────────────────

import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const bodyOf = (
  adapter: { buildRequest: (r: NormalizedRequest) => unknown },
  model: string,
  extra: Record<string, unknown>,
) =>
  (
    adapter.buildRequest({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      ...extra,
    } as unknown as NormalizedRequest) as { body: Record<string, unknown> }
  ).body;

describe('what goes on the wire', () => {
  const anthropic = new AnthropicAdapter({ apiKey: 'k' });
  const openai = new OpenAIResponsesAdapter({ apiKey: 'k' });

  it('anthropic sends the id under its own name', () => {
    const b = bodyOf(anthropic, 'claude-haiku-4.5', {
      cacheDiagnostics: { compareWith: 'msg_01abc' },
    });
    expect(b.diagnostics).toEqual({ previous_message_id: 'msg_01abc' });
  });

  it('anthropic sends an explicit null when no comparison was named', () => {
    // Not omitted: null is how a first turn opts in, and omitting the field
    // opts out entirely — the difference between a diagnosis and silence.
    const b = bodyOf(anthropic, 'claude-haiku-4.5', { cacheDiagnostics: {} });
    expect(b.diagnostics).toEqual({ previous_message_id: null });
  });

  it('anthropic sends nothing at all when it was not asked for', () => {
    expect(bodyOf(anthropic, 'claude-haiku-4.5', {}).diagnostics).toBeUndefined();
  });

  it('openai sends it inside prompt_cache_options', () => {
    const b = bodyOf(openai, 'gpt-5.6-luna', {
      cacheDiagnostics: { compareWith: 'resp_abc' },
    });
    expect(b.prompt_cache_options).toEqual({ comparison_response_id: 'resp_abc' });
  });

  it('openai MERGES it with the raw passthrough instead of replacing it', () => {
    // Two blocks used to write the same key; whichever ran second won, and a
    // caller who set both silently lost one.
    const b = bodyOf(openai, 'gpt-5.6-luna', {
      cacheDiagnostics: { compareWith: 'resp_abc' },
      providerOptions: { promptCacheOptions: { mode: 'explicit' } },
    });
    expect(b.prompt_cache_options).toEqual({
      comparison_response_id: 'resp_abc',
      mode: 'explicit',
    });
  });

  it('an explicit passthrough id still wins, which is what R5 requires', () => {
    const b = bodyOf(openai, 'gpt-5.6-luna', {
      cacheDiagnostics: { compareWith: 'resp_unified' },
      providerOptions: { promptCacheOptions: { comparison_response_id: 'resp_raw' } },
    });
    expect((b.prompt_cache_options as Record<string, unknown>).comparison_response_id).toBe(
      'resp_raw',
    );
  });

  it('the raw passthrough alone still works untouched', () => {
    const b = bodyOf(openai, 'gpt-5.6-luna', {
      providerOptions: { promptCacheOptions: { mode: 'explicit', ttl: '30m' } },
    });
    expect(b.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' });
  });
});

// ─── and where it cannot be sent ─────────────────────────────────────────────

import { HookBus } from '../../../src/bus/hook-bus';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { LLMClient } from '../../../src/llm/client';
import type { HttpRequest, HttpResponse } from '../../../src/network/types';
import type { ProviderName } from '../../../src/llm/types/provider';

describe('a provider with no field for it says so', () => {
  const run = async (adapter: unknown, provider: ProviderName, model: string, ask: boolean) => {
    const hooks = new HookBus();
    const warnings: Array<{ code?: string; message?: string }> = [];
    hooks.on('onWarning', (w) => {
      warnings.push({ code: w.code, message: w.message });
    });
    const client = new LLMClient({
      provider,
      model,
      apiKey: 'k',
      hooks,
      adapter: adapter as never,
      fetch: (async () => ({ status: 200, headers: {}, body: {} })) as unknown as (
        r: HttpRequest,
      ) => Promise<HttpResponse>,
    });
    await client
      .complete('hi', { maxTokens: 4, ...(ask ? { cacheDiagnostics: { compareWith: 'x' } } : {}) })
      .catch(() => undefined);
    return warnings;
  };

  it('warns rather than dropping the request quietly', async () => {
    const warnings = await run(new GoogleAdapter({ apiKey: 'k' }), 'google', 'gemini-3.1-flash', true);
    const adjusted = warnings.filter((w) => w.code === 'request_adjusted');
    expect(adjusted.length).toBe(1);
    expect(adjusted[0]?.message).toContain('cacheDiagnostics');
  });

  it('says nothing when it was not asked for', async () => {
    const warnings = await run(
      new GoogleAdapter({ apiKey: 'k' }),
      'google',
      'gemini-3.1-flash',
      false,
    );
    expect(warnings.filter((w) => w.code === 'request_adjusted')).toEqual([]);
  });

  it('stays silent on a provider that DID send it', async () => {
    const warnings = await run(
      new AnthropicAdapter({ apiKey: 'k' }),
      'anthropic',
      'claude-haiku-4.5',
      true,
    );
    expect(warnings.filter((w) => w.code === 'request_adjusted')).toEqual([]);
  });
});

// ─── streaming answers the same question ─────────────────────────────────────

import { XAIResponsesAdapter } from '../../../src/llm/providers/xai/responses';
import type { SSEEvent } from '../../../src/network/types';

describe('a streamed request gets the same diagnosis as a buffered one', () => {
  // Measured 2026-09-29: both providers send it in the stream too. Without this
  // the same request answered a different question depending on how it was
  // fetched -- the failure `citation` and `file` events already exist to prevent.

  it('anthropic reports it on message_start, before a token is generated', () => {
    const events = new AnthropicAdapter({ apiKey: 'k' }).parseStreamEvent({
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: {
          id: 'm',
          usage: { input_tokens: 3, output_tokens: 0 },
          diagnostics: {
            cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 9197 },
          },
        },
      }),
    } as SSEEvent);

    const diag = events.find((e) => e.type === 'cache_diagnostics');
    expect(diag).toEqual({
      type: 'cache_diagnostics',
      diagnostics: {
        status: 'miss',
        reason: 'system_changed',
        missedTokens: 9197,
        raw: { cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 9197 } },
      },
    });
  });

  it('anthropic emits nothing when the prefix was reused', () => {
    const events = new AnthropicAdapter({ apiKey: 'k' }).parseStreamEvent({
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: { id: 'm', usage: { input_tokens: 3, output_tokens: 0 }, diagnostics: null },
      }),
    } as SSEEvent);
    expect(events.some((e) => e.type === 'cache_diagnostics')).toBe(false);
  });

  it('openai reports it on the terminal frame', () => {
    const events = new OpenAIResponsesAdapter({ apiKey: 'k' }).parseStreamEvent({
      event: 'response.completed',
      data: JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1 },
          prompt_cache_diagnostics: { type: 'cache_hit' },
        },
      }),
    } as SSEEvent);

    const diag = events.find((e) => e.type === 'cache_diagnostics');
    expect(diag && 'diagnostics' in diag && diag.diagnostics.status).toBe('hit');
  });

  it('xai, which shares the Responses parser, simply never carries one', () => {
    const events = new XAIResponsesAdapter({ apiKey: 'k' }).parseStreamEvent({
      event: 'response.completed',
      data: JSON.stringify({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    } as SSEEvent);
    expect(events.some((e) => e.type === 'cache_diagnostics')).toBe(false);
  });
});
