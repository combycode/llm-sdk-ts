/** The agent loop's final response must propagate hosted-tool file outputs
 *  (response.files) and inline-moderation (response.moderation) from the final
 *  LLM response — e.g. code-execution files produced during the run. Regression
 *  for the loop dropping these fields (found via real code-interpreter testing). */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { Message } from '../../../src/llm/types/messages';
import type { ExecuteOptions } from '../../../src/llm/types/options';

function clientReturning(extra: Partial<CompletionResponse>): LLMClient {
  return {
    id: 'mock', provider: 'mock', model: 'm', system: undefined, hooks: new HookBus(),
    api: 'completions', mode: 'foreground', batchable: false,
    async complete(_i: Message[], _o: ExecuteOptions): Promise<CompletionResponse> {
      return {
        id: 'r', model: 'm', content: [{ type: 'text', text: 'done' }], finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        text: 'done', toolCalls: [], thinking: null, media: [], latencyMs: 1, raw: null,
        ...extra,
      } as CompletionResponse;
    },
    async *stream() {}, destroy() {},
  } as unknown as LLMClient;
}

describe('agent loop response passthrough', () => {
  it('propagates response.files from the final LLM response', async () => {
    const client = clientReturning({ files: [{ id: 'f1', source: 'code_execution' }] });
    const res = await new AgentLoop({ client }).complete('go');
    expect(res.files).toEqual([{ id: 'f1', source: 'code_execution' }]);
  });

  it('propagates response.moderation from the final LLM response', async () => {
    const client = clientReturning({ moderation: { source: 'native', output: { flagged: false } as never } });
    const res = await new AgentLoop({ client }).complete('go');
    expect(res.moderation?.source).toBe('native');
  });

  it('no files → files stays absent', async () => {
    const res = await new AgentLoop({ client: clientReturning({}) }).complete('go');
    expect(res.files).toBeUndefined();
  });

  it('retrieveFile / streamFile delegate to the underlying client', async () => {
    const file = { id: 'f1', source: 'code_execution' };
    const blob = new Blob(['x']);
    const stream = new ReadableStream<Uint8Array>();
    const client = {
      ...clientReturning({}),
      retrieveFile: async (f: unknown) => ({ blob, name: 'chart.png', mimeType: 'image/png', size: 1, _f: f }),
      streamFile: async (f: unknown) => ({ stream, name: 'chart.png', mimeType: 'image/png', size: 1, _f: f }),
    } as unknown as LLMClient;

    const agent = new AgentLoop({ client });
    const r = await agent.retrieveFile(file as never);
    expect(r.blob).toBe(blob);
    expect((r as unknown as { _f: unknown })._f).toBe(file); // exact descriptor passed through
    const s = await agent.streamFile(file as never);
    expect(s.stream).toBe(stream);
    expect((s as unknown as { _f: unknown })._f).toBe(file);
  });
});
