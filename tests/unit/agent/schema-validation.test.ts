/** Checking against the schema, and telling the MODEL what was wrong.
 *
 *  Two halves, both opt-in, and the reason for opt-in is the same in each: the
 *  bundled validator reads the common JSON Schema keywords and not all of Draft
 *  2020-12 (no `allOf`/`anyOf`, no formats). Always on, it would reject values
 *  that are valid under a schema it cannot fully read — and disagree with the
 *  provider that had just enforced that schema.
 *
 *  **Structured output** (`structured.validate`). The provider enforced the
 *  schema, so this is for where that enforcement is weaker than the schema: a
 *  surface with no strict mode, a model ignoring the schema under load, a
 *  `required` treated as advisory. Failures go through the SAME `repairAttempts`
 *  budget as a parse failure, because a value that parsed and was wrong is
 *  exactly what re-prompting helps with.
 *
 *  **Tool arguments** (`validateToolArguments`). A failure is a tool RESULT
 *  carrying the errors, not an exception: the model asked for something its own
 *  schema forbids, which it can fix on the next step, and ending the run would
 *  discard every step before it. The bound is `maxSteps` — the loop's existing
 *  one, rather than a second budget to tune that would give the same answer.
 */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { createEngine } from '../../../src/index';
import { HookBus } from '../../../src/bus/hook-bus';
import { parseStructured } from '../../../src/llm/client-internal';
import { InvalidFinalOutputError } from '../../../src/llm/output-errors';
import type { AgentTool } from '../../../src/agent/types';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ContentPart } from '../../../src/llm/types/messages';

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

const WEATHER = {
  type: 'object',
  properties: { city: { type: 'string' }, tempC: { type: 'number' } },
  required: ['city', 'tempC'],
} as const;

// ─── the structured-output half ─────────────────────────────────────────────

describe('structured.validate', () => {
  it('is off by default, so a provider-enforced schema is trusted', () => {
    // `tempC` is required and missing. Nothing complains, because the provider
    // was asked to enforce it and a second opinion from a partial validator
    // would only find disagreements.
    expect(parseStructured<{ city: string }>('{"city":"Paris"}', { ...WEATHER })).toEqual({
      city: 'Paris',
    });
  });

  it('reports every error when asked, not just the first', () => {
    // The message is what the model is re-prompted with, so one error at a time
    // costs a whole round trip per mistake.
    let message = '';
    try {
      parseStructured('{"tempC":"warm"}', { ...WEATHER }, { validate: true });
    } catch (e) {
      message = (e as Error).message;
    }
    // Both errors, each located: one error at a time costs a round trip per
    // mistake, and the path is what tells the model WHERE to look.
    expect(message).toContain('$.city');
    expect(message).toContain('$.tempC');
  });

  it('raises the SAME error as a parse failure, so one repair budget covers both', () => {
    // A value that parsed and was wrong is the case re-prompting actually helps
    // with; a separate error type would have excluded it from the budget.
    let caught: unknown;
    try {
      parseStructured('{"city":"Paris"}', { ...WEATHER }, { validate: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidFinalOutputError);
    expect((caught as InvalidFinalOutputError).rawText).toBe('{"city":"Paris"}');
  });

  it('passes a value the schema accepts straight through', () => {
    expect(
      parseStructured<{ city: string; tempC: number }>(
        '{"city":"Paris","tempC":21}',
        { ...WEATHER },
        { validate: true },
      ),
    ).toEqual({ city: 'Paris', tempC: 21 });
  });

  it('has nothing to validate against without a schema', () => {
    // `validate: true` with no schema must not invent one, or a caller who set
    // the flag before deciding on a schema gets a crash instead of a parse.
    expect(parseStructured<{ anything: number }>('{"anything":1}', undefined, { validate: true })).toEqual({
      anything: 1,
    });
  });

  it('still reports malformed JSON as a parse failure, validation or not', () => {
    expect(() => parseStructured('not json', { ...WEATHER }, { validate: true })).toThrow(
      InvalidFinalOutputError,
    );
  });
});

describe('structuredComplete carries the flag, and the repair budget covers it', () => {
  /** Captures each request instead of sending it; always answers the same
   *  schema-violating object. */
  function captureEngine() {
    const sent: Array<Record<string, unknown>> = [];
    const fetch = async (_url: string, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          // `tempC` is required and missing: it parses, and it is wrong.
          content: [{ type: 'text', text: '{"city":"Paris"}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const engine = createEngine({
      apiKeys: { anthropic: 'k' },
      fetch: fetch as never,
      registerAsDefault: false,
    });
    return { engine, sent };
  }

  it('accepts a response that violates the schema when validate is off', async () => {
    const { engine } = captureEngine();
    const llm = engine.createClient({ model: 'anthropic/claude-sonnet-5' });
    expect(
      await llm.structuredComplete<{ city: string }>('weather?', { ...WEATHER }),
    ).toEqual({ city: 'Paris' });
    llm.destroy();
    engine.destroy();
  });

  it('spends the repair budget on a value that parsed and was WRONG', async () => {
    // The reason the validation error is the same type as a parse error. With a
    // separate type the budget would have covered malformed JSON and not this,
    // which is the case re-prompting actually helps with.
    const { engine, sent } = captureEngine();
    const llm = engine.createClient({ model: 'anthropic/claude-sonnet-5' });
    await llm
      .structuredComplete('weather?', { ...WEATHER }, {
        structured: { schema: { ...WEATHER }, validate: true, repairAttempts: 2 },
      })
      .catch(() => undefined);
    // One original attempt plus two repairs.
    expect(sent).toHaveLength(3);
    llm.destroy();
    engine.destroy();
  });

  it('re-prompts with WHAT was wrong, so the retry can be better than the first try', async () => {
    const { engine, sent } = captureEngine();
    const llm = engine.createClient({ model: 'anthropic/claude-sonnet-5' });
    await llm
      .structuredComplete('weather?', { ...WEATHER }, {
        structured: { schema: { ...WEATHER }, validate: true, repairAttempts: 1 },
      })
      .catch(() => undefined);
    // The second request has to carry the COMPLAINT, not merely the schema again.
    // `tempC` alone would pass vacuously: the schema names it too, so the
    // assertion has to be on wording only the validator produces.
    expect(JSON.stringify(sent[1])).toContain('required property missing');
    llm.destroy();
    engine.destroy();
  });

  it('throws once the budget is out, carrying the raw text', async () => {
    const { engine } = captureEngine();
    const llm = engine.createClient({ model: 'anthropic/claude-sonnet-5' });
    let caught: unknown;
    try {
      await llm.structuredComplete('weather?', { ...WEATHER }, {
        structured: { schema: { ...WEATHER }, validate: true },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidFinalOutputError);
    expect((caught as InvalidFinalOutputError).rawText).toBe('{"city":"Paris"}');
    llm.destroy();
    engine.destroy();
  });
});

// ─── the tool-argument half ─────────────────────────────────────────────────

/** Asks for `lookup` with the given arguments, then answers. */
function clientCalling(args: Record<string, unknown>, calls = 1): LLMClient {
  let turn = 0;
  const call: ContentPart = { type: 'tool_call', id: 'c1', name: 'lookup', arguments: args };
  return {
    id: 'mock',
    provider: 'mock',
    model: 'mock-model',
    api: 'completions',
    mode: 'foreground',
    batchable: false,
    hooks: new HookBus(),
    complete: async (): Promise<CompletionResponse> => {
      turn += 1;
      const asking = turn <= calls;
      return {
        id: 'r1',
        model: 'mock-model',
        content: asking ? [call] : [{ type: 'text', text: 'done' }],
        finishReason: asking ? 'tool_use' : 'stop',
        usage: USAGE,
        text: asking ? '' : 'done',
        toolCalls: asking ? [call] : [],
        thinking: null,
        media: [],
        latencyMs: 1,
        raw: null,
      } as unknown as CompletionResponse;
    },
    stream: async function* () {},
    destroy() {},
  } as unknown as LLMClient;
}

function loopFor(args: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  const ran: Array<Record<string, unknown>> = [];
  const warnings: Array<Record<string, unknown>> = [];
  const hooks = new HookBus();
  hooks.on('onWarning', (w) => {
    warnings.push(w as unknown as Record<string, unknown>);
  });
  const lookup: AgentTool = {
    definition: {
      name: 'lookup',
      description: 'Look up a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
    execute: async (a) => {
      ran.push(a as Record<string, unknown>);
      return 'sunny';
    },
  };
  const agent = new AgentLoop({
    client: clientCalling(args),
    tools: [lookup],
    hooks,
    system: 's',
    ...opts,
  } as never);
  return { agent, ran, warnings };
}

describe('validateToolArguments', () => {
  it('is off by default — the tool runs with whatever the model sent', async () => {
    const { agent, ran } = loopFor({ city: 42 });
    await agent.complete('go');
    expect(ran).toHaveLength(1);
    expect(ran[0]).toEqual({ city: 42 });
  });

  it('refuses the call and returns the errors to the model', async () => {
    const { agent, ran } = loopFor({ city: 42 }, { validateToolArguments: true });
    const res = await agent.complete('go');

    // Not executed...
    expect(ran).toHaveLength(0);
    // ...and the run did NOT end: the model got told and answered.
    expect(res.text).toBe('done');

    // The refusal is a tool result the model can read.
    const toolMsg = agent.history
      .all()
      .map((e) => e.message)
      .find((m) => m.role === 'tool');
    expect(JSON.stringify(toolMsg)).toContain('Invalid arguments');
    expect(JSON.stringify(toolMsg)).toContain('city');
  });

  it('tells the model what to DO, not only what went wrong', async () => {
    // A bare validator message reads as an internal error, and models answer
    // those by apologising rather than re-calling the tool.
    const { agent } = loopFor({ city: 42 }, { validateToolArguments: true });
    await agent.complete('go');
    const toolMsg = JSON.stringify(
      agent.history
        .all()
        .map((e) => e.message)
        .find((m) => m.role === 'tool'),
    );
    expect(toolMsg).toContain('Call the tool again');
  });

  it('warns, so a model that never gets it right is visible', async () => {
    const { agent, warnings } = loopFor({ city: 42 }, { validateToolArguments: true });
    await agent.complete('go');
    const w = warnings.find((x) => x.code === 'tool_arguments_invalid');
    expect(w).toBeDefined();
    expect(w?.details).toMatchObject({ toolName: 'lookup', callId: 'c1' });
    expect((w?.details as { errors: string[] }).errors.length).toBeGreaterThan(0);
  });

  it('runs the tool when the arguments are valid', async () => {
    const { agent, ran, warnings } = loopFor({ city: 'Paris' }, { validateToolArguments: true });
    await agent.complete('go');
    expect(ran).toEqual([{ city: 'Paris' }]);
    expect(warnings.find((x) => x.code === 'tool_arguments_invalid')).toBeUndefined();
  });

  it('catches a MISSING required argument, not only a wrong type', async () => {
    const { agent, ran } = loopFor({}, { validateToolArguments: true });
    await agent.complete('go');
    expect(ran).toHaveLength(0);
  });

  it('leaves a builtin tool alone, which has no parameters to check', async () => {
    // `{ type: 'web_search' }` carries no schema at all; reading one off it would
    // throw on a tool that is perfectly well formed.
    const hooks = new HookBus();
    const builtin: AgentTool = {
      definition: { type: 'web_search' },
      execute: async () => 'results',
    };
    const call: ContentPart = { type: 'tool_call', id: 'c1', name: 'web_search', arguments: {} };
    let turn = 0;
    const client = {
      id: 'mock',
      provider: 'mock',
      model: 'mock-model',
      api: 'completions',
      mode: 'foreground',
      batchable: false,
      hooks,
      complete: async () => {
        turn += 1;
        const asking = turn === 1;
        return {
          id: 'r1',
          model: 'mock-model',
          content: asking ? [call] : [{ type: 'text', text: 'done' }],
          finishReason: asking ? 'tool_use' : 'stop',
          usage: USAGE,
          text: asking ? '' : 'done',
          toolCalls: asking ? [call] : [],
          thinking: null,
          media: [],
          latencyMs: 1,
          raw: null,
        };
      },
      stream: async function* () {},
      destroy() {},
    } as unknown as LLMClient;

    const agent = new AgentLoop({
      client,
      tools: [builtin],
      hooks,
      system: 's',
      validateToolArguments: true,
    } as never);
    expect((await agent.complete('go')).text).toBe('done');
  });
});
