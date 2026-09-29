/** A tool call whose arguments never parsed must not be executed.
 *
 *  The accumulator used to fall back to `{}`, and `{}` is a perfectly valid call:
 *  a stream cut at `{"path": "/et` reached the executor as `delete_files()`. The
 *  arguments were gone, the intent was not, and nothing downstream could tell the
 *  difference between "truncated" and "the model asked for no arguments".
 *
 *  Refusing it is only half the fix. The call still has to be ANSWERED, because
 *  Anthropic and OpenAI both reject a history containing a tool call with no
 *  result on the next turn — so the run would die one step later, somewhere else,
 *  for a reason that no longer names the cause. */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import type { AgentTool } from '../../../src/agent/types';
import type { LLMClient } from '../../../src/llm/client';
import type { Message } from '../../../src/llm/types/messages';

const usage = {
  inputTokens: 1, outputTokens: 1, totalTokens: 2,
  cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
};

/** Step 1 truncates mid-JSON; step 2 answers, so the run terminates. */
function truncatingClient() {
  let step = 0;
  return {
    provider: 'openai',
    model: 'mock-model',
    api: 'responses',
    async *stream() {
      step++;
      if (step === 1) {
        yield { type: 'tool_call_start' as const, id: 'c1', name: 'delete_files' };
        yield { type: 'tool_call_delta' as const, id: 'c1', arguments: '{"path": "/et' };
        yield { type: 'usage' as const, usage };
        yield { type: 'done' as const, finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text' as const, text: 'done' };
      yield { type: 'usage' as const, usage };
      yield { type: 'done' as const, finishReason: 'stop' };
    },
    destroy() {},
  } as unknown as LLMClient;
}

describe('a tool call with unparseable arguments', () => {
  const run = async () => {
    const ran: Array<Record<string, unknown>> = [];
    const tool: AgentTool = {
      definition: {
        type: 'function',
        name: 'delete_files',
        description: 'deletes files',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
      execute: async (args) => {
        ran.push(args as Record<string, unknown>);
        return 'deleted';
      },
    };
    const loop = new AgentLoop({ client: truncatingClient(), tools: [tool] });
    for await (const _ of loop.stream('go')) {
      /* drain */
    }
    return { ran, loop };
  };

  it('never reaches the tool', async () => {
    const { ran } = await run();
    expect(ran).toEqual([]);
  });

  it('still answers the call, so the history stays paired', async () => {
    const { loop } = await run();
    const history = loop.history.messages();
    const calls = history.flatMap((m: Message) =>
      (Array.isArray(m.content) ? m.content : []).filter((p) => p.type === 'tool_call'),
    );
    const results = history.flatMap((m: Message) =>
      (Array.isArray(m.content) ? m.content : []).filter((p) => p.type === 'tool_result'),
    );
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect((results[0] as { id: string }).id).toBe((calls[0] as { id: string }).id);
  });

  it('tells the model what went wrong, rather than failing silently', async () => {
    const { loop } = await run();
    const history = loop.history.messages();
    const result = history
      .flatMap((m: Message) => (Array.isArray(m.content) ? m.content : []))
      .find((p) => p.type === 'tool_result') as { content: string; isError?: boolean };
    expect(result.content).toContain('not valid JSON');
    expect(result.content).toContain('delete_files');
    expect(result.isError).toBe(true);
  });
});
