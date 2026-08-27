/** The agent loop must ACCUMULATE citations, not propagate the last step's.
 *
 *  This is where the feature actually broke. Every adapter parsed citations
 *  correctly and every unit test passed, but `complete({ tools })` routes through
 *  `AgentLoop`, which composes a fresh `CompletionResponse` from the run — and a
 *  field the composer does not know about is silently gone. Measured live: all
 *  four providers returned citations from `parseResponse` and zero from
 *  `complete()`.
 *
 *  Accumulating rather than taking `lastResponse` (which is what `files` and
 *  `builtinToolCalls` do) is deliberate: a run can search in step 1 and answer in
 *  step 3, and the sources the answer rests on are the ones from step 1.
 */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import type { LLMClient } from '../../../src/llm/client';
import type { Message } from '../../../src/llm/types/messages';
import type { ExecuteOptions } from '../../../src/llm/types/options';
import type { AgentTool } from '../../../src/agent/types';
import type { CompletionResponse } from '../../../src/llm/types/response';

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

/** A client that replays one scripted response per step. */
function clientScripted(steps: Array<Partial<CompletionResponse>>): LLMClient {
  let i = 0;
  return {
    id: 'mock',
    provider: 'mock',
    model: 'm',
    system: undefined,
    hooks: new HookBus(),
    api: 'completions',
    mode: 'foreground',
    batchable: false,
    async complete(_i: Message[], _o: ExecuteOptions): Promise<CompletionResponse> {
      const extra = steps[Math.min(i++, steps.length - 1)] ?? {};
      return {
        id: 'r',
        model: 'm',
        content: [{ type: 'text', text: 'done' }],
        finishReason: 'stop',
        usage: USAGE,
        text: 'done',
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
        ...extra,
      } as CompletionResponse;
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
}

/** A tool the model calls once, forcing a second step. */
const searchTool: AgentTool = {
  definition: { name: 'note', description: 'note something', parameters: {} },
  execute: async () => 'ok',
};

describe('agent loop citations', () => {
  it('surfaces citations from a single-step run', async () => {
    const client = clientScripted([{ citations: [{ url: 'https://a.example', title: 'A' }] }]);
    const res = await new AgentLoop({ client }).complete('go');
    expect(res.citations).toEqual([{ url: 'https://a.example', title: 'A' }]);
  });

  it('keeps sources cited in an EARLIER step', async () => {
    // The step that searches is not the step that answers. Taking only the last
    // response would return nothing here, and would look correct doing it.
    const client = clientScripted([
      {
        citations: [{ url: 'https://searched.example' }],
        finishReason: 'tool_use',
        toolCalls: [{ type: 'tool_call', id: 'c1', name: 'note', arguments: {} }],
        content: [{ type: 'tool_call', id: 'c1', name: 'note', arguments: {} }],
        text: '',
      },
      { text: 'answer', content: [{ type: 'text', text: 'answer' }] },
    ]);
    const res = await new AgentLoop({ client, tools: [searchTool] }).complete('go');
    expect(res.text).toBe('answer');
    expect(res.citations).toEqual([{ url: 'https://searched.example' }]);
  });

  it('dedupes the same url cited in several steps', async () => {
    // A footnote list that repeats one page is wrong, and multi-step runs cite
    // the same source repeatedly as the model refers back to it.
    const client = clientScripted([
      {
        citations: [{ url: 'https://same.example', title: 'Same' }],
        finishReason: 'tool_use',
        toolCalls: [{ type: 'tool_call', id: 'c1', name: 'note', arguments: {} }],
        content: [{ type: 'tool_call', id: 'c1', name: 'note', arguments: {} }],
        text: '',
      },
      {
        citations: [{ url: 'https://same.example', title: 'Same' }, { url: 'https://new.example' }],
        text: 'answer',
        content: [{ type: 'text', text: 'answer' }],
      },
    ]);
    const res = await new AgentLoop({ client, tools: [searchTool] }).complete('go');
    expect(res.citations).toEqual([
      { url: 'https://same.example', title: 'Same' },
      { url: 'https://new.example' },
    ]);
  });

  it('stays absent when nothing was cited', async () => {
    const res = await new AgentLoop({ client: clientScripted([{}]) }).complete('go');
    expect(res.citations).toBeUndefined();
  });
});
