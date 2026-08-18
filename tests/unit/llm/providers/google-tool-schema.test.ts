/** Gemini has two function-declaration schema fields, and we were using the wrong one.
 *
 *  `parameters` takes a narrow OpenAPI subset and rejects anything outside it outright:
 *
 *    Invalid JSON payload received. Unknown name "additionalProperties" at
 *    'tools[0].function_declarations[0].parameters'
 *
 *  `parametersJsonSchema` takes full JSON Schema. We passed callers' schemas into the
 *  first one, so any tool carrying `additionalProperties: false` — which OpenAI's strict
 *  mode requires — failed on every Gemini model. A consuming app had to delete it from
 *  its manifest to keep Google working, degrading its OpenAI schema in the process.
 *
 *  The keyword list below is measured against the live API, not taken from docs.
 */

import { describe, expect, it } from 'bun:test';
import { GoogleAdapter } from '../../../../src/llm/providers/google/generate';
import type { NormalizedRequest } from '../../../../src/llm/types/request';

const a = new GoogleAdapter({ apiKey: 'k' });

const withTool = (parameters: Record<string, unknown>): NormalizedRequest =>
  ({
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', name: 'get_weather', description: 'Weather', parameters }],
  }) as NormalizedRequest;

const decl = (req: NormalizedRequest): Record<string, unknown> => {
  const body = a.buildRequest(req).body as {
    tools: Array<{ functionDeclarations?: Array<Record<string, unknown>> }>;
  };
  return body.tools.find((t) => t.functionDeclarations)!.functionDeclarations![0]!;
};

/** Every keyword the live API rejects inside `parameters`. */
const REJECTED_BY_THE_NARROW_FIELD = {
  type: 'object',
  properties: {
    a: { type: 'string', examples: ['x'], readOnly: true },
    b: { const: 'fixed' },
    c: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 9, multipleOf: 2 },
    d: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    e: { $ref: '#/$defs/S' },
    f: { type: ['string', 'null'] },
  },
  $defs: { S: { type: 'string' } },
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  additionalProperties: false,
};

describe('Gemini function declarations', () => {
  it('sends the schema on parametersJsonSchema, not parameters', () => {
    const d = decl(withTool({ type: 'object', properties: { city: { type: 'string' } } }));
    expect(d.parametersJsonSchema).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
    });
    // The two fields are mutually exclusive — sending both is a 400.
    expect(d.parameters).toBeUndefined();
    expect(d.name).toBe('get_weather');
    expect(d.description).toBe('Weather');
  });

  it('passes additionalProperties:false through untouched', () => {
    // The exact property that broke the reporting app on every Gemini model, and that
    // OpenAI strict mode requires — so a schema cannot be written to satisfy both if we
    // strip it.
    const schema = {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    };
    expect(decl(withTool(schema)).parametersJsonSchema).toEqual(schema);
  });

  it('does not drop or rewrite anything the narrow field would have rejected', () => {
    // Verbatim: a sanitising fix would have quietly deleted every one of these, and could
    // not have expressed the `$ref` at all.
    expect(decl(withTool(REJECTED_BY_THE_NARROW_FIELD)).parametersJsonSchema).toEqual(
      REJECTED_BY_THE_NARROW_FIELD,
    );
  });

  it('never emits the narrow field, whatever the schema', () => {
    for (const schema of [
      { type: 'object' },
      { type: 'object', properties: {} },
      REJECTED_BY_THE_NARROW_FIELD,
    ]) {
      const body = JSON.stringify(a.buildRequest(withTool(schema)).body);
      expect(body).not.toContain('"parameters"');
      expect(body).toContain('"parametersJsonSchema"');
    }
  });

  it('leaves the builtin tools alongside it alone', () => {
    const req = {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } },
        { type: 'web_search' },
      ],
    } as unknown as NormalizedRequest;
    const body = a.buildRequest(req).body as { tools: Array<Record<string, unknown>> };
    expect(body.tools.some((t) => t.googleSearch)).toBe(true);
    expect(body.tools.some((t) => t.functionDeclarations)).toBe(true);
  });
});
