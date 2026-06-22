/** Streamed completions must emit onCompletion (once, at the end) so the
 *  CostCollector prices streamed chats — and must NOT emit on abort/error. */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { LLMClient } from '../../../src/llm/client';
import type { ProviderAdapter, ProviderHttpRequest } from '../../../src/llm/types/provider';
import type { NormalizedRequest } from '../../../src/llm/types/request';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { StreamEvent } from '../../../src/llm/types/stream';
import { CostCollector } from '../../../src/plugins/cost-collector/collector';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';
import type { EngineFetch, EngineFetchStream, HttpResponse, SSEEvent } from '../../../src/network/types';

function streamAdapter(): ProviderAdapter {
  return {
    name: 'mock' as ProviderAdapter['name'],
    buildRequest(req: NormalizedRequest): ProviderHttpRequest {
      return { body: { model: req.model } };
    },
    parseResponse(): CompletionResponse {
      throw new Error('not used in stream tests');
    },
    // Each SSEEvent.data is a JSON-encoded StreamEvent.
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

const noopFetch: EngineFetch = async () => ({ status: 200, headers: {}, body: {} }) as HttpResponse;

function streamOf(events: StreamEvent[], throwAt?: number): EngineFetchStream {
  return async function* () {
    let i = 0;
    for (const e of events) {
      if (throwAt === i) throw new Error('aborted');
      i++;
      yield { data: JSON.stringify(e) } satisfies SSEEvent;
    }
  } as unknown as EngineFetchStream;
}

function makeClient(hooks: HookBus, fetchStream: EngineFetchStream) {
  return new LLMClient({
    provider: 'openai',
    model: 'mock-model',
    adapter: streamAdapter(),
    apiKey: 'mock-key',
    fetch: noopFetch,
    fetchStream,
    hooks,
  } as never);
}

const usageEvent: StreamEvent = {
  type: 'usage',
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  },
};

describe('LLMClient.stream — onCompletion', () => {
  it('emits onCompletion once at the end with accumulated text + usage', async () => {
    const hooks = new HookBus();
    const completions: Array<{ response: CompletionResponse }> = [];
    hooks.on('onCompletion', (c) => {
      completions.push(c as never);
    });

    const client = makeClient(
      hooks,
      streamOf([
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
        usageEvent,
        { type: 'done', finishReason: 'stop' },
      ]),
    );

    const seen: string[] = [];
    for await (const ev of client.stream('hi')) {
      if (ev.type === 'text') seen.push(ev.text);
    }

    expect(completions.length).toBe(1);
    expect(completions[0].response.text).toBe('Hello');
    expect(completions[0].response.usage.inputTokens).toBe(100);
    expect(completions[0].response.usage.outputTokens).toBe(50);
    expect(seen.join('')).toBe('Hello'); // events still pass through
  });

  it('does NOT emit onCompletion when the stream aborts mid-way', async () => {
    const hooks = new HookBus();
    let fired = 0;
    hooks.on('onCompletion', () => {
      fired++;
    });

    const client = makeClient(
      hooks,
      streamOf([{ type: 'text', text: 'partial' }, usageEvent], 1),
    );

    await expect(
      (async () => {
        for await (const _ of client.stream('hi')) {
          // drain
        }
      })(),
    ).rejects.toThrow('aborted');
    expect(fired).toBe(0);
  });

  it('CostCollector prices a streamed completion from the emitted onCompletion', async () => {
    const hooks = new HookBus();
    const catalog = new ModelCatalog();
    catalog.set('openai', 'mock-model', { pricing: { inputPerMTok: 10, outputPerMTok: 20 } });
    const collector = new CostCollector({ hooks, catalog });

    const client = makeClient(
      hooks,
      streamOf([
        { type: 'text', text: 'x' },
        {
          type: 'usage',
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            totalTokens: 2_000_000,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        },
        { type: 'done', finishReason: 'stop' },
      ]),
    );
    for await (const _ of client.stream('hi')) {
      // drain
    }

    expect(collector.entryCount).toBe(1);
    expect(collector.total().total).toBeCloseTo(30, 6); // 10 + 20
  });
});
