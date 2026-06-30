/** Inline moderation (#4): native passthrough + parse, emulated input/output,
 *  the three stream strategies, early-abort, and the missing-key throw. */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { LLMClient } from '../../../src/llm/client';
import { buildNativeModeration, parseNativeModeration } from '../../../src/llm/moderation/native';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import type { ProviderAdapter, ProviderHttpRequest } from '../../../src/llm/types/provider';
import type { NormalizedRequest } from '../../../src/llm/types/request';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { StreamEvent } from '../../../src/llm/types/stream';
import type {
  EngineFetch,
  EngineFetchStream,
  HttpResponse,
  SSEEvent,
} from '../../../src/network/types';

// ─── Canned moderation wire shapes ────────────────────────────────────────────

const RAW_RESULT = (flagged: boolean) => ({
  type: 'moderation_result',
  flagged,
  categories: { hate: flagged, violence: false },
  category_scores: { hate: flagged ? 0.97 : 0.01, violence: 0.0 },
  category_applied_input_types: { hate: ['text'] },
  model: 'omni-moderation-latest',
});

/** A fetch that answers /moderations with a canned result and everything else with {}. */
function moderatingFetch(flagged: boolean): EngineFetch {
  return (async (req: { url?: string }) => {
    if (String(req.url ?? '').includes('/moderations')) {
      return { status: 200, headers: {}, body: { results: [RAW_RESULT(flagged)] } } as HttpResponse;
    }
    return { status: 200, headers: {}, body: { ok: true } } as HttpResponse;
  }) as EngineFetch;
}

// ─── Mock adapters ────────────────────────────────────────────────────────────

/** Completion adapter that returns fixed text (for emulated complete() tests). */
function textAdapter(text: string): ProviderAdapter {
  return {
    name: 'mock' as ProviderAdapter['name'],
    buildRequest(req: NormalizedRequest): ProviderHttpRequest {
      return { body: { model: req.model } };
    },
    parseResponse(): CompletionResponse {
      return {
        id: 'r1',
        model: 'mock',
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        text,
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: {},
      };
    },
    parseStreamEvent(sse: SSEEvent): StreamEvent[] {
      return [JSON.parse(sse.data) as StreamEvent];
    },
    enableStreaming() {},
    authHeaders() {
      return {};
    },
    baseURL() {
      return 'https://mock.test';
    },
    completionPath() {
      return '/v1/c';
    },
  } as ProviderAdapter;
}

function streamOf(events: StreamEvent[]): EngineFetchStream {
  return async function* () {
    for (const e of events) yield { data: JSON.stringify(e) } satisfies SSEEvent;
  } as unknown as EngineFetchStream;
}

function makeClient(opts: {
  provider?: string;
  fetch?: EngineFetch;
  fetchStream?: EngineFetchStream;
  text?: string;
  hooks?: HookBus;
}): LLMClient {
  return new LLMClient({
    provider: (opts.provider ?? 'anthropic') as never,
    model: 'mock-model',
    adapter: textAdapter(opts.text ?? 'output'),
    apiKey: 'client-key',
    fetch: opts.fetch ?? moderatingFetch(false),
    fetchStream: opts.fetchStream,
    hooks: opts.hooks,
  } as never);
}

// ─── Native parse / build ─────────────────────────────────────────────────────

describe('native moderation wire helpers', () => {
  it('buildNativeModeration defaults the model and honours an override', () => {
    expect(buildNativeModeration({})).toEqual({ model: 'omni-moderation-latest' });
    expect(buildNativeModeration({ model: 'text-moderation-007' })).toEqual({
      model: 'text-moderation-007',
    });
  });

  it('parses the Responses-API shape (moderation_result on input/output)', () => {
    const report = parseNativeModeration({ input: RAW_RESULT(false), output: RAW_RESULT(true) });
    expect(report?.source).toBe('native');
    expect((report?.input as { flagged: boolean }).flagged).toBe(false);
    expect((report?.output as { flagged: boolean }).flagged).toBe(true);
  });

  it('parses the Chat-Completions shape (moderation_results wrapper)', () => {
    const wrapped = {
      type: 'moderation_results',
      model: 'omni-moderation-latest',
      results: [RAW_RESULT(true)],
    };
    const report = parseNativeModeration({ input: wrapped, output: wrapped });
    expect((report?.input as { flagged: boolean }).flagged).toBe(true);
  });

  it('surfaces a moderation error entry', () => {
    const report = parseNativeModeration({
      input: { type: 'error', code: 'bad', message: 'moderation unavailable' },
    });
    expect(report?.input).toEqual({ error: 'moderation unavailable' });
  });

  it('returns undefined when there is nothing usable', () => {
    expect(parseNativeModeration(undefined)).toBeUndefined();
    expect(parseNativeModeration({})).toBeUndefined();
  });

  it('the OpenAI Responses adapter emits body.moderation natively, and skips it when forced to emulate', () => {
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'k' });
    const base: NormalizedRequest = { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] };
    const native = adapter.buildRequest({ ...base, moderation: { model: 'omni-moderation-latest' } });
    expect((native.body as { moderation?: unknown }).moderation).toEqual({
      model: 'omni-moderation-latest',
    });
    const emulated = adapter.buildRequest({ ...base, moderation: { mode: 'emulate' } });
    expect((emulated.body as { moderation?: unknown }).moderation).toBeUndefined();
  });
});

// ─── Emulated complete() ──────────────────────────────────────────────────────

describe('emulated moderation — complete()', () => {
  it('attaches an emulated report (input + output) on a non-OpenAI provider', async () => {
    const client = makeClient({ provider: 'anthropic', fetch: moderatingFetch(true) });
    const res = await client.complete('please moderate me', { moderation: { apiKey: 'oa-key' } });
    expect(res.moderation?.source).toBe('emulated');
    expect((res.moderation?.input as { flagged: boolean }).flagged).toBe(true);
    expect((res.moderation?.output as { flagged: boolean }).flagged).toBe(true);
  });

  it('honours input:false / output:false', async () => {
    const client = makeClient({ provider: 'anthropic' });
    const res = await client.complete('hi', { moderation: { apiKey: 'oa-key', output: false } });
    expect(res.moderation?.input).toBeDefined();
    expect(res.moderation?.output).toBeUndefined();
  });

  it('reuses the client key when the provider IS OpenAI (no separate key needed)', async () => {
    const client = makeClient({ provider: 'openai', fetch: moderatingFetch(false) });
    // mode forced to emulate so it goes through the client-side path using client-key
    const res = await client.complete('hi', { moderation: { mode: 'emulate' } });
    expect(res.moderation?.source).toBe('emulated');
  });

  it('throws when emulation has no resolvable OpenAI key', async () => {
    const client = makeClient({ provider: 'anthropic' });
    await expect(client.complete('hi', { moderation: {} })).rejects.toThrow(/OpenAI API key/);
  });

  it('emits an honest-zero cost entry per emulated moderation call', async () => {
    const hooks = new HookBus();
    let zeros = 0;
    hooks.on('onCostEntry', (c: { entry: { tags: Record<string, string | undefined> } }) => {
      if (c.entry.tags.type === 'moderation') zeros++;
    });
    const client = makeClient({ provider: 'anthropic', hooks });
    await client.complete('hi', { moderation: { apiKey: 'oa-key' } }); // input + output → 2
    expect(zeros).toBe(2);
  });
});

// ─── Streaming strategies ─────────────────────────────────────────────────────

const TEXTS: StreamEvent[] = [
  { type: 'text', text: 'aa' },
  { type: 'text', text: 'bb' },
  { type: 'done', finishReason: 'stop' },
];

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe('emulated moderation — streaming strategies', () => {
  it('post: all text first, then one output moderation event at the end', async () => {
    const client = makeClient({ provider: 'anthropic', fetchStream: streamOf(TEXTS) });
    const out = await collect(
      client.stream('hi', { moderation: { apiKey: 'k', input: false, stream: { strategy: 'post' } } }),
    );
    const types = out.map((e) => e.type);
    const lastMod = types.lastIndexOf('moderation');
    const lastText = types.lastIndexOf('text');
    expect(lastMod).toBeGreaterThan(lastText); // moderation comes after the text
    expect(out.filter((e) => e.type === 'moderation')).toHaveLength(1);
  });

  it('buffer: the moderation event precedes the held text it covers', async () => {
    const client = makeClient({ provider: 'anthropic', fetchStream: streamOf(TEXTS) });
    const out = await collect(
      client.stream('hi', {
        moderation: { apiKey: 'k', input: false, stream: { strategy: 'buffer', interval: 1 } },
      }),
    );
    // first event must be a moderation result (the 'aa' chunk is held behind it)
    expect(out[0].type).toBe('moderation');
    const firstTextIdx = out.findIndex((e) => e.type === 'text');
    expect(firstTextIdx).toBeGreaterThan(0);
  });

  it('parallel: text is NOT held (first event is text), moderation still surfaces', async () => {
    const client = makeClient({ provider: 'anthropic', fetchStream: streamOf(TEXTS) });
    const out = await collect(
      client.stream('hi', {
        moderation: { apiKey: 'k', input: false, stream: { strategy: 'parallel', interval: 1 } },
      }),
    );
    expect(out[0].type).toBe('text'); // chunk delivered before any moderation result
    expect(out.some((e) => e.type === 'moderation')).toBe(true);
  });

  it('input moderation is emitted first (before any output)', async () => {
    const client = makeClient({ provider: 'anthropic', fetchStream: streamOf(TEXTS) });
    const out = await collect(
      client.stream('hi', { moderation: { apiKey: 'k', stream: { strategy: 'post' } } }),
    );
    expect(out[0].type).toBe('moderation');
    expect((out[0] as { phase: string }).phase).toBe('input');
  });

  it('early abort: consumer breaks on a flagged buffered result before the text is delivered', async () => {
    const client = makeClient({
      provider: 'anthropic',
      fetch: moderatingFetch(true),
      fetchStream: streamOf(TEXTS),
    });
    const seenText: string[] = [];
    let aborted = false;
    for await (const ev of client.stream('hi', {
      moderation: { apiKey: 'k', input: false, stream: { strategy: 'buffer', interval: 1 } },
    })) {
      if (ev.type === 'moderation' && (ev.result as { flagged?: boolean }).flagged) {
        aborted = true;
        break; // consumer aborts — held text is never forwarded
      }
      if (ev.type === 'text') seenText.push(ev.text);
    }
    expect(aborted).toBe(true);
    expect(seenText).toHaveLength(0); // nothing flagged reached the consumer
  });

  it('the streamed onCompletion response carries the emulated report', async () => {
    const hooks = new HookBus();
    let captured: CompletionResponse | undefined;
    hooks.on('onCompletion', (c: { response: CompletionResponse }) => {
      captured = c.response;
    });
    const client = makeClient({ provider: 'anthropic', hooks, fetchStream: streamOf(TEXTS) });
    await collect(
      client.stream('hi', { moderation: { apiKey: 'k', stream: { strategy: 'post' } } }),
    );
    expect(captured?.moderation?.source).toBe('emulated');
    expect(captured?.moderation?.input).toBeDefined();
    expect(captured?.moderation?.output).toBeDefined();
  });
});

// ─── Native streaming capture ─────────────────────────────────────────────────

describe('native moderation — streaming capture', () => {
  it('captures native moderation stream events into the onCompletion report', async () => {
    const hooks = new HookBus();
    let captured: CompletionResponse | undefined;
    hooks.on('onCompletion', (c: { response: CompletionResponse }) => {
      captured = c.response;
    });
    // OpenAI provider → native mode → no emulation; the adapter passthrough yields
    // moderation events directly (simulated here via the JSON passthrough adapter).
    const events: StreamEvent[] = [
      { type: 'text', text: 'hello' },
      { type: 'moderation', phase: 'input', result: { flagged: false } as never, source: 'native' },
      { type: 'moderation', phase: 'output', result: { flagged: true } as never, source: 'native' },
      { type: 'done', finishReason: 'stop' },
    ];
    const client = makeClient({ provider: 'openai', hooks, fetchStream: streamOf(events) });
    await collect(client.stream('hi', { moderation: { model: 'omni-moderation-latest' } }));
    expect(captured?.moderation?.source).toBe('native');
    expect((captured?.moderation?.output as { flagged: boolean }).flagged).toBe(true);
  });
});
