/** Strict mode is defaulted ON, but only where the provider can honour it.
 *
 *  The library forced `strict: true` on every OpenAI function tool while sending the
 *  schema as written. OpenAI's strict mode requires EVERY property to be listed in
 *  `required`, at every nesting level, and rejects the request outright when one is
 *  not — `400: 'required' is required to be supplied`. So any tool with an optional
 *  parameter was unusable. Most real MCP tools have one; the DeepWiki server used
 *  throughout the example corpus happens to declare everything required, which is
 *  why nothing caught it.
 *
 *  The two providers constrain DIFFERENT things, and the constraints are disjoint —
 *  each of the shapes below was accepted by one provider and rejected by the other,
 *  measured against the live APIs on 2026-08-16 (claude-haiku-4.5 / gpt-5.4-nano):
 *
 *    optional property           openai REJECT   anthropic ok
 *    nested obj, no inner req.   openai REJECT   anthropic ok
 *    `maximum` / `multipleOf`    openai ok       anthropic REJECT
 *
 *  Hence a per-dialect check rather than one shared notion of "strict-safe".
 */

import { describe, expect, it } from 'bun:test';
import { strictSupport } from '../../../src/llm/types/schema-utils';
import { AnthropicAdapter } from '../../../src/llm/providers/anthropic/messages';
import { OpenAIAdapter } from '../../../src/llm/providers/openai/completions';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';
import type { JsonSchema } from '../../../src/llm/types/tools';
import type { NormalizedRequest } from '../../../src/llm/types/request';

// ── the shapes, exactly as measured ─────────────────────────────────────────
const ALL_REQUIRED: JsonSchema = {
  type: 'object',
  properties: { q: { type: 'string' } },
  required: ['q'],
};
const OPTIONAL_PROP: JsonSchema = {
  type: 'object',
  properties: { q: { type: 'string' }, page: { type: 'number' } },
  required: ['q'],
};
const NESTED_NO_INNER_REQUIRED: JsonSchema = {
  type: 'object',
  properties: {
    filter: { type: 'object', properties: { since: { type: 'string' } } },
  },
  required: ['filter'],
};
const WITH_MAXIMUM: JsonSchema = {
  type: 'object',
  properties: { n: { type: 'number', maximum: 10 } },
  required: ['n'],
};
/** The shape a generic tool router needs: `input` must accept any tool's arguments. */
const FREE_FORM_NESTED: JsonSchema = {
  type: 'object',
  properties: {
    calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, input: { type: 'object', additionalProperties: true } },
        required: ['name', 'input'],
      },
    },
  },
  required: ['calls'],
};

const req = (over: Partial<NormalizedRequest>): NormalizedRequest =>
  ({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...over }) as NormalizedRequest;

const fnTool = (parameters: JsonSchema, strict?: boolean) => ({
  type: 'function' as const,
  name: 't',
  description: 'd',
  parameters,
  ...(strict === undefined ? {} : { strict }),
});

// ── the predicate ───────────────────────────────────────────────────────────

describe('strictSupport — openai dialect', () => {
  it('accepts a schema where every property is required', () => {
    expect(strictSupport(ALL_REQUIRED, 'openai').ok).toBe(true);
  });

  it('rejects an optional property, naming it', () => {
    const r = strictSupport(OPTIONAL_PROP, 'openai');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('page');
  });

  it('rejects a nested object whose own properties are not required', () => {
    const r = strictSupport(NESTED_NO_INNER_REQUIRED, 'openai');
    expect(r.ok).toBe(false);
    // The reason has to point at the nesting level that is actually wrong, or it
    // sends the reader to the wrong part of their schema.
    expect(r.reason).toContain('filter');
    expect(r.reason).toContain('since');
  });

  it('descends into array items and anyOf branches', () => {
    expect(
      strictSupport(
        { type: 'object', properties: { xs: { type: 'array', items: OPTIONAL_PROP } }, required: ['xs'] },
        'openai',
      ).ok,
    ).toBe(false);
    expect(
      strictSupport({ type: 'object', properties: { x: { anyOf: [OPTIONAL_PROP] } }, required: ['x'] }, 'openai').ok,
    ).toBe(false);
  });

  it('does not care about validation keywords that only Anthropic refuses', () => {
    expect(strictSupport(WITH_MAXIMUM, 'openai').ok).toBe(true);
  });

  // A generic router tool — `call_tools([{ name, input }])` — needs `input` to accept
  // any shape, and under strict it simply cannot. Found by an experiment building
  // exactly that: the check said yes and the API said 400.
  it('rejects a free-form object, which is not expressible under strict', () => {
    const r = strictSupport(FREE_FORM_NESTED, 'openai');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('input');
  });

  it('rejects an explicit additionalProperties: true', () => {
    const r = strictSupport(
      { type: 'object', properties: { k: { type: 'string' } }, required: ['k'], additionalProperties: true },
      'openai',
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('additionalProperties');
  });

  // The case that must NOT be caught by the rule above: a tool that takes no
  // arguments. `properties: {}` is accepted live; only a MISSING `properties` is not.
  it('accepts a no-argument tool, whose properties are empty but present', () => {
    expect(strictSupport({ type: 'object', properties: {} }, 'openai').ok).toBe(true);
  });
});

describe('strictSupport — anthropic dialect', () => {
  it('accepts optional properties, which OpenAI refuses', () => {
    expect(strictSupport(OPTIONAL_PROP, 'anthropic').ok).toBe(true);
    expect(strictSupport(NESTED_NO_INNER_REQUIRED, 'anthropic').ok).toBe(true);
  });

  it('rejects the measured unsupported keywords', () => {
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'multipleOf', 'maxItems']) {
      const schema: JsonSchema = { type: 'object', properties: { n: { type: 'number', [key]: 1 } }, required: ['n'] };
      const r = strictSupport(schema, 'anthropic');
      expect(r.ok).toBe(false);
      expect(r.reason).toContain(key);
    }
  });

  it('accepts the neighbouring keywords that ARE supported', () => {
    // The denylist is asymmetric — asserting the accepted side keeps a future
    // over-broad "just deny all numeric keywords" from passing quietly.
    for (const key of ['minItems', 'maxLength', 'minLength']) {
      const schema: JsonSchema = { type: 'object', properties: { n: { type: 'string', [key]: 1 } }, required: ['n'] };
      expect(strictSupport(schema, 'anthropic').ok).toBe(true);
    }
  });
});

// ── what actually goes on the wire ──────────────────────────────────────────

describe('OpenAI Responses — strict on tools', () => {
  const adapter = new OpenAIResponsesAdapter({ apiKey: 'k' });
  const toolsOf = (schema: JsonSchema, strict?: boolean) =>
    (adapter.buildRequest(req({ tools: [fnTool(schema, strict)] })).body as { tools: Array<Record<string, unknown>> })
      .tools[0]!;

  it('keeps strict on when the schema qualifies', () => {
    expect(toolsOf(ALL_REQUIRED).strict).toBe(true);
  });

  // The regression: this was hardcoded `true` and the API rejected the request.
  it('drops strict rather than sending a request the API will reject', () => {
    expect(toolsOf(OPTIONAL_PROP).strict).toBe(false);
    expect(toolsOf(NESTED_NO_INNER_REQUIRED).strict).toBe(false);
  });

  it('still honours an explicit strict, in both directions', () => {
    expect(toolsOf(OPTIONAL_PROP, true).strict).toBe(true);
    expect(toolsOf(ALL_REQUIRED, false).strict).toBe(false);
  });

  it('applies the same rule to structured output', () => {
    const body = (s: JsonSchema) => adapter.buildRequest(req({ structured: { schema: s } })).body as {
      text: { format: { strict: boolean } };
    };
    expect(body(ALL_REQUIRED).text.format.strict).toBe(true);
    expect(body(OPTIONAL_PROP).text.format.strict).toBe(false);
  });
});

describe('OpenAI Chat Completions — strict on tools', () => {
  const adapter = new OpenAIAdapter({ apiKey: 'k' });
  const fnOf = (schema: JsonSchema, strict?: boolean) =>
    (
      adapter.buildRequest(req({ tools: [fnTool(schema, strict)] })).body as {
        tools: Array<{ function: Record<string, unknown> }>;
      }
    ).tools[0]!.function;

  // Opt-in on this API, as it always was. Briefly defaulted on for consistency with
  // Responses, then reverted: strict changes nothing measurable about argument quality
  // (40/40 conformant either way, both providers) and only adds exposure.
  it('does not ask for strict unless the caller does', () => {
    const fn = fnOf(ALL_REQUIRED);
    expect('strict' in fn).toBe(false);
    expect(fn.parameters).toEqual(ALL_REQUIRED);
  });

  it('conforms the schema when strict IS asked for', () => {
    const fn = fnOf(ALL_REQUIRED, true);
    expect(fn.strict).toBe(true);
    // Strict without `additionalProperties: false` is rejected, so opting in has to
    // conform the schema or it fails the very request it opted into.
    expect((fn.parameters as Record<string, unknown>).additionalProperties).toBe(false);
  });
});

describe('Anthropic — strict on tools', () => {
  const adapter = new AnthropicAdapter({ apiKey: 'k' });
  const toolOf = (schema: JsonSchema, strict?: boolean) =>
    (adapter.buildRequest(req({ tools: [fnTool(schema, strict)], maxTokens: 16 })).body as {
      tools: Array<Record<string, unknown>>;
    }).tools[0]!;

  // Strict is OPT-IN here. It was briefly defaulted on — it is the only thing that
  // stops this model calling a tool that was never declared (10/10 -> 0/10) — but that
  // benefit only applies when something puts an undeclared tool in front of the model,
  // and the cost turned out to be limits no per-schema check can predict. See the
  // aggregate-limits block below.
  it('does not ask for strict unless the caller does', () => {
    expect('strict' in toolOf(ALL_REQUIRED)).toBe(false);
    expect('strict' in toolOf(OPTIONAL_PROP)).toBe(false);
    // The schema goes out exactly as written when strict is not requested.
    expect(toolOf(WITH_MAXIMUM).input_schema).toEqual(WITH_MAXIMUM);
  });

  it('honours an explicit strict, and conforms the schema when it does', () => {
    expect(toolOf(ALL_REQUIRED, true).strict).toBe(true);
    expect((toolOf(ALL_REQUIRED, true).input_schema as Record<string, unknown>).additionalProperties).toBe(false);
    expect('strict' in toolOf(ALL_REQUIRED, false)).toBe(false);
  });

  it('refuses an open object under strict, as OpenAI does', () => {
    expect(strictSupport(FREE_FORM_NESTED, 'anthropic').ok).toBe(false);
    // …but unlike OpenAI it accepts an object that simply declares no properties.
    expect(strictSupport({ type: 'object' }, 'anthropic').ok).toBe(true);
  });
});

// ── why strict cannot be defaulted on for Anthropic ─────────────────────────
//
// Three limits, measured live 2026-08-16, none of which a per-SCHEMA predicate can
// see, because two are aggregates over the whole request and the third has no
// published formula at all:
//
//   20 strict tools   21 answers "Too many strict tools (21)"
//   24 optional params summed across all strict schemas, nested ones included;
//                      25 answers "too many optional parameters (25) ... limit: 24"
//   complexity        those same 24 optional params in ONE tool instead of four
//                      answers "Schema is too complex for compilation"
//
// Non-strict tools count toward none of them. Twelve ordinary tools with five optional
// parameters each already exceed the second, so defaulting strict on broke realistic
// tool sets — found when a benchmark of 12 such tools stopped working. The first two
// could be counted; the third cannot be predicted, which is what makes opt-in the only
// honest default here rather than merely the safer one.

describe('Anthropic — strict stays opt-in because its limits are unpredictable', () => {
  const adapter = new AnthropicAdapter({ apiKey: 'k' });
  const manyTools = (n: number, strict?: boolean) =>
    Array.from({ length: n }, (_, i) => ({ ...fnTool(ALL_REQUIRED, strict), name: `op_${i}` }));
  const strictCount = (tools: ReturnType<typeof manyTools>) =>
    (adapter.buildRequest(req({ tools, maxTokens: 16 })).body as { tools: Array<Record<string, unknown>> }).tools.filter(
      (t) => t.strict === true,
    ).length;

  it('asks for strict on no tool by default, at any tool count', () => {
    expect(strictCount(manyTools(1))).toBe(0);
    expect(strictCount(manyTools(60))).toBe(0);
  });

  it('sends exactly the strict tools the caller asked for, and no more', () => {
    // Past the provider's limits this is a 400 — about a schema the caller chose,
    // which is the difference between their decision and our default.
    expect(strictCount(manyTools(21, true))).toBe(21);
    expect(strictCount([...manyTools(5, true), ...manyTools(40, false).map((t, i) => ({ ...t, name: `off_${i}` }))])).toBe(5);
  });
});
