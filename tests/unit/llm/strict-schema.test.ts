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

  it('now defaults strict on, as Responses does', () => {
    const fn = fnOf(ALL_REQUIRED);
    expect(fn.strict).toBe(true);
    // Strict also requires additionalProperties:false, so the schema must be
    // conformed on the way out or the provider rejects the very request we just
    // opted in to.
    expect((fn.parameters as Record<string, unknown>).additionalProperties).toBe(false);
  });

  it('leaves the schema untouched when strict is not sent', () => {
    const fn = fnOf(OPTIONAL_PROP);
    expect('strict' in fn).toBe(false);
    expect(fn.parameters).toEqual(OPTIONAL_PROP);
  });
});

describe('Anthropic — strict on tools', () => {
  const adapter = new AnthropicAdapter({ apiKey: 'k' });
  const toolOf = (schema: JsonSchema, strict?: boolean) =>
    (adapter.buildRequest(req({ tools: [fnTool(schema, strict)], maxTokens: 16 })).body as {
      tools: Array<Record<string, unknown>>;
    }).tools[0]!;

  it('defaults strict on — it is what suppresses undeclared tool calls', () => {
    expect(toolOf(ALL_REQUIRED).strict).toBe(true);
    // Optional properties are fine here, unlike OpenAI.
    expect(toolOf(OPTIONAL_PROP).strict).toBe(true);
  });

  it('omits strict when the schema uses a keyword Anthropic refuses', () => {
    const tool = toolOf(WITH_MAXIMUM);
    expect('strict' in tool).toBe(false);
    // …and the schema still goes out intact: the tool keeps working, it is only
    // the generation-time guarantee that is unavailable.
    expect(tool.input_schema).toEqual(WITH_MAXIMUM);
  });

  it('still honours an explicit strict', () => {
    expect('strict' in toolOf(ALL_REQUIRED, false)).toBe(false);
    expect(toolOf(WITH_MAXIMUM, true).strict).toBe(true);
  });

  it('refuses an open object under strict, as OpenAI does', () => {
    expect(strictSupport(FREE_FORM_NESTED, 'anthropic').ok).toBe(false);
    // …but unlike OpenAI it accepts an object that simply declares no properties.
    expect(strictSupport({ type: 'object' }, 'anthropic').ok).toBe(true);
  });
});

// ── the per-request cap, which no per-schema check can see ──────────────────
//
// Anthropic answers a request carrying more than 20 STRICT tools with
// "Too many strict tools (21)". Defaulting strict on therefore broke every caller
// with more than 20 tools — an ordinary number once MCP servers are attached, and a
// case that worked before strict was defaulted. Found by a benchmark declaring 60.

describe('Anthropic — the 20 strict-tool cap', () => {
  const adapter = new AnthropicAdapter({ apiKey: 'k' });
  const manyTools = (n: number, strict?: boolean) =>
    Array.from({ length: n }, (_, i) => ({ ...fnTool(ALL_REQUIRED, strict), name: `op_${i}` }));
  const strictCount = (tools: ReturnType<typeof manyTools>) =>
    (adapter.buildRequest(req({ tools, maxTokens: 16 })).body as { tools: Array<Record<string, unknown>> }).tools.filter(
      (t) => t.strict === true,
    ).length;

  it('keeps strict at the cap', () => {
    expect(strictCount(manyTools(20))).toBe(20);
  });

  it('drops strict entirely one tool past the cap, rather than sending a rejected request', () => {
    // All-or-nothing on purpose: filling to 20 would make the guarantee depend on array
    // order, and would change the tools block — and so the cache prefix — whenever a
    // tool is added anywhere.
    expect(strictCount(manyTools(21))).toBe(0);
  });

  it('counts only strict tools, so many non-strict tools cost nothing', () => {
    const tools = [...manyTools(20), ...manyTools(40, false).map((t, i) => ({ ...t, name: `off_${i}` }))];
    expect(strictCount(tools)).toBe(20);
  });

  it('never overrides an explicit strict, even past the cap', () => {
    // The caller asked for it; the 400 that follows is their decision to make.
    expect(strictCount(manyTools(21, true))).toBe(21);
  });
});
