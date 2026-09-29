/** A tool call and its result travel together, or not at all.
 *
 *  Anthropic and OpenAI both reject a history containing a tool call nothing
 *  answered — and equally a result that answers nothing. Either way the failure
 *  lands on the NEXT request, one turn away from whatever actually broke the
 *  pair, with an error that names neither. */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { ConversationHistory } from '../../../src/agent/history';
import { HookBus } from '../../../src/bus/hook-bus';
import type { AgentTool } from '../../../src/agent/types';
import type { LLMClient } from '../../../src/llm/client';
import type { Message } from '../../../src/llm/types/messages';
import type { WarningContext } from '../../../src/bus/hook-map';

const usage = {
  inputTokens: 1, outputTokens: 1, totalTokens: 2,
  cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
};

const call = (id: string, name = 't') =>
  ({ role: 'assistant', content: [{ type: 'tool_call', id, name, arguments: {} }] }) as Message;
const result = (id: string) =>
  ({ role: 'tool', content: [{ type: 'tool_result', id, content: 'ok' }] }) as Message;
const text = (role: 'user' | 'assistant', t: string) => ({ role, content: t }) as Message;

describe('ConversationHistory.truncate keeps pairs whole', () => {
  it('drops a result whose call would be cut away', () => {
    const h = new ConversationHistory();
    for (const m of [text('user', 'a'), call('c1'), result('c1'), text('assistant', 'done')]) h.append(m);
    // Keeping 2 would start the history at `result(c1)` — an answer to nothing.
    h.truncate(2);
    const roles = h.messages().map((m) => m.role);
    expect(roles).not.toContain('tool');
    expect(h.messages()).toHaveLength(1);
    expect(h.messages()[0]!.content).toBe('done');
  });

  it('keeps a pair that survives the cut intact', () => {
    const h = new ConversationHistory();
    for (const m of [text('user', 'a'), text('user', 'b'), call('c1'), result('c1')]) h.append(m);
    h.truncate(2);
    const parts = h.messages().flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(parts.filter((p) => p.type === 'tool_call')).toHaveLength(1);
    expect(parts.filter((p) => p.type === 'tool_result')).toHaveLength(1);
  });

  it('does not disturb a history with no tool traffic', () => {
    const h = new ConversationHistory();
    for (const m of [text('user', 'a'), text('assistant', 'b'), text('user', 'c')]) h.append(m);
    h.truncate(2);
    expect(h.messages().map((m) => m.content)).toEqual(['b', 'c']);
  });

  it('reindexes what it keeps', () => {
    const h = new ConversationHistory();
    for (const m of [text('user', 'a'), call('c1'), result('c1'), text('assistant', 'd')]) h.append(m);
    h.truncate(2);
    expect(h.all().map((e) => e.index)).toEqual([0]);
  });
});

describe('an interrupted turn is repaired before the next run', () => {
  const idleClient = () =>
    ({
      provider: 'openai',
      model: 'mock-model',
      api: 'responses',
      async *stream() {
        yield { type: 'text' as const, text: 'ok' };
        yield { type: 'usage' as const, usage };
        yield { type: 'done' as const, finishReason: 'stop' };
      },
      destroy() {},
    }) as unknown as LLMClient;

  const tool: AgentTool = {
    definition: { type: 'function', name: 't', description: 'x', parameters: { type: 'object', properties: {} } },
    execute: async () => 'ok',
  };

  /** The shape every interruption leaves behind: the call is the last thing in
   *  history, because execution never got far enough to append a result. */
  const interrupted = () => {
    const h = new ConversationHistory();
    h.append(text('user', 'go'));
    h.append(call('orphan-1', 'delete_files'));
    return h;
  };

  it('answers the orphan, so the next request is sendable', async () => {
    const loop = new AgentLoop({ client: idleClient(), tools: [tool], history: interrupted() });
    for await (const _ of loop.stream('next')) {
      /* drain */
    }
    const parts = loop.history.messages().flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const calls = parts.filter((p) => p.type === 'tool_call');
    const results = parts.filter((p) => p.type === 'tool_result');
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect((results[0] as { id: string }).id).toBe('orphan-1');
  });

  it('says the tool never ran, rather than inventing a success', async () => {
    const loop = new AgentLoop({ client: idleClient(), tools: [tool], history: interrupted() });
    for await (const _ of loop.stream('next')) {
      /* drain */
    }
    const res = loop.history
      .messages()
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((p) => p.type === 'tool_result') as { content: string; isError?: boolean };
    expect(res.content).toContain('never run');
    expect(res.content).toContain('delete_files');
    expect(res.isError).toBe(true);
  });

  it('the repair lands BEFORE the new user message', async () => {
    const loop = new AgentLoop({ client: idleClient(), tools: [tool], history: interrupted() });
    for await (const _ of loop.stream('next')) {
      /* drain */
    }
    const roles = loop.history.messages().map((m) => m.role);
    expect(roles.indexOf('tool')).toBeLessThan(roles.lastIndexOf('user'));
  });

  it('warns, because a synthesised result is not a silent detail', async () => {
    const hooks = new HookBus();
    const warnings: WarningContext[] = [];
    hooks.on('onWarning', (w) => {
      warnings.push(w);
    });
    const loop = new AgentLoop({ client: idleClient(), tools: [tool], hooks, history: interrupted() });
    for await (const _ of loop.stream('next')) {
      /* drain */
    }
    const w = warnings.find((x) => x.code === 'unanswered_tool_calls_repaired');
    expect(w).toBeDefined();
    expect(w?.details?.callIds).toEqual(['orphan-1']);
  });

  it('leaves a well-formed history completely alone', async () => {
    const h = new ConversationHistory();
    for (const m of [text('user', 'go'), call('c1'), result('c1')]) h.append(m);
    const before = h.length;
    const loop = new AgentLoop({ client: idleClient(), tools: [tool], history: h });
    for await (const _ of loop.stream('next')) {
      /* drain */
    }
    // Exactly the new user turn and the assistant reply — no repair entry.
    expect(loop.history.length).toBe(before + 2);
  });
});
