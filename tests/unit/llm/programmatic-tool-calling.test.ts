/** Programmatic tool calling — the model writes code that calls tools.
 *
 *  Fixtures are trimmed from REAL /v1/responses bodies captured on 2026-08-09 against
 *  `gpt-5.6-sol` (the only family that accepts the `programmatic_tool_calling` tool —
 *  all 53 gpt-5/o3/o4/codex models on the account were tried one at a time). */

import { describe, expect, it } from 'bun:test';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import type { Message, ProgramCallPart, ToolCallPart } from '../../../src/llm/types/messages';
import type { NormalizedRequest } from '../../../src/llm/types/request';

const adapter = new OpenAIResponsesAdapter({ apiKey: 'k' });

const PROGRAM_CALL_ID = 'call_N6BSLdVXdOyP48ikRDK5skA2';
const REASONING_ITEM = {
  id: 'rs_0858295391ff4757006a7867cab5e081979cba14356eada300',
  type: 'reasoning',
  content: [],
  encrypted_content: 'gAAAAAB…',
  summary: [],
};
const PROGRAM_ITEM = {
  id: 'cm_0858295391ff4757006a7867cc4eec81978e181e75ff25efc8',
  type: 'program',
  call_id: PROGRAM_CALL_ID,
  code: 'const cities = ["Paris"];\nfor (const city of cities) await tools.get_weather({ city });',
  fingerprint: 'gAAAAABqeGfMmLrRirmd…',
};
const CALL_ITEM = {
  id: 'fc_0858295391ff4757006a7867cc56588197a39c633510584f17',
  type: 'function_call',
  status: 'in_progress',
  arguments: '{"city":"Paris"}',
  call_id: 'call_8LLKmtHham2NYjQ2D4Zqj4Wd',
  caller: { type: 'program', caller_id: PROGRAM_CALL_ID },
  name: 'get_weather',
};
const PROGRAM_OUTPUT_ITEM = {
  id: 'cmo_06125d7712ab4c10016a78681b4924819798c6192cb4b216fc',
  type: 'program_output',
  status: 'completed',
  call_id: PROGRAM_CALL_ID,
  result: '{"city":"Paris","result":{"celsius":21}}',
};

function parse(output: unknown[]) {
  return adapter.parseResponse({ id: 'resp_1', output, usage: {} }, 1);
}

function build(messages: Message[]): Record<string, unknown>[] {
  const req = { model: 'gpt-5.6-sol', messages } as NormalizedRequest;
  return (adapter.buildRequest(req).body as { input: Record<string, unknown>[] }).input;
}

// ─── parsing ─────────────────────────────────────────────────────────────────

describe('parsing a programmatic turn', () => {
  it('produces a program_call part carrying the code the model wrote', () => {
    const res = parse([REASONING_ITEM, PROGRAM_ITEM, CALL_ITEM]);
    const program = res.content.find((p) => p.type === 'program_call') as ProgramCallPart;
    expect(program).toBeDefined();
    expect(program.id).toBe(PROGRAM_CALL_ID);
    expect(program.code).toContain('await tools.get_weather');
    expect(program.fingerprint).toBe(PROGRAM_ITEM.fingerprint);
  });

  it('binds the reasoning item to the program so it can be sent back', () => {
    const res = parse([REASONING_ITEM, PROGRAM_ITEM, CALL_ITEM]);
    const program = res.content.find((p) => p.type === 'program_call') as ProgramCallPart;
    const meta = program._meta as { itemId?: string; boundItems?: { id: string }[] };
    expect(meta.itemId).toBe(PROGRAM_ITEM.id);
    // The API rejects the program item without it: "Item 'cm_…' of type 'code_mode' was
    // provided without its required 'reasoning' item".
    expect(meta.boundItems?.[0]?.id).toBe(REASONING_ITEM.id);
  });

  it('tags the program-made tool call with its caller', () => {
    const res = parse([REASONING_ITEM, PROGRAM_ITEM, CALL_ITEM]);
    const call = res.toolCalls[0];
    expect(call.caller).toEqual({ type: 'program', callerId: PROGRAM_CALL_ID });
    // Still an ordinary tool call in every other respect — the loop executes it as usual.
    expect(call.name).toBe('get_weather');
    expect(call.arguments).toEqual({ city: 'Paris' });
  });

  it('leaves caller undefined for an ordinary direct call', () => {
    const res = parse([{ type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' }]);
    expect(res.toolCalls[0].caller).toBeUndefined();
  });

  it('parses the program result and its terminal status', () => {
    const res = parse([PROGRAM_OUTPUT_ITEM]);
    const result = res.content.find((p) => p.type === 'program_result');
    expect(result).toEqual({
      type: 'program_result',
      id: PROGRAM_CALL_ID,
      result: '{"city":"Paris","result":{"celsius":21}}',
      status: 'completed',
      _meta: { itemId: PROGRAM_OUTPUT_ITEM.id },
    });
  });

  it('keeps an unknown caller type instead of discarding it', () => {
    // R1: the vocabulary is the provider's. A caller kind we have never seen must reach
    // the consumer, not be silently flattened to direct.
    const res = parse([
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}', caller: { type: 'agent' } },
    ]);
    expect(res.toolCalls[0].caller).toEqual({ type: 'agent' });
  });

  it('ignores a malformed caller rather than throwing', () => {
    const res = parse([
      { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}', caller: 'program' },
    ]);
    expect(res.toolCalls[0].caller).toBeUndefined();
  });
});

// ─── round-tripping ──────────────────────────────────────────────────────────

describe('sending a programmatic turn back', () => {
  const assistantTurn = (): Message => {
    const res = parse([REASONING_ITEM, PROGRAM_ITEM, CALL_ITEM]);
    return { role: 'assistant', content: res.content };
  };

  it('re-emits the reasoning item BEFORE the program item', () => {
    const input = build([{ role: 'user', content: 'temps?' }, assistantTurn()]);
    const types = input.map((i) => i.type ?? i.role);
    // Order matters and the pair is inseparable: without the reasoning item the request
    // 400s, and without the program item the model silently restarts the program.
    expect(types).toEqual(['user', 'reasoning', 'program', 'function_call']);
    expect(input[1].id).toBe(REASONING_ITEM.id);
    expect(input[1].encrypted_content).toBe(REASONING_ITEM.encrypted_content);
  });

  it('re-emits the program with its original item id, code and fingerprint', () => {
    const input = build([assistantTurn()]);
    const program = input.find((i) => i.type === 'program') as Record<string, unknown>;
    expect(program.id).toBe(PROGRAM_ITEM.id);
    expect(program.call_id).toBe(PROGRAM_CALL_ID);
    expect(program.fingerprint).toBe(PROGRAM_ITEM.fingerprint);
    expect(program.code).toBe(PROGRAM_ITEM.code);
  });

  it('converts callerId back to the wire spelling caller_id', () => {
    const input = build([assistantTurn()]);
    const call = input.find((i) => i.type === 'function_call') as Record<string, unknown>;
    expect(call.caller).toEqual({ type: 'program', caller_id: PROGRAM_CALL_ID });
  });

  it('carries the caller on a tool result too', () => {
    const input = build([
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            id: 'call_1',
            content: '{"celsius":21}',
            caller: { type: 'program', callerId: PROGRAM_CALL_ID },
          },
        ],
      },
    ]);
    const out = input.find((i) => i.type === 'function_call_output') as Record<string, unknown>;
    expect(out.caller).toEqual({ type: 'program', caller_id: PROGRAM_CALL_ID });
  });

  it('omits caller entirely when there is none', () => {
    const input = build([
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'f', arguments: {} }] },
    ]);
    const call = input.find((i) => i.type === 'function_call') as Record<string, unknown>;
    expect('caller' in call).toBe(false);
  });

  it('sends a finished program result back as program_output', () => {
    const res = parse([PROGRAM_OUTPUT_ITEM]);
    const input = build([{ role: 'assistant', content: res.content }]);
    const out = input.find((i) => i.type === 'program_output') as Record<string, unknown>;
    // A completed run is replayed as history for follow-up questions, so this item has
    // to be accepted as input. `id` is required here and nowhere else: omitting it made a
    // follow-up question 400 on a conversation that had just succeeded (found live —
    // every unit test was green at the time).
    expect(out).toEqual({
      type: 'program_output',
      id: PROGRAM_OUTPUT_ITEM.id,
      call_id: PROGRAM_CALL_ID,
      result: PROGRAM_OUTPUT_ITEM.result,
      status: 'completed',
    });
  });

  it('emits a program with no bound items when none were captured', () => {
    // Hand-built history: nothing to echo, so we send what we have and let the API say
    // what is missing rather than inventing a reasoning item.
    const input = build([
      {
        role: 'assistant',
        content: [{ type: 'program_call', id: 'call_x', code: 'x', fingerprint: 'f' }],
      },
    ]);
    expect(input.map((i) => i.type)).toEqual(['program']);
  });
});

// ─── allowed callers ─────────────────────────────────────────────────────────

import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import { emptyUsage } from '../../../src/llm/types/response';
import type { CompletionResponse } from '../../../src/llm/types/response';

/** A client that returns one scripted tool call, then a plain answer. */
function clientWithCall(call: ToolCallPart) {
  let i = 0;
  return {
    id: 'c1',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    api: 'responses',
    mode: 'sync',
    batchable: false,
    complete: async (): Promise<CompletionResponse> => {
      const first = i++ === 0;
      return {
        id: 'r',
        model: 'gpt-5.6-sol',
        content: first ? [call] : [{ type: 'text', text: 'done' }],
        finishReason: first ? 'tool_use' : 'stop',
        usage: emptyUsage(),
        text: first ? '' : 'done',
        toolCalls: first ? [call] : [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      } as CompletionResponse;
    },
  };
}

function loopWith(call: ToolCallPart, allowedCallers?: Array<'direct' | 'programmatic'>) {
  const hooks = new HookBus();
  const warnings: string[] = [];
  hooks.on('onWarning', (w) => {
    warnings.push(w.code);
  });
  let executed = 0;
  const loop = new AgentLoop({
    client: clientWithCall(call) as never,
    hooks,
    tools: [
      {
        definition: {
          type: 'function',
          name: 'get_weather',
          description: 'weather',
          parameters: { type: 'object', properties: {} },
          ...(allowedCallers ? { allowedCallers } : {}),
        },
        execute: async () => {
          executed++;
          return 'sunny';
        },
      },
    ],
  });
  return { loop, warnings, executed: () => executed };
}

const programCall: ToolCallPart = {
  type: 'tool_call',
  id: 'call_1',
  name: 'get_weather',
  arguments: {},
  caller: { type: 'program', callerId: PROGRAM_CALL_ID },
};
const directCall: ToolCallPart = { type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: {} };

describe('allowedCallers enforcement', () => {
  it('runs a programmatic call when the tool opted in', async () => {
    const { loop, executed } = loopWith(programCall, ['programmatic']);
    await loop.complete('go');
    expect(executed()).toBe(1);
  });

  it('refuses a programmatic call to a direct-only tool', async () => {
    const { loop, warnings, executed } = loopWith(programCall, ['direct']);
    await loop.complete('go');
    expect(executed()).toBe(0);
    expect(warnings).toContain('tool_caller_not_allowed');
  });

  it('treats a tool with no allowedCallers as direct-only', async () => {
    // Not merely a default — a tool that never opted in must not be reachable by
    // model-written code, which is the entire point of the restriction.
    const { loop, executed } = loopWith(programCall);
    await loop.complete('go');
    expect(executed()).toBe(0);
  });

  it('leaves ordinary direct calls untouched', async () => {
    for (const allowed of [undefined, ['direct'] as const, ['direct', 'programmatic'] as const]) {
      const { loop, executed } = loopWith(directCall, allowed as never);
      await loop.complete('go');
      expect(executed()).toBe(1);
    }
  });

  it('refuses a direct call to a programmatic-only tool', async () => {
    const { loop, executed, warnings } = loopWith(directCall, ['programmatic']);
    await loop.complete('go');
    expect(executed()).toBe(0);
    expect(warnings).toContain('tool_caller_not_allowed');
  });

  it('reports the refusal to the model instead of ending the run', async () => {
    const { loop } = loopWith(programCall, ['direct']);
    const res = await loop.complete('go');
    // Denying one call the way a guardrail does, rather than throwing, keeps the run
    // recoverable — the model is told why and can choose another route.
    expect(res.text).toBe('done');
  });
});
