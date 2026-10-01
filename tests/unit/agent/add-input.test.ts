/** A run suspends at an approval gate, and while the human is deciding the user
 *  says something more — "use staging, not prod". There was nowhere to put it.
 *
 *  Appending it to history by hand lands it BEFORE `repairUnansweredToolCalls`,
 *  the gate every run passes through, so the model read the correction and then
 *  a tool result, in that order — the instruction arrives before the thing it
 *  is correcting. And a message held only in the caller's variable is lost if
 *  the process restarts between the gate and the resume, which is the whole
 *  reason the gate is durable.
 *
 *  So staged input is admitted LAST, immediately before the next model call,
 *  and it rides in the snapshot.
 */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { Message } from '../../../src/llm/types/messages';

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

/** A client that answers "ok" and keeps every message list it was sent, so a
 *  test can read what the model actually saw rather than what history holds
 *  afterwards. */
function recordingClient(): { client: LLMClient; sent: Message[][] } {
  const sent: Message[][] = [];
  const client = {
    id: 'mock',
    provider: 'mock' as const,
    model: 'mock-model',
    hooks: new HookBus(),
    api: 'completions' as const,
    mode: 'foreground' as const,
    batchable: false,
    async complete(messages: Message[]): Promise<CompletionResponse> {
      sent.push(messages.map((m) => ({ ...m })));
      return {
        id: 'r1',
        model: 'mock-model',
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop',
        usage: USAGE,
        text: 'ok',
        toolCalls: [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      };
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
  return { client, sent };
}

/** A client that asks for `probe` once and then answers, so a test can run code
 *  inside a tool body — which is unambiguously inside a run. */
function toolThenText(): { client: LLMClient; sent: Message[][] } {
  const sent: Message[][] = [];
  let first = true;
  const client = {
    id: 'mock',
    provider: 'mock' as const,
    model: 'mock-model',
    hooks: new HookBus(),
    api: 'completions' as const,
    mode: 'foreground' as const,
    batchable: false,
    async complete(messages: Message[]): Promise<CompletionResponse> {
      sent.push(messages.map((m) => ({ ...m })));
      const call = { type: 'tool_call' as const, id: 'c1', name: 'probe', arguments: {} };
      const asked = first;
      first = false;
      return {
        id: 'r1',
        model: 'mock-model',
        content: asked ? [call] : [{ type: 'text', text: 'ok' }],
        finishReason: asked ? 'tool_use' : 'stop',
        usage: USAGE,
        text: asked ? '' : 'ok',
        toolCalls: asked ? [call] : [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      } as unknown as CompletionResponse;
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
  return { client, sent };
}

/** The user-role texts the model was shown on the Nth call, in order. */
function userTexts(sent: Message[][], call = 0): string[] {
  return (sent[call] ?? [])
    .filter((m) => m.role === 'user')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>)
            .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
            .join(''),
    );
}

describe('addInput: when the staged message reaches the model', () => {
  it('admits it on the next run, after that run’s own input', async () => {
    // The order IS the feature: a correction read before the message it
    // corrects is not a correction.
    const { client, sent } = recordingClient();
    const agent = new AgentLoop({ client, system: 's' });
    agent.addInput('use staging, not prod');
    await agent.complete('deploy');

    expect(userTexts(sent)).toEqual(['deploy', 'use staging, not prod']);
  });

  it('keeps insertion order across several calls', async () => {
    const { client, sent } = recordingClient();
    const agent = new AgentLoop({ client, system: 's' });
    agent.addInput('first');
    agent.addInput('second');
    await agent.complete('go');

    expect(userTexts(sent)).toEqual(['go', 'first', 'second']);
  });

  it('forgets it once admitted, so a second run does not say it twice', async () => {
    const { client, sent } = recordingClient();
    const agent = new AgentLoop({ client, system: 's' });
    agent.addInput('use staging');
    await agent.complete('deploy');
    await agent.complete('again');

    expect(agent.pendingInput).toEqual([]);
    // The second call still SEES it in the transcript — it is history now — but
    // exactly once, not appended a second time.
    expect(userTexts(sent, 1).filter((t) => t === 'use staging')).toHaveLength(1);
  });

  it('is admitted even when the resumed run passes no input of its own', async () => {
    // The Python sibling resumes with `run(None)`; nothing may make admission
    // depend on there being a fresh message to follow.
    const { client, sent } = recordingClient();
    const agent = new AgentLoop({ client, system: 's' });
    await agent.complete('deploy');
    agent.addInput('use staging');
    await agent.complete('');

    expect(userTexts(sent, 1)).toContain('use staging');
  });

  it('normalizes the input forms the way run() does', async () => {
    const { client, sent } = recordingClient();
    const agent = new AgentLoop({ client, system: 's' });
    agent.addInput([{ type: 'text', text: 'as parts' }]);
    agent.addInput([{ role: 'user', content: 'as a message' }] as Message[]);
    await agent.complete('go');

    expect(userTexts(sent)).toEqual(['go', 'as parts', 'as a message']);
  });
});

describe('addInput: what it refuses and what it discards', () => {
  it('refuses to stage while a run is in flight', async () => {
    // Staging then would reach the NEXT run, so a caller who believed they were
    // adding to the running one got silence and a surprise one turn later. A
    // tool body is the simplest place that is unambiguously inside a run.
    const { client } = toolThenText();
    let threw: unknown;
    const agent = new AgentLoop({
      client,
      system: 's',
      tools: [
        {
          definition: { name: 'probe', description: 'p', parameters: {} },
          execute: async () => {
            expect(agent.running).toBe(true);
            try {
              agent.addInput('late');
            } catch (e) {
              threw = e;
            }
            return 'done';
          },
        },
      ],
    });
    await agent.complete('go');

    expect(threw).toBeInstanceOf(Error);
    expect(String(threw)).toContain('in flight');
    // And it staged nothing: a rejected call must not half-apply.
    expect(agent.pendingInput).toEqual([]);
  });

  it('discards staged input on clearPendingInput', async () => {
    const { client, sent } = recordingClient();
    const agent = new AgentLoop({ client, system: 's' });
    agent.addInput('never mind');
    agent.clearPendingInput();
    await agent.complete('go');

    expect(agent.pendingInput).toEqual([]);
    expect(userTexts(sent)).toEqual(['go']);
  });

  it('reports what is staged, in order, before it is admitted', () => {
    const { client } = recordingClient();
    const agent = new AgentLoop({ client, system: 's' });
    agent.addInput('one');
    agent.addInput('two');
    expect(agent.pendingInput).toHaveLength(2);
    expect(agent.pendingInput[0]?.content).toBe('one');
  });
});

describe('addInput: surviving the restart it exists for', () => {
  it('rides in the snapshot and is admitted by the restored loop', async () => {
    // The message exists NOWHERE else. A dropped approval can be asked for
    // again; a correction the user typed once is simply gone.
    const { client } = recordingClient();
    const agent = new AgentLoop({ client, system: 's' });
    agent.addInput('use staging');
    const snap = agent.dump();
    expect(snap.pendingInput).toHaveLength(1);

    const fresh = recordingClient();
    const restored = AgentLoop.restore(snap, { client: fresh.client, tools: [] });
    expect(restored.pendingInput).toHaveLength(1);
    await restored.complete('deploy');
    expect(userTexts(fresh.sent)).toEqual(['deploy', 'use staging']);
  });

  it('is absent from a snapshot that staged nothing', () => {
    // Not an empty array: that reads as staging which was consumed, and the
    // sibling `pendingToolCalls` is omitted for the same reason.
    const { client } = recordingClient();
    const agent = new AgentLoop({ client, system: 's' });
    expect(agent.dump().pendingInput).toBeUndefined();
  });

  it('is gone from the snapshot taken after it was admitted', async () => {
    const { client } = recordingClient();
    const agent = new AgentLoop({ client, system: 's' });
    agent.addInput('use staging');
    await agent.complete('deploy');
    expect(agent.dump().pendingInput).toBeUndefined();
  });
});
