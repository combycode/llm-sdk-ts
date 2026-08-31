/** moderationGuardrail() unit tests — no network, no keys.
 *
 *  `moderationGuardrail()` is a FACTORY: it returns zero, one or two Guardrails
 *  and each one is a closure over the moderation options. Three things decide
 *  whether it works, and none of them is visible from the outside:
 *
 *    1. WHICH guardrails come back for a given options object, and what they are
 *       named (the names appear in the tripwire error and in hook payloads).
 *    2. WHAT TEXT each one submits — the input rail moderates the LAST user
 *       message only; the output rail moderates the response text. Moderating
 *       the wrong message is a silent security hole, not an error.
 *    3. WHEN it declines to call the API at all (wrong ctx kind, no user
 *       message, empty text) — every skipped call must be an explicit pass.
 *
 *  `moderationGuardrail` takes no `engine`, so `moderate()` resolves the default
 *  one from `coreRegistry`. Each test registers a stub engine there; the global
 *  `tests/setup.ts` beforeEach clears it again. */

import { describe, expect, it } from 'bun:test';
import { HookBus } from '../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../src/catalog/catalog';
import type {
  GuardrailCheckContext,
  GuardrailDecision,
} from '../../../src/agent/guardrail-types';
import type { EngineHandle } from '../../../src/helpers/engine';
import { coreRegistry } from '../../../src/helpers/engine';
import { moderationGuardrail } from '../../../src/helpers/moderation-guardrail';
import type { Message } from '../../../src/llm/types/messages';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { ModerationRawResponse } from '../../../src/helpers/moderate-types';

// ─── Wire fixtures ───────────────────────────────────────────────────────────

const CATEGORIES = {
  harassment: false,
  'harassment/threatening': false,
  hate: false,
  'hate/threatening': false,
  illicit: false,
  'illicit/violent': false,
  'self-harm': false,
  'self-harm/intent': false,
  'self-harm/instructions': false,
  sexual: false,
  'sexual/minors': false,
  violence: false,
  'violence/graphic': false,
};
const SCORES = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0.001]));

const one = (flagged: boolean) => ({
  flagged,
  categories: { ...CATEGORIES, harassment: flagged },
  category_scores: { ...SCORES, harassment: flagged ? 0.99 : 0.001 },
});

const wire = (flagged: boolean): ModerationRawResponse => ({
  id: 'modr-guardrail',
  model: 'omni-moderation-latest',
  results: [one(flagged)],
});

// ─── Stub engine registered as the default ───────────────────────────────────

interface Rig {
  bodies: Array<Record<string, unknown>>;
  headers: Array<Record<string, string>>;
}

/** Register a stub default engine whose moderations endpoint answers `flagged`. */
function rig(flagged: boolean | ((input: unknown) => boolean)): Rig {
  const bodies: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string>> = [];
  const engine = {
    apiKeys: { openai: 'engine-key' },
    catalog: new ModelCatalog(),
    hooks: new HookBus(),
    destroy: () => {},
    fetch: async (req: { body?: Record<string, unknown>; headers?: Record<string, string> }) => {
      bodies.push(req.body ?? {});
      headers.push(req.headers ?? {});
      const decide = typeof flagged === 'function' ? flagged(req.body?.input) : flagged;
      return { status: 200, headers: {}, body: wire(decide) };
    },
  } as unknown as EngineHandle;
  coreRegistry.set(engine, { replace: true });
  return { bodies, headers };
}

// ─── Context builders ────────────────────────────────────────────────────────

const trace = { sessionId: 's', requestId: 'r' };

const inputCtx = (messages: Message[]): GuardrailCheckContext =>
  ({ kind: 'input', trace, step: 0, messages }) as GuardrailCheckContext;

const outputCtx = (text: string): GuardrailCheckContext =>
  ({
    kind: 'output',
    trace,
    step: 0,
    response: { text } as CompletionResponse,
  }) as GuardrailCheckContext;

const TRIPPED = (reason: string): GuardrailDecision => ({
  pass: false,
  tripwire: true,
  reason,
  severity: 'high',
});

// ─── Which rails come back ───────────────────────────────────────────────────

describe('moderationGuardrail() -- what the factory returns', () => {
  it('defaults to input-only', async () => {
    const rails = moderationGuardrail();
    expect(rails).toHaveLength(1);
    expect(rails[0].name).toBe('moderation-input');
    expect(rails[0].kind).toBe('input');
  });

  it('adds the output rail only when asked', async () => {
    const rails = moderationGuardrail({ output: true });
    expect(rails.map((r) => [r.name, r.kind])).toEqual([
      ['moderation-input', 'input'],
      ['moderation-output', 'output'],
    ]);
  });

  it('input:false drops the input rail', async () => {
    const rails = moderationGuardrail({ input: false, output: true });
    expect(rails).toHaveLength(1);
    expect(rails[0].kind).toBe('output');
  });

  it('input:false with no output gives an empty list rather than throwing', async () => {
    // Turning everything off is a legal (if pointless) configuration; it must
    // not silently re-enable the input rail.
    expect(moderationGuardrail({ input: false })).toEqual([]);
  });

  it('a custom name prefix is used verbatim for input and suffixed for output', async () => {
    // Note the asymmetry — it is deliberate and load-bearing for anyone
    // matching on guardrail names in hooks.
    const rails = moderationGuardrail({ name: 'policy', output: true });
    expect(rails.map((r) => r.name)).toEqual(['policy', 'policy-output']);
  });
});

// ─── Input rail: which text it moderates ─────────────────────────────────────

describe('moderationGuardrail() -- input rail text selection', () => {
  it('moderates the LAST user message, not the first', async () => {
    // The rail exists to catch what the user just said. Submitting an earlier
    // turn would pass every jailbreak that arrives after turn one.
    const r = rig(false);
    const [rail] = moderationGuardrail();
    await rail.check(
      inputCtx([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'latest' },
      ]),
    );
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].input).toBe('latest');
  });

  it('ignores assistant and system messages when picking the user turn', async () => {
    const r = rig(false);
    const [rail] = moderationGuardrail();
    await rail.check(
      inputCtx([
        { role: 'user', content: 'the only user turn' },
        { role: 'assistant', content: 'assistant text' },
        { role: 'system', content: 'system text' },
      ]),
    );
    expect(r.bodies[0].input).toBe('the only user turn');
  });

  it('flattens a multi-part user message down to its text', async () => {
    const r = rig(false);
    const [rail] = moderationGuardrail();
    await rail.check(
      inputCtx([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at ' },
            { type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'AA==' } },
            { type: 'text', text: 'this' },
          ],
        },
      ]),
    );
    expect(r.bodies[0].input).toBe('look at this');
  });
});

// ─── Input rail: when it declines to call ────────────────────────────────────

describe('moderationGuardrail() -- input rail short circuits', () => {
  it('passes without calling when there is no user message at all', async () => {
    const r = rig(true); // would trip if it ever asked
    const [rail] = moderationGuardrail();
    expect(await rail.check(inputCtx([{ role: 'assistant', content: 'hi' }]))).toEqual({
      pass: true,
    });
    expect(r.bodies).toHaveLength(0);
  });

  it('passes without calling on an empty message list', async () => {
    const r = rig(true);
    const [rail] = moderationGuardrail();
    expect(await rail.check(inputCtx([]))).toEqual({ pass: true });
    expect(r.bodies).toHaveLength(0);
  });

  it('passes without calling when the user turn has no text', async () => {
    // An image-only turn has nothing this endpoint can read; sending '' would
    // burn a request to moderate the empty string.
    const r = rig(true);
    const [rail] = moderationGuardrail();
    const decision = await rail.check(
      inputCtx([
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', mimeType: 'image/png', data: 'AA==' } },
          ],
        },
      ]),
    );
    expect(decision).toEqual({ pass: true });
    expect(r.bodies).toHaveLength(0);
  });

  it('passes without calling when handed an output context by mistake', async () => {
    // Defensive, but the rail is registered by kind: if a caller ever runs an
    // input rail on an output context it must abstain, not read `ctx.messages`
    // off an object that has none.
    const r = rig(true);
    const [rail] = moderationGuardrail();
    expect(await rail.check(outputCtx('assistant said something'))).toEqual({ pass: true });
    expect(r.bodies).toHaveLength(0);
  });
});

// ─── Input rail: the decision ────────────────────────────────────────────────

describe('moderationGuardrail() -- input rail decision', () => {
  it('passes clean input', async () => {
    rig(false);
    const [rail] = moderationGuardrail();
    expect(await rail.check(inputCtx([{ role: 'user', content: 'hello' }]))).toEqual({
      pass: true,
    });
  });

  it('trips with tripwire + high severity on flagged input', async () => {
    rig(true);
    const [rail] = moderationGuardrail();
    const decision = await rail.check(inputCtx([{ role: 'user', content: 'awful' }]));
    expect(decision).toEqual(TRIPPED('Input flagged by moderation'));
  });

  it('the verdict follows the last user turn, not any earlier one', async () => {
    // Same conversation, opposite outcomes: only the text actually submitted
    // can decide.
    rig((input) => input === 'bad');
    const [rail] = moderationGuardrail();
    const clean = await rail.check(
      inputCtx([
        { role: 'user', content: 'bad' },
        { role: 'user', content: 'fine' },
      ]),
    );
    expect(clean).toEqual({ pass: true });

    const tripped = await rail.check(
      inputCtx([
        { role: 'user', content: 'fine' },
        { role: 'user', content: 'bad' },
      ]),
    );
    expect(tripped).toEqual(TRIPPED('Input flagged by moderation'));
  });
});

// ─── Output rail ─────────────────────────────────────────────────────────────

describe('moderationGuardrail() -- output rail', () => {
  const outputRail = (opts = {}) => moderationGuardrail({ ...opts, input: false, output: true })[0];

  it('moderates the response text', async () => {
    const r = rig(false);
    await outputRail().check(outputCtx('the assistant answer'));
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].input).toBe('the assistant answer');
  });

  it('passes clean output', async () => {
    rig(false);
    expect(await outputRail().check(outputCtx('fine'))).toEqual({ pass: true });
  });

  it('trips with the OUTPUT reason, not the input one', async () => {
    // The two reasons are how a reader of the halt tells which side tripped.
    rig(true);
    expect(await outputRail().check(outputCtx('awful'))).toEqual(
      TRIPPED('Output flagged by moderation'),
    );
  });

  it('passes without calling when the response has no text', async () => {
    const r = rig(true);
    expect(await outputRail().check(outputCtx(''))).toEqual({ pass: true });
    expect(r.bodies).toHaveLength(0);
  });

  it('passes without calling when handed an input context by mistake', async () => {
    const r = rig(true);
    expect(await outputRail().check(inputCtx([{ role: 'user', content: 'hi' }]))).toEqual({
      pass: true,
    });
    expect(r.bodies).toHaveLength(0);
  });
});

// ─── Options reach the moderate() call ───────────────────────────────────────

describe('moderationGuardrail() -- options plumbing', () => {
  it('forwards an explicit apiKey to the moderation request', async () => {
    const r = rig(false);
    const [rail] = moderationGuardrail({ apiKey: 'caller-key' });
    await rail.check(inputCtx([{ role: 'user', content: 'hi' }]));
    expect(r.headers[0].authorization).toBe('Bearer caller-key');
  });

  it('falls back to the engine key when none is given', async () => {
    const r = rig(false);
    const [rail] = moderationGuardrail();
    await rail.check(inputCtx([{ role: 'user', content: 'hi' }]));
    expect(r.headers[0].authorization).toBe('Bearer engine-key');
  });

  it('forwards a custom moderation model', async () => {
    const r = rig(false);
    const [rail] = moderationGuardrail({ model: 'openai/omni-moderation-2024-09-26' });
    await rail.check(inputCtx([{ role: 'user', content: 'hi' }]));
    expect(r.bodies[0].model).toBe('omni-moderation-2024-09-26');
  });

  it('uses the moderate() default model when none is given', async () => {
    const r = rig(false);
    const [rail] = moderationGuardrail();
    await rail.check(inputCtx([{ role: 'user', content: 'hi' }]));
    expect(r.bodies[0].model).toBe('omni-moderation-latest');
  });

  it('forwards the same options to the output rail', async () => {
    const r = rig(false);
    const rails = moderationGuardrail({
      apiKey: 'caller-key',
      model: 'openai/omni-moderation-2024-09-26',
      output: true,
    });
    await rails[1].check(outputCtx('text'));
    expect(r.headers[0].authorization).toBe('Bearer caller-key');
    expect(r.bodies[0].model).toBe('omni-moderation-2024-09-26');
  });
});
