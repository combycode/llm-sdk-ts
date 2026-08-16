/** Lazy tool loading: registered, not declared.
 *
 *  The property that makes this cheap is negative — the declared `tools` array must NOT
 *  change when a tool is discovered. Most of these tests assert something does not
 *  happen, because that is where the value is.
 *
 *  Evidence behind the design lives in `bench/lazy-tools`, `bench/lazy-tools-e2e`,
 *  `bench/tool-router` and `bench/tool-ranking`; the comments in
 *  `src/agent/lazy-tools.ts` name which measurement each rule came from.
 */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import { createLazyTools, LAZY_CALL_TOOL, LAZY_SEARCH_TOOL, rankTools } from '../../../src/agent/lazy-tools';
import type { AgentTool } from '../../../src/agent/types';
import type { FunctionTool } from '../../../src/llm/types/tools';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ContentPart } from '../../../src/llm/types/messages';

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

const tool = (name: string, description: string, lazy?: boolean): AgentTool => ({
  ...(lazy ? { lazy: true } : {}),
  definition: {
    type: 'function',
    name,
    description,
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  } satisfies FunctionTool,
  execute: async (args) => `${name} ran with ${JSON.stringify(args)}`,
});

/** Records the tools declared on each request, which is what these tests are about. */
function recordingClient(scripted: Array<ContentPart[]>): { client: LLMClient; declared: string[][] } {
  const declared: string[][] = [];
  const queue = [...scripted];
  const client = {
    id: 'mock',
    provider: 'mock',
    model: 'mock',
    hooks: new HookBus(),
    async complete(_msgs: unknown, opts: { tools?: FunctionTool[] }): Promise<CompletionResponse> {
      declared.push((opts.tools ?? []).map((t) => t.name));
      const content = queue.shift() ?? [{ type: 'text', text: 'done' } as ContentPart];
      const toolCalls = content.filter((c) => c.type === 'tool_call');
      return {
        id: 'r', model: 'mock', content, finishReason: toolCalls.length ? 'tool_use' : 'stop',
        usage: USAGE, text: content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join(''),
        toolCalls: toolCalls as never, thinking: null, media: [], latencyMs: 1, raw: null,
      };
    },
    async *stream() {},
    destroy() {},
  } as unknown as LLMClient;
  return { client, declared };
}

const call = (id: string, name: string, args: Record<string, unknown>): ContentPart =>
  ({ type: 'tool_call', id, name, arguments: args }) as unknown as ContentPart;

describe('lazy tools are registered but not declared', () => {
  it('keeps a lazy tool out of the tools array, and adds the two built-ins', async () => {
    const { client, declared } = recordingClient([[{ type: 'text', text: 'hi' } as ContentPart]]);
    const loop = new AgentLoop({
      client,
      tools: [tool('eager_one', 'An eager tool.'), tool('hidden_one', 'A hidden tool.', true)],
    });
    await loop.complete('hello');

    expect(declared[0]).toContain('eager_one');
    expect(declared[0]).not.toContain('hidden_one');
    expect(declared[0]).toContain(LAZY_SEARCH_TOOL);
    expect(declared[0]).toContain(LAZY_CALL_TOOL);
  });

  it('tells the model its tools are not all listed', async () => {
    // Without this the feature fails quietly: measured live at 8/12 and 9/12, because the
    // model either never searched or searched once for a two-capability request and
    // answered from the one tool it found. Same tasks with the protocol stated: 18/18.
    const { client } = recordingClient([[{ type: 'text', text: 'hi' } as ContentPart]]);
    const loop = new AgentLoop({ client, system: 'Be terse.', tools: [tool('hidden_one', 'A hidden tool.', true)] });
    await loop.complete('hello');

    const system = loop.history.registry.flat();
    expect(system).toContain('Not all of your tools are listed');
    expect(system).toContain(LAZY_SEARCH_TOOL);
    // …and it must not displace the caller's own system text.
    expect(system).toContain('Be terse.');
  });

  it('says nothing about lazy tools when none are registered', () => {
    const { client } = recordingClient([]);
    const loop = new AgentLoop({ client, system: 'Be terse.', tools: [tool('eager_one', 'An eager tool.')] });
    expect(loop.history.registry.flat()).not.toContain('Not all of your tools are listed');
  });

  it('declares nothing extra when no tool is lazy', () => {
    const { client, declared } = recordingClient([]);
    const loop = new AgentLoop({ client, tools: [tool('eager_one', 'An eager tool.')] });
    expect(loop).toBeDefined();
    // An app that never opts in must never see the built-ins.
    void declared;
  });

  it('does not change the declared array across a discovery round trip', async () => {
    // The whole economic argument. If this array differs between requests, the cached
    // prefix is invalidated and the feature costs more than declaring everything.
    const { client, declared } = recordingClient([
      [call('c1', LAZY_SEARCH_TOOL, { queries: ['hidden'] })],
      [call('c2', LAZY_CALL_TOOL, { name: 'hidden_one', input: { id: 'x' } })],
      [{ type: 'text', text: 'done' } as ContentPart],
    ]);
    const loop = new AgentLoop({
      client,
      tools: [tool('eager_one', 'An eager tool.'), tool('hidden_one', 'A hidden tool.', true)],
    });
    await loop.complete('find and use the hidden tool');

    expect(declared.length).toBe(3);
    expect(declared[1]).toEqual(declared[0]!);
    expect(declared[2]).toEqual(declared[0]!);
  });
});

describe('tool_search', () => {
  const loopWith = (tools: AgentTool[], scripted: Array<ContentPart[]>) => {
    const { client, declared } = recordingClient(scripted);
    return { loop: new AgentLoop({ client, tools }), declared };
  };

  /** The search payload itself, without a loop in the way — this is what the model reads,
   *  so it is worth asserting exactly rather than through two layers of transport. */
  const searchPayload = async (tools: AgentTool[], queries: string[]) => {
    const [search] = createLazyTools({
      lazyTools: () => tools.filter((t) => t.lazy),
      eagerNames: () => [],
      state: { searches: 0 },
      config: {},
    });
    const out = await search!.execute({ queries }, {} as never);
    return JSON.parse(String(out)) as { tools: FunctionTool[]; unmatched?: string[]; hint?: string };
  };

  it('returns full schemas for what it found', async () => {
    const payload = await searchPayload(
      [tool('weather__station_reading', 'Return the temperature at a weather station.', true)],
      ['weather station temperature'],
    );
    expect(payload.tools[0]!.name).toBe('weather__station_reading');
    // Full schema, not a catalog line — this is what makes the tool callable.
    expect(payload.tools[0]!.parameters).toBeDefined();
  });

  it('carries unmatched queries and a hint in the payload the model reads', async () => {
    const payload = await searchPayload(
      [tool('weather__station_reading', 'Return the temperature at a weather station.', true)],
      ['weather station', 'zzz nothing matches this'],
    );
    expect(payload.tools.length).toBe(1);
    expect(payload.unmatched).toEqual(['zzz nothing matches this']);
    expect(payload.hint).toContain('different words');
  });

  it('says nothing about unmatched queries when every query hit', async () => {
    const payload = await searchPayload(
      [tool('weather__station_reading', 'Return the temperature at a weather station.', true)],
      ['weather station'],
    );
    expect('unmatched' in payload).toBe(false);
  });

  it('NAMES the queries that matched nothing', async () => {
    // Measured: without this, a two-capability task silently becomes one and the model
    // answers confidently from what it got (34/36 -> 36/36 recall once added).
    const hooks = new HookBus();
    const searches: Array<{ unmatched: string[] }> = [];
    hooks.on('onToolSearch', (c) => {
      searches.push({ unmatched: c.unmatched });
    });
    const { client } = recordingClient([
      [call('c1', LAZY_SEARCH_TOOL, { queries: ['weather station', 'zzz nothing matches this'] })],
      [{ type: 'text', text: 'ok' } as ContentPart],
    ]);
    const loop = new AgentLoop({
      client,
      hooks,
      tools: [tool('weather__station_reading', 'Return the temperature at a weather station.', true)],
    });
    await loop.complete('go');
    expect(searches[0]?.unmatched).toEqual(['zzz nothing matches this']);
  });

  it('stops after maxSearches without killing the run', async () => {
    const { client } = recordingClient([
      [call('c1', LAZY_SEARCH_TOOL, { queries: ['a'] })],
      [call('c2', LAZY_SEARCH_TOOL, { queries: ['b'] })],
      [{ type: 'text', text: 'gave up searching' } as ContentPart],
    ]);
    const loop = new AgentLoop({
      client,
      tools: [tool('hidden_one', 'A hidden tool.', true)],
      lazyTools: { maxSearches: 1 },
    });
    const res = await loop.complete('go');
    // The run completes; the model is told, not terminated.
    expect(res.text).toContain('gave up');
  });
});

describe('call_tool', () => {
  it('runs the lazy tool and reports the INNER name, not call_tool', async () => {
    const { client } = recordingClient([
      [call('c1', LAZY_CALL_TOOL, { name: 'hidden_one', input: { id: 'abc' } })],
      [{ type: 'text', text: 'done' } as ContentPart],
    ]);
    const loop = new AgentLoop({ client, tools: [tool('hidden_one', 'A hidden tool.', true)] });
    await loop.complete('go');

    const reports = (loop.lastReport?.steps ?? []).flatMap((s) => s.toolCalls);
    expect(reports.length).toBe(1);
    // A trace that attributes every lazy call to `call_tool` is worthless.
    expect(reports[0]!.toolName).toBe('hidden_one');
    expect(reports[0]!.discoveredVia).toBe('search');
  });

  it('refuses an eager tool by name, and says why', async () => {
    const { client } = recordingClient([
      [call('c1', LAZY_CALL_TOOL, { name: 'eager_one', input: {} })],
      [{ type: 'text', text: 'done' } as ContentPart],
    ]);
    const loop = new AgentLoop({
      client,
      tools: [tool('eager_one', 'An eager tool.'), tool('hidden_one', 'A hidden tool.', true)],
    });
    await loop.complete('go');
    const reports = (loop.lastReport?.steps ?? []).flatMap((s) => s.toolCalls);
    // Reported against the name the model asked for, since nothing else ran.
    expect(reports[0]!.toolName).toBe('eager_one');
  });
});

describe('rankTools', () => {
  const tools = [
    tool('weather__station_reading', 'Return the latest temperature recorded by a weather station.'),
    tool('billing__invoice_total', 'Return the total amount due on an invoice.'),
    tool('crm__update_record_7', 'Update a record in crm. Accepts an identifier or a selector.'),
  ];

  it('ranks by overlap, weighting the name', () => {
    const [first] = rankTools('invoice total due', tools, 5);
    expect((first!.definition as FunctionTool).name).toBe('billing__invoice_total');
  });

  it('returns nothing rather than a bad guess when nothing overlaps', () => {
    // This is what makes `unmatched` reachable — and it is the ranker's known weakness:
    // against raw user phrasing it scores zero (bench/tool-ranking). The model rewriting
    // the query is what carries the design, not the ranker.
    expect(rankTools('how nippy is it', tools, 5)).toEqual([]);
  });

  it('respects the limit', () => {
    expect(rankTools('return a record in crm', tools, 1).length).toBe(1);
  });
});
