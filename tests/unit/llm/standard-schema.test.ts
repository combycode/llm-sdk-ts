/** Standard Schema (`~standard`) accepted wherever a JSON Schema is.
 *
 *  A caller who already has a Zod/Valibot/ArkType schema had to hand-write a
 *  second JSON Schema saying the same thing and then keep the two in step. Two
 *  descriptions of one shape drift, and the one the provider sees is the one
 *  nobody reads.
 *
 *  The schemas below are hand-rolled, with no schema library installed. That is
 *  the point of the feature and so it is the point of the test: `~standard` is a
 *  protocol, the types are structural, and this library adds no dependency to
 *  speak it. A test that imported Zod would not be checking that.
 *
 *  Two things a Standard Schema can do that a JSON Schema cannot, and both are
 *  asserted below rather than described:
 *
 *   - **Refinements.** `min 2 items`, `end_date after start_date`, a branded id —
 *     JSON Schema has no vocabulary for most of it, so the provider never
 *     enforced it. Checked here or nowhere.
 *   - **Transformation.** `validate` may return a value it was not given. The
 *     VALIDATED value is what a caller receives; handing back the parsed one
 *     would return something that looks right and skipped the schema's work.
 */

import { describe, expect, it } from 'bun:test';
import { createEngine } from '../../../src/index';
import {
  isStandardSchema,
  isStandardSchemaWithJson,
  toJsonSchema,
  validateStandardSchema,
} from '../../../src/llm/types/standard-schema';
import type {
  StandardSchema,
  StandardSchemaIssue,
  StandardSchemaWithJson,
} from '../../../src/llm/types/standard-schema';

// ─── a schema library, in twenty lines ──────────────────────────────────────

const JSON_SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' } },
  required: ['city'],
} as const;

/** Validates, converts, and (optionally) transforms — the full protocol. */
function schema(options: {
  vendor?: string;
  json?: Record<string, unknown>;
  outputJson?: Record<string, unknown>;
  validate?: (value: unknown) => { value: unknown } | { issues: StandardSchemaIssue[] };
}): StandardSchemaWithJson {
  const calls: Array<{ target?: string }> = [];
  const s = {
    '~standard': {
      version: 1 as const,
      vendor: options.vendor ?? 'hand-rolled',
      validate: options.validate ?? ((value: unknown) => ({ value })),
      jsonSchema: {
        input: (o?: { target?: string }) => {
          calls.push(o ?? {});
          return options.json ?? { ...JSON_SCHEMA };
        },
        output: () => options.outputJson ?? { type: 'object', properties: { ok: {} } },
      },
    },
  };
  (s as unknown as { calls: typeof calls }).calls = calls;
  return s as unknown as StandardSchemaWithJson;
}

/** Marker and validator, no conversion — the shape of a schema library that has
 *  not adopted the JSON Schema half of the spec yet. */
function validateOnly(vendor = 'old-library'): StandardSchema {
  return {
    '~standard': {
      version: 1,
      vendor,
      validate: (value: unknown) => ({ value }),
    },
  };
}

// ─── recognising one ────────────────────────────────────────────────────────

describe('recognising a Standard Schema', () => {
  it('sees the marker, and does not see it on a plain JSON Schema', () => {
    expect(isStandardSchema(schema({}))).toBe(true);
    expect(isStandardSchema(JSON_SCHEMA)).toBe(false);
    expect(isStandardSchema(null)).toBe(false);
    expect(isStandardSchema('{}')).toBe(false);
  });

  it('separates the convertible ones from the validate-only ones', () => {
    expect(isStandardSchemaWithJson(schema({}))).toBe(true);
    expect(isStandardSchemaWithJson(validateOnly())).toBe(false);
  });

  it('survives a value whose property access throws', () => {
    // The check reads a property off something the caller supplied. A proxy or a
    // throwing getter must not take the request down with a stack pointing at us.
    const hostile = new Proxy(
      {},
      {
        has() {
          throw new Error('nope');
        },
        get() {
          throw new Error('nope');
        },
      },
    );
    expect(isStandardSchema(hostile)).toBe(false);
    expect(isStandardSchemaWithJson(hostile)).toBe(false);
  });

  it('rejects a marker that is not version 1', () => {
    const future = { '~standard': { version: 2, vendor: 'v', validate: () => ({ value: 1 }) } };
    expect(isStandardSchemaWithJson(future)).toBe(false);
  });
});

// ─── converting one ─────────────────────────────────────────────────────────

describe('toJsonSchema', () => {
  it('passes a plain object through by identity', () => {
    // The overwhelmingly common case; it must not pay for this feature.
    const plain = { type: 'object' };
    expect(toJsonSchema(plain)).toBe(plain);
  });

  it('asks the schema to convert itself, naming the draft providers specify', () => {
    const s = schema({ json: { type: 'object', properties: { a: {} } } });
    expect(toJsonSchema(s)).toEqual({ type: 'object', properties: { a: {} } });
    expect((s as unknown as { calls: Array<{ target?: string }> }).calls[0]?.target).toBe(
      'draft-2020-12',
    );
  });

  it('uses the OUTPUT side when asked for it', () => {
    // A transforming schema describes two different documents; a tool's return
    // value is the one it produces.
    const s = schema({ outputJson: { type: 'object', properties: { out: {} } } });
    expect(toJsonSchema(s, 'output')).toEqual({ type: 'object', properties: { out: {} } });
  });

  it('REFUSES a validate-only schema rather than sending no schema at all', () => {
    // The failure a caller is least likely to notice: an unconstrained request
    // still answers in roughly the right shape most of the time.
    let message = '';
    try {
      toJsonSchema(validateOnly('zod-ancient'));
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain('zod-ancient');
    expect(message).toContain('~standard.jsonSchema');
  });

  it('names the vendor when the conversion itself throws', () => {
    const broken = {
      '~standard': {
        version: 1,
        vendor: 'broken-lib',
        validate: () => ({ value: 1 }),
        jsonSchema: {
          input: () => {
            throw new Error('cannot represent a function');
          },
          output: () => ({}),
        },
      },
    } as unknown as StandardSchemaWithJson;
    let message = '';
    try {
      toJsonSchema(broken);
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain('broken-lib');
    expect(message).toContain('cannot represent a function');
  });
});

// ─── validating through one ─────────────────────────────────────────────────

describe('validateStandardSchema', () => {
  it('returns what the schema PRODUCED, not what it was given', () => {
    // A transforming schema is the case this exists for: returning the input
    // would hand back a value that looks right and skipped the coercion.
    const coercing = {
      '~standard': {
        version: 1,
        vendor: 'coercer',
        validate: (v: unknown) => ({ value: { n: Number((v as { n: string }).n) } }),
      },
    } as unknown as StandardSchema<{ n: number }>;
    expect(validateStandardSchema(coercing, { n: '42' })).toEqual({ n: 42 });
  });

  it('reports every issue, with its path, in one message', () => {
    // The repair loop re-prompts with this text, so a vague message costs a
    // round trip to the provider.
    const strict = schema({
      validate: () => ({
        issues: [
          { message: 'required', path: ['city'] },
          { message: 'must be >= 2', path: ['items', 0, 'count'] },
        ],
      }),
    });
    let message = '';
    try {
      validateStandardSchema(strict, {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('city: required');
    expect(message).toContain('items.0.count: must be >= 2');
  });

  it('accepts the `{ key }` path form the spec also allows', () => {
    const s = schema({
      validate: () => ({ issues: [{ message: 'bad', path: [{ key: 'a' }, { key: 'b' }] }] }),
    });
    expect(() => validateStandardSchema(s, {})).toThrow('a.b: bad');
  });

  it('omits the path when an issue has none', () => {
    const s = schema({ validate: () => ({ issues: [{ message: 'the whole thing is wrong' }] }) });
    expect(() => validateStandardSchema(s, {})).toThrow('the whole thing is wrong');
  });

  it('REFUSES an async validate instead of letting a Promise pass as valid', () => {
    // A Promise is a truthy object with no `issues` property. Awaited nowhere, it
    // would have been returned to the caller in place of their data.
    const asyncSchema = {
      '~standard': {
        version: 1,
        vendor: 'async-lib',
        validate: async (v: unknown) => ({ value: v }),
      },
    } as unknown as StandardSchema;
    expect(() => validateStandardSchema(asyncSchema, { city: 'Paris' })).toThrow(
      /validated asynchronously/,
    );
  });

  it('does not leave the refused async validation as an unhandled rejection', async () => {
    const rejecting = {
      '~standard': {
        version: 1,
        vendor: 'async-lib',
        validate: () => Promise.reject(new Error('boom')),
      },
    } as unknown as StandardSchema;
    expect(() => validateStandardSchema(rejecting, {})).toThrow(/asynchronously/);
    // If the rejection were not swallowed it would surface here, detached from
    // the call that caused it.
    await Promise.resolve();
  });
});

// ─── and on the wire ────────────────────────────────────────────────────────

/** Captures the request body instead of calling a provider. */
function captureEngine() {
  const seen: Array<Record<string, unknown>> = [];
  const fetch = async (_url: string, init?: { body?: string }) => {
    seen.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
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
  return { engine, seen };
}

describe('what reaches the provider', () => {
  it('sends a tool declared with a Standard Schema as JSON Schema', async () => {
    const { engine, seen } = captureEngine();
    const client = engine.createClient({ model: 'anthropic/claude-sonnet-5' });
    await client.complete('hi', {
      tools: [
        {
          name: 'get_weather',
          description: 'Weather',
          parameters: schema({ json: { type: 'object', properties: { city: { type: 'string' } } } }),
        },
      ],
    });
    const tool = (seen[0]!.tools as Array<Record<string, unknown>>)[0]!;
    // The converted document, not the schema object: a `~standard` key reaching
    // a provider is a 400 at best and an ignored constraint at worst.
    expect(tool.input_schema).toEqual({ type: 'object', properties: { city: { type: 'string' } } });
    expect(JSON.stringify(seen[0])).not.toContain('~standard');
    client.destroy();
    engine.destroy();
  });

  it('sends a structured-output Standard Schema as JSON Schema', async () => {
    const { engine, seen } = captureEngine();
    const client = engine.createClient({ model: 'anthropic/claude-sonnet-5' });
    await client.complete('hi', {
      structured: { schema: schema({ json: { type: 'object', properties: { city: {} } } }) },
    });
    expect(JSON.stringify(seen[0])).not.toContain('~standard');
    expect(JSON.stringify(seen[0])).toContain('"city"');
    client.destroy();
    engine.destroy();
  });

  it('leaves a plain JSON Schema exactly as it was', async () => {
    // The regression that matters: this path carries every existing caller.
    const { engine, seen } = captureEngine();
    const client = engine.createClient({ model: 'anthropic/claude-sonnet-5' });
    await client.complete('hi', {
      tools: [{ name: 'get_weather', description: 'Weather', parameters: { ...JSON_SCHEMA } }],
    });
    const tool = (seen[0]!.tools as Array<Record<string, unknown>>)[0]!;
    expect(tool.input_schema).toEqual({ ...JSON_SCHEMA });
    client.destroy();
    engine.destroy();
  });
});

describe('structuredComplete applies what the provider could not', () => {
  it('returns the schema’s transformed value', async () => {
    const { engine } = captureEngine();
    const client = engine.createClient({ model: 'anthropic/claude-sonnet-5' });
    const upper = schema({
      validate: (v: unknown) => ({ value: { city: (v as { city: string }).city.toUpperCase() } }),
    });
    const out = await client.structuredComplete<{ city: string }>('where', upper);
    // The model answered `{"city":"Paris"}`; the schema produced this.
    expect(out).toEqual({ city: 'PARIS' });
    client.destroy();
    engine.destroy();
  });

  it('a refinement failure is an InvalidFinalOutputError, so the repair loop sees it', async () => {
    const { engine, seen } = captureEngine();
    const client = engine.createClient({ model: 'anthropic/claude-sonnet-5' });
    const refusing = schema({
      validate: () => ({ issues: [{ message: 'city must be in France', path: ['city'] }] }),
    });
    let caught: unknown;
    try {
      await client.structuredComplete('where', refusing, { structured: { schema: refusing } });
    } catch (e) {
      caught = e;
    }
    expect((caught as { name?: string })?.name).toBe('InvalidFinalOutputError');
    expect(String(caught)).toContain('city must be in France');
    // One attempt, because `repairAttempts` defaults to 0.
    expect(seen).toHaveLength(1);
    client.destroy();
    engine.destroy();
  });

  it('spends the repair budget on a refinement failure, not only on bad JSON', async () => {
    // The reason the validation error is the SAME type as a parse error: a value
    // that parsed and was wrong is exactly what re-prompting helps with, and a
    // separate type would have excluded it from the budget.
    const { engine, seen } = captureEngine();
    const client = engine.createClient({ model: 'anthropic/claude-sonnet-5' });
    const refusing = schema({ validate: () => ({ issues: [{ message: 'nope' }] }) });
    await client
      .structuredComplete('where', refusing, { structured: { schema: refusing, repairAttempts: 2 } })
      .catch(() => undefined);
    expect(seen).toHaveLength(3);
    client.destroy();
    engine.destroy();
  });

  it('leaves a plain JSON Schema result unvalidated, as before', async () => {
    // The provider enforced it. A second check with a zero-dep validator would
    // only find places where we and the provider disagree.
    const { engine } = captureEngine();
    const client = engine.createClient({ model: 'anthropic/claude-sonnet-5' });
    const out = await client.structuredComplete<{ city: string }>('where', {
      type: 'object',
      properties: { city: { type: 'string' }, missing: { type: 'string' } },
      required: ['city', 'missing'],
    });
    // `missing` is absent and nothing complained.
    expect(out).toEqual({ city: 'Paris' });
    client.destroy();
    engine.destroy();
  });
});
