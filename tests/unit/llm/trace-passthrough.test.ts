/** The trace must reach the NETWORK layer whole.
 *
 *  The client handed the queue `{ sessionId, requestId, callId }` — three fields picked
 *  by hand. When `traceparent` was added to the trace it was not among them, so the
 *  agent, its tools and its model calls all joined the caller's trace while the
 *  `http.request` spans underneath them rooted a second one. Live run against Grafana,
 *  after the agent-layer fix looked complete.
 *
 *  Hand-picking fields is the recurring shape of this whole class of bug: it happened at
 *  `beginRun`, at the tool ctx, and here. Hence a test that asserts on the field, at the
 *  boundary where it was dropped.
 */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { LLMClient } from '../../../src/llm/client';
import type { ProviderAdapter, ProviderHttpRequest } from '../../../src/llm/types/provider';
import type { NormalizedRequest } from '../../../src/llm/types/request';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { EngineFetch, HttpRequest, HttpResponse, SSEEvent } from '../../../src/network/types';
import type { StreamEvent } from '../../../src/llm/types/stream';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

function mockAdapter(): ProviderAdapter {
  return {
    name: 'mock' as ProviderAdapter['name'],
    buildRequest(req: NormalizedRequest): ProviderHttpRequest {
      return { body: { model: req.model } };
    },
    parseResponse(): CompletionResponse {
      return {
        id: 'r',
        model: 'mock-model',
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        text: 'ok',
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      } as unknown as CompletionResponse;
    },
    parseStreamEvent(sse: SSEEvent): StreamEvent[] {
      return [JSON.parse(sse.data) as StreamEvent];
    },
    createStreamParser() {
      return (sse: SSEEvent) => this.parseStreamEvent(sse);
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

/** Captures the HttpRequest the client hands to the engine. */
function capturingFetch() {
  const seen: HttpRequest[] = [];
  const fetch: EngineFetch = async (req: HttpRequest) => {
    seen.push(req);
    return { status: 200, headers: {}, body: {} } as HttpResponse;
  };
  return { fetch, seen };
}

describe('the trace reaches the network layer whole', () => {
  it('passes traceparent through to the request, alongside the ids', async () => {
    const { fetch, seen } = capturingFetch();
    const client = new LLMClient({
      provider: 'openai',
      model: 'mock-model',
      adapter: mockAdapter(),
      apiKey: 'mock-key',
      fetch,
      hooks: new HookBus(),
    } as never);

    await client.complete([{ role: 'user', content: 'hi' }] as never, {
      ctx: { sessionId: 's', requestId: 'r', traceparent: TRACEPARENT },
    } as never);

    expect(seen.length).toBe(1);
    const trace = seen[0]!.trace!;
    expect(trace.traceparent).toBe(TRACEPARENT);
    // The ids must survive too — this is a widening, not a swap.
    expect(trace.sessionId).toBe('s');
    expect(trace.requestId).toBe('r');
  });

  it('leaves traceparent undefined when the caller is not inside a trace', async () => {
    const { fetch, seen } = capturingFetch();
    const client = new LLMClient({
      provider: 'openai',
      model: 'mock-model',
      adapter: mockAdapter(),
      apiKey: 'mock-key',
      fetch,
      hooks: new HookBus(),
    } as never);

    await client.complete([{ role: 'user', content: 'hi' }] as never, {
      ctx: { sessionId: 's', requestId: 'r' },
    } as never);

    expect(seen[0]!.trace!.traceparent).toBeUndefined();
  });
});
