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
});
