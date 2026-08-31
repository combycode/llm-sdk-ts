/** The provider count endpoints, and the TokenCounter in front of them.
 *
 *  Every one of these requests goes through the injected engine fetch — never
 *  `globalThis.fetch` — so exact token counting inherits the queue, the rate
 *  limits, the retries and the telemetry that every other HTTP call in the
 *  library gets. The tests below assert on the request the counter HANDS to
 *  that fetch, which is the only place that contract is observable.
 */

import { describe, expect, it } from 'bun:test';
import {
  AnthropicCountApi,
  CountApiCounter,
  GoogleCountApi,
  XAICountApi,
} from '../../../../src/plugins/context-measurer/counter/count-api';
import { ModelCatalog } from '../../../../src/catalog/catalog';
import type { EngineFetch } from '../../../../src/network/types';
import type { Message } from '../../../../src/llm/types/messages';

interface SeenRequest {
  url?: string;
  provider?: string;
  model?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  responseType?: string;
}

function recordingFetch(response: {
  status?: number;
  body?: unknown;
}): { fetch: EngineFetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const fetch = (async (req: SeenRequest) => {
    seen.push(req);
    return { status: response.status ?? 200, headers: {}, body: response.body ?? {} };
  }) as unknown as EngineFetch;
  return { fetch, seen };
}

function catalog(charsPerToken = 4): ModelCatalog {
  const c = new ModelCatalog();
  c.set('anthropic', 'claude-x', {
    pricing: {},
    tokenizer: { strategy: 'count_api', charsPerTokenDefault: charsPerToken, countApiAvailable: true },
  } as never);
  return c;
}

// ─── Anthropic ───────────────────────────────────────────────────────────────

describe('AnthropicCountApi', () => {
  it('posts the message array and reads input_tokens back', async () => {
    const { fetch, seen } = recordingFetch({ body: { input_tokens: 42 } });
    const api = new AnthropicCountApi('sk-test', fetch);

    const n = await api.countMessages('claude-x', [{ role: 'user', content: 'hi' }], 'be brief');

    expect(n).toBe(42);
    expect(seen).toHaveLength(1);
    // The request is spec-built and tagged for the engine.
    expect(seen[0].provider).toBe('anthropic');
    expect(seen[0].model).toBe('count_tokens');
    expect(seen[0].responseType).toBe('json');
    expect(seen[0].url).toContain('/v1/messages/count_tokens');
    expect(seen[0].body?.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(seen[0].body?.system).toBe('be brief');
  });

  it('countText wraps the string as a single user message', async () => {
    const { fetch, seen } = recordingFetch({ body: { input_tokens: 7 } });
    expect(await new AnthropicCountApi('k', fetch).countText('claude-x', 'hello')).toBe(7);
    expect(seen[0].body?.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('honours a custom base URL', async () => {
    const { fetch, seen } = recordingFetch({ body: { input_tokens: 1 } });
    await new AnthropicCountApi('k', fetch, 'https://proxy.internal').countText('claude-x', 'x');
    expect(seen[0].url).toContain('https://proxy.internal');
  });

  it('an HTTP error is raised, not silently counted as zero', async () => {
    const { fetch } = recordingFetch({ status: 404, body: { error: 'no such model' } });
    await expect(new AnthropicCountApi('k', fetch).countText('gone', 'x')).rejects.toThrow(
      /Anthropic count_tokens failed: 404.*no such model/,
    );
  });

  it('a 200 with no input_tokens field counts zero rather than NaN', async () => {
    const { fetch } = recordingFetch({ body: {} });
    expect(await new AnthropicCountApi('k', fetch).countText('claude-x', 'x')).toBe(0);
  });

  it('a 200 with no body at all counts zero rather than throwing', async () => {
    const fetch = (async () => ({ status: 200, headers: {} })) as unknown as EngineFetch;
    expect(await new AnthropicCountApi('k', fetch).countText('claude-x', 'x')).toBe(0);
  });
});

// ─── Google ──────────────────────────────────────────────────────────────────

describe('GoogleCountApi', () => {
  it('reads totalTokens back from the countTokens endpoint', async () => {
    const { fetch, seen } = recordingFetch({ body: { totalTokens: 13 } });
    expect(await new GoogleCountApi('k', fetch).countText('gemini-x', 'hello')).toBe(13);
    expect(seen[0].provider).toBe('google');
    expect(seen[0].url).toContain('countTokens');
  });

  it('honours a custom base URL', async () => {
    const { fetch, seen } = recordingFetch({ body: { totalTokens: 1 } });
    await new GoogleCountApi('k', fetch, 'https://g.internal').countText('gemini-x', 'x');
    expect(seen[0].url).toContain('https://g.internal');
  });

  it('an HTTP error is raised', async () => {
    const { fetch } = recordingFetch({ status: 400, body: { error: 'bad' } });
    await expect(new GoogleCountApi('k', fetch).countText('gemini-x', 'x')).rejects.toThrow(
      /Google countTokens failed: 400/,
    );
  });

  it('a missing totalTokens counts zero', async () => {
    const { fetch } = recordingFetch({ body: {} });
    expect(await new GoogleCountApi('k', fetch).countText('gemini-x', 'x')).toBe(0);
  });
});

// ─── xAI ─────────────────────────────────────────────────────────────────────

describe('XAICountApi', () => {
  it('counts the length of token_ids, the name the REST host actually uses', async () => {
    const { fetch, seen } = recordingFetch({ body: { token_ids: [1, 2, 3, 4] } });
    expect(await new XAICountApi('k', fetch).countText('grok-x', 'hello')).toBe(4);
    expect(seen[0].provider).toBe('xai');
    expect(seen[0].url).toContain('tokenize-text');
  });

  it('also accepts the proto field name `tokens`', async () => {
    const { fetch } = recordingFetch({ body: { tokens: [1, 2] } });
    expect(await new XAICountApi('k', fetch).countText('grok-x', 'hello')).toBe(2);
  });

  it('a payload with neither list counts zero rather than throwing', async () => {
    const { fetch } = recordingFetch({ body: { token_ids: 'not-a-list' } });
    expect(await new XAICountApi('k', fetch).countText('grok-x', 'x')).toBe(0);
    const empty = recordingFetch({ body: {} });
    expect(await new XAICountApi('k', empty.fetch).countText('grok-x', 'x')).toBe(0);
  });

  it('honours a custom base URL', async () => {
    const { fetch, seen } = recordingFetch({ body: { token_ids: [] } });
    await new XAICountApi('k', fetch, 'https://x.internal').countText('grok-x', 'x');
    expect(seen[0].url).toContain('https://x.internal');
  });

  it('an HTTP error is raised', async () => {
    const { fetch } = recordingFetch({ status: 500, body: { error: 'boom' } });
    await expect(new XAICountApi('k', fetch).countText('grok-x', 'x')).rejects.toThrow(
      /xAI tokenize-text failed: 500/,
    );
  });
});

// ─── CountApiCounter ─────────────────────────────────────────────────────────

describe('CountApiCounter — routing', () => {
  it('measure() uses the provider endpoint when one is configured', async () => {
    const { fetch, seen } = recordingFetch({ body: { input_tokens: 99 } });
    const counter = new CountApiCounter(catalog(), {
      anthropic: new AnthropicCountApi('k', fetch),
    });

    expect(await counter.measure('hello', { provider: 'anthropic', model: 'claude-x' })).toBe(99);
    expect(seen).toHaveLength(1);
  });

  it('measure() falls back to the heuristic when the provider has no endpoint', async () => {
    const counter = new CountApiCounter(catalog(4), {});
    // 40 chars at 4 chars/token — no HTTP call is made at all.
    expect(await counter.measure('x'.repeat(40), { provider: 'anthropic', model: 'claude-x' })).toBe(
      10,
    );
  });

  it('measure() falls back to the heuristic when the context names no model', async () => {
    const { fetch, seen } = recordingFetch({ body: { input_tokens: 99 } });
    const counter = new CountApiCounter(catalog(4), {
      anthropic: new AnthropicCountApi('k', fetch),
    });
    expect(await counter.measure('x'.repeat(40))).toBe(10);
    expect(await counter.measure('x'.repeat(40), { provider: 'anthropic' })).toBe(10);
    expect(seen).toHaveLength(0);
  });

  it('an unknown provider never reaches an endpoint', async () => {
    const { fetch, seen } = recordingFetch({ body: { input_tokens: 99 } });
    const counter = new CountApiCounter(catalog(4), {
      anthropic: new AnthropicCountApi('k', fetch),
    });
    expect(await counter.measure('x'.repeat(40), { provider: 'mistral', model: 'm' })).toBe(10);
    expect(seen).toHaveLength(0);
  });

  it('sends the provider api id, not our catalog slug', async () => {
    // Our canonical id may be dotted while the callable one is dated; sending
    // the slug is a 404 that looks like a broken model rather than a broken id.
    const c = new ModelCatalog();
    c.set('anthropic', 'claude-haiku-4.5', {
      pricing: {},
      providerModelName: 'claude-haiku-4-5-20251001',
      tokenizer: { strategy: 'count_api', charsPerTokenDefault: 4, countApiAvailable: true },
    } as never);
    const { fetch, seen } = recordingFetch({ body: { input_tokens: 19 } });
    const counter = new CountApiCounter(c, { anthropic: new AnthropicCountApi('k', fetch) });

    await counter.measure('hi', { provider: 'anthropic', model: 'claude-haiku-4.5' });
    await counter.measureMessage(
      { role: 'user', content: 'hi' },
      { provider: 'anthropic', model: 'claude-haiku-4.5' },
    );

    expect(seen.map((r) => r.body?.model)).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('routes google and xai to their own endpoints', async () => {
    const g = recordingFetch({ body: { totalTokens: 5 } });
    const x = recordingFetch({ body: { token_ids: [1, 2, 3] } });
    const counter = new CountApiCounter(null, {
      google: new GoogleCountApi('k', g.fetch),
      xai: new XAICountApi('k', x.fetch),
    });

    expect(await counter.measure('hi', { provider: 'google', model: 'gemini-x' })).toBe(5);
    expect(await counter.measure('hi', { provider: 'xai', model: 'grok-x' })).toBe(3);
  });

  it('measureMessage() over string content sends the string as-is', async () => {
    const { fetch, seen } = recordingFetch({ body: { input_tokens: 11 } });
    const counter = new CountApiCounter(catalog(), {
      anthropic: new AnthropicCountApi('k', fetch),
    });

    const n = await counter.measureMessage(
      { role: 'user', content: 'plain text' },
      { provider: 'anthropic', model: 'claude-x' },
    );

    expect(n).toBe(11);
    expect(seen[0].body?.messages).toEqual([{ role: 'user', content: 'plain text' }]);
  });

  it('measureMessage() over multi-part content sends the serialized parts', async () => {
    const { fetch, seen } = recordingFetch({ body: { input_tokens: 21 } });
    const counter = new CountApiCounter(catalog(), {
      anthropic: new AnthropicCountApi('k', fetch),
    });
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image', source: { type: 'url', url: 'http://x/y.png' } },
      ],
    };

    expect(await counter.measureMessage(msg, { provider: 'anthropic', model: 'claude-x' })).toBe(21);
    const sent = (seen[0].body?.messages as Array<{ content: string }>)[0].content;
    expect(sent).toBe(JSON.stringify(msg.content));
  });

  it('measureMessage() truncates enormous multi-part content rather than posting megabytes', async () => {
    const { fetch, seen } = recordingFetch({ body: { input_tokens: 1 } });
    const counter = new CountApiCounter(catalog(), {
      anthropic: new AnthropicCountApi('k', fetch),
    });
    const msg: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'y'.repeat(200_000) }],
    };

    await counter.measureMessage(msg, { provider: 'anthropic', model: 'claude-x' });

    const sent = (seen[0].body?.messages as Array<{ content: string }>)[0].content;
    expect(sent).toHaveLength(100_000);
  });

  it('measureMessage() falls back to the heuristic without an endpoint', async () => {
    const counter = new CountApiCounter(catalog(4), {});
    expect(
      await counter.measureMessage(
        { role: 'user', content: 'x'.repeat(40) },
        { provider: 'anthropic', model: 'claude-x' },
      ),
    ).toBe(10);
  });
});

describe('CountApiCounter — the fast path stays local', () => {
  it('estimate() and estimateMessage() never make a request', () => {
    const { fetch, seen } = recordingFetch({ body: { input_tokens: 99 } });
    const counter = new CountApiCounter(catalog(4), {
      anthropic: new AnthropicCountApi('k', fetch),
    });
    const ctx = { provider: 'anthropic', model: 'claude-x' };

    expect(counter.estimate('x'.repeat(40), ctx)).toBe(10);
    expect(counter.estimateMessage({ role: 'user', content: 'x'.repeat(80) }, ctx)).toBe(20);
    expect(seen).toHaveLength(0);
  });

  it('learn() reaches the heuristic behind it without a calibration store, and is inert', () => {
    const counter = new CountApiCounter(catalog(4), {});
    const ctx = { provider: 'anthropic', model: 'claude-x' };
    const sample = {
      ...ctx,
      bytesSent: 800,
      actualTokens: 100, // 8 chars/token — nothing like the catalog's 4
      timestamp: 0,
    };

    expect(() => counter.learn(sample)).not.toThrow();

    // This counter builds its own store-less heuristic, so a learned ratio has
    // nowhere to persist: the catalog default must still be what is used.
    expect(counter.estimate('x'.repeat(40), ctx)).toBe(10);
  });
});
