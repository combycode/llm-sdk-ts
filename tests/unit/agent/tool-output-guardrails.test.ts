/** A tool's output is inspected before anything keeps it.
 *
 *  The distinction that shapes this: by the time an output guardrail runs, the
 *  tool has ALREADY RUN. Halting the run would be the wrong lever — the output
 *  exists, and what is left to control is what it touches. So a trip withholds
 *  the output and a placeholder takes its place everywhere it would have been
 *  kept: the result the model reads, the conversation, any checkpoint written
 *  from it, the `onToolCallComplete` hook a logger listens on, and the report
 *  that `customDataExtractor` writes into.
 *
 *  Both halves fail closed. A guardrail that throws counts as having tripped —
 *  a checker that crashed has approved nothing, and the run that matters is the
 *  one where it crashed on the input it would have caught. A message formatter
 *  that throws falls back to the default sentence, never to the output it was
 *  deciding about.
 */

import { describe, expect, it } from 'bun:test';
import { AgentLoop } from '../../../src/agent/loop';
import { HookBus } from '../../../src/bus/hook-bus';
import { TOOL_OUTPUT_WITHHELD } from '../../../src/agent/guardrail-types';
import type { ToolOutputGuardrail } from '../../../src/agent/guardrail-types';
import type { AgentTool } from '../../../src/agent/types';
import type { LLMClient } from '../../../src/llm/client';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ContentPart, ToolCallPart } from '../../../src/llm/types/messages';

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function toolCall(id: string, name: string, args: Record<string, unknown> = {}) {
  const tc: ContentPart = { type: 'tool_call', id, name, arguments: args };
  return { content: [tc], finishReason: 'tool_use', toolCalls: [tc as ToolCallPart], usage: USAGE };
}

const text = (t: string) => ({
  content: [{ type: 'text' as const, text: t }],
  finishReason: 'stop',
  toolCalls: [],
  usage: USAGE,
});

function mockClient(responses: Array<Partial<CompletionResponse> & { content: ContentPart[] }>) {
  const queue = [...responses];
  const seen: unknown[] = [];
  const client = {
    id: 'mock',
    provider: 'mock',
    model: 'mock-model',
    hooks: new HookBus(),
    api: 'completions',
    mode: 'foreground',
    batchable: false,
    complete: async (input: unknown) => {
      seen.push(input);
      const next = queue.shift();
      if (!next) throw new Error('mock client exhausted');
      return {
        id: 'r',
        model: 'mock-model',
        media: [],
        text: '',
        thinking: null,
        latencyMs: 1,
        raw: null,
        ...next,
      } as CompletionResponse;
    },
  } as unknown as LLMClient;
  return { client, seen };
}

const SECRET = 'card 4111 1111 1111 1111';

const leakyTool = (result = SECRET): AgentTool => ({
  definition: { name: 'lookup', description: 'Look something up', parameters: {} },
  execute: async () => result,
});

const blockCards: ToolOutputGuardrail = {
  name: 'no-card-numbers',
  check: (ctx) => (ctx.result.includes('4111') ? { pass: false, reason: 'card number' } : { pass: true }),
};

/** Run one tool call and hand back everything that could have kept the output. */
async function runWith(config: Record<string, unknown>, tool = leakyTool()) {
  const { client, seen } = mockClient([toolCall('c1', 'lookup'), text('done')]);
  const hooks = new HookBus();
  const hookResults: unknown[] = [];
  const warnings: Array<{ code?: string; message?: string }> = [];
  hooks.on('onToolCallComplete', (ctx) => {
    hookResults.push(ctx.result);
  });
  hooks.on('onWarning', (w) => {
    warnings.push({ code: w.code, message: w.message });
  });

  const loop = new AgentLoop({ client, tools: [tool], hooks, ...config });
  const res = await loop.complete('go');
  // What the model was shown on the follow-up turn.
  const followUp = JSON.stringify(seen[1] ?? '');
  return { res, hookResults, warnings, followUp, loop };
}

describe('with no output guardrail nothing changes', () => {
  it('passes the tool output through', async () => {
    const { followUp, hookResults } = await runWith({});
    expect(followUp).toContain('4111');
    expect(hookResults[0]).toBe(SECRET);
  });
});

describe('a tripped guardrail withholds the output', () => {
  it('replaces what the model is shown', async () => {
    const { followUp } = await runWith({ toolOutputGuardrails: [blockCards] });
    expect(followUp).not.toContain('4111');
    expect(followUp).toContain(TOOL_OUTPUT_WITHHELD);
  });

  it('replaces it in the hook a logger would be listening on', async () => {
    // The most likely place for the leak: a subscriber writing this to disk.
    const { hookResults } = await runWith({ toolOutputGuardrails: [blockCards] });
    expect(hookResults[0]).toBe(TOOL_OUTPUT_WITHHELD);
  });

  it('says so once, with the guardrail and the tool named', async () => {
    const { warnings } = await runWith({ toolOutputGuardrails: [blockCards] });
    const withheld = warnings.filter((w) => w.code === 'tool_output_withheld');
    expect(withheld.length).toBe(1);
    expect(withheld[0]?.message).toContain('no-card-numbers');
    expect(withheld[0]?.message).toContain('lookup');
  });

  it('does not run the customDataExtractor, which writes into the report', async () => {
    // The side door: the extractor's product lands in the report, which is the
    // kind of place the guardrail was keeping the output out of.
    let sawResult: unknown;
    const tool: AgentTool = {
      ...leakyTool(),
      customDataExtractor: (result) => {
        sawResult = result;
        return { seen: true };
      },
    };
    await runWith({ toolOutputGuardrails: [blockCards] }, tool);
    expect(sawResult).toBeUndefined();
  });

  it('leaves an output it has no objection to alone', async () => {
    const { followUp } = await runWith(
      { toolOutputGuardrails: [blockCards] },
      leakyTool('nothing sensitive here'),
    );
    expect(followUp).toContain('nothing sensitive here');
  });
});

describe('the replacement text', () => {
  it('defaults to a data-free sentence', async () => {
    const { followUp } = await runWith({ toolOutputGuardrails: [blockCards] });
    expect(followUp).toContain(TOOL_OUTPUT_WITHHELD);
  });

  it('takes the guardrail’s own wording when it gives one', async () => {
    const withWording: ToolOutputGuardrail = {
      name: 'g',
      check: () => ({ pass: false, reason: 'card number', replaceWith: 'Redacted by policy.' }),
    };
    const { followUp } = await runWith({ toolOutputGuardrails: [withWording] });
    expect(followUp).toContain('Redacted by policy.');
  });

  it('takes the loop’s configured message', async () => {
    const { followUp } = await runWith({
      toolOutputGuardrails: [blockCards],
      toolOutputBlockedMessage: 'Ask your administrator.',
    });
    expect(followUp).toContain('Ask your administrator.');
  });

  it('lets a formatter name the guardrail and the tool', async () => {
    const { followUp } = await runWith({
      toolOutputGuardrails: [blockCards],
      toolOutputBlockedMessage: (args: { guardrailName: string; toolName: string }) =>
        `${args.toolName} blocked by ${args.guardrailName}`,
    });
    expect(followUp).toContain('lookup blocked by no-card-numbers');
  });

  it('falls back to the default when the formatter throws', async () => {
    // Fails closed: the default sentence, never the output it was deciding about.
    const { followUp } = await runWith({
      toolOutputGuardrails: [blockCards],
      toolOutputBlockedMessage: () => {
        throw new Error('formatter is broken');
      },
    });
    expect(followUp).toContain(TOOL_OUTPUT_WITHHELD);
    expect(followUp).not.toContain('4111');
  });

  it('falls back when the formatter returns nothing usable', async () => {
    const { followUp } = await runWith({
      toolOutputGuardrails: [blockCards],
      toolOutputBlockedMessage: () => '',
    });
    expect(followUp).toContain(TOOL_OUTPUT_WITHHELD);
  });
});

describe('a guardrail that throws counts as having tripped', () => {
  it('withholds rather than passing the output through', async () => {
    // A checker that crashed has approved nothing — and the run where it
    // crashed is exactly the run where it might have caught something.
    const broken: ToolOutputGuardrail = {
      name: 'broken',
      check: () => {
        throw new Error('checker exploded');
      },
    };
    const { followUp, warnings } = await runWith({ toolOutputGuardrails: [broken] });
    expect(followUp).not.toContain('4111');
    expect(followUp).toContain(TOOL_OUTPUT_WITHHELD);
    expect(warnings.some((w) => w.message?.includes('checker exploded'))).toBe(true);
  });
});

describe('guardrails a tool brought with it', () => {
  it('run alongside the loop’s own', async () => {
    // How a per-server rule reaches the loop: `connectMcp` attaches these to
    // the tools it returns, so the rule holds wherever they are used.
    const tool: AgentTool = { ...leakyTool(), outputGuardrails: [blockCards] };
    const { followUp } = await runWith({}, tool);
    expect(followUp).not.toContain('4111');
  });

  it('cannot be talked out of by a later one', async () => {
    // The first to withhold decides; a permissive guardrail behind it does not
    // reinstate the output.
    const allowAll: ToolOutputGuardrail = { name: 'allow', check: () => ({ pass: true }) };
    const tool: AgentTool = { ...leakyTool(), outputGuardrails: [allowAll] };
    const { followUp } = await runWith({ toolOutputGuardrails: [blockCards] }, tool);
    expect(followUp).not.toContain('4111');
  });
});

describe('a tool that answered with content parts', () => {
  // The parts are serialised FOR THE CHECKER, so a rule written against text
  // still applies to a tool that returns media — and a trip withholds the media
  // along with everything else.
  const shot = (): AgentTool => ({
    definition: { name: 'lookup', description: 'Take a picture', parameters: {} },
    execute: async () => [
      { type: 'text' as const, text: SECRET },
      {
        type: 'image' as const,
        source: { type: 'base64' as const, mimeType: 'image/png', data: 'iVBO' },
      },
    ],
  });

  it('is still inspected, as text', async () => {
    let saw = '';
    const watch: ToolOutputGuardrail = {
      name: 'watch',
      check: (ctx) => {
        saw = ctx.result;
        return { pass: true };
      },
    };
    await runWith({ toolOutputGuardrails: [watch] }, shot());
    expect(saw).toContain('4111');
    expect(saw).toContain('image');
  });

  it('withholds the media too when it trips', async () => {
    const { followUp } = await runWith({ toolOutputGuardrails: [blockCards] }, shot());
    expect(followUp).not.toContain('4111');
    expect(followUp).not.toContain('iVBO');
    expect(followUp).toContain(TOOL_OUTPUT_WITHHELD);
  });
});
