/** moderate() — how the input SHAPE decides the wire body and the return arity.
 *  (Result parsing, cost hooks and the provider guard live in moderate.test.ts.)
 *
 *  The contract, which a port must reproduce exactly, is "shape in = shape out":
 *   - string                     → one item on the wire, ONE result object
 *   - string[]                   → the array on the wire, an ARRAY of results
 *   - ModerationContentPart[]    → one multimodal item, ONE result
 *   - ModerationContentPart[][]  → many multimodal items, an ARRAY of results,
 *     EXCEPT a single-element outer array, which is unwrapped to the one item
 *     it contains and returns a single result — a caller who batched one thing
 *     gets the same answer as a caller who did not batch it.
 *   - []                         → the empty string on the wire, ONE result
 *
 *  And the degenerate case: when the provider answers with no results at all,
 *  the single-result path returns an EMPTY, unflagged result rather than
 *  `undefined`, so `result.flagged` is always safe to read. */

import { describe, expect, it } from 'bun:test';
import { moderate } from '../../../src/helpers/moderate';
import { HookBus } from '../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../src/catalog/catalog';
import type { EngineHandle } from '../../../src/helpers/engine';
import type {
  ModerationContentPart,
  ModerationRawResponse,
  ModerationResult,
} from '../../../src/helpers/moderate-types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

function response(count: number): ModerationRawResponse {
  return {
    id: 'modr-shape',
    model: 'omni-moderation-latest',
    results: Array.from({ length: count }, () => ({
      flagged: false,
      categories: { ...CATEGORIES },
      category_scores: { ...SCORES },
    })),
  } as ModerationRawResponse;
}

function makeEngine(resp: ModerationRawResponse): { engine: EngineHandle; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const engine = {
    apiKeys: { openai: 'test-key' },
    catalog: new ModelCatalog(),
    hooks: new HookBus(),
    fetch: async (req: { body?: unknown }) => {
      bodies.push(req.body);
      return { status: 200, headers: {}, body: resp };
    },
  } as unknown as EngineHandle;
  return { engine, bodies };
}

function wireInput(bodies: unknown[]): unknown {
  return (bodies[0] as { input: unknown }).input;
}

const IMAGE_PART: ModerationContentPart = {
  type: 'image_url',
  image_url: { url: 'https://example.invalid/a.png' },
} as ModerationContentPart;
const TEXT_PART: ModerationContentPart = { type: 'text', text: 'hello' } as ModerationContentPart;

// ─── Nested content-part arrays ───────────────────────────────────────────────

describe('moderate() — ModerationContentPart[][] input', () => {
  it('unwraps a single-item batch and returns ONE result', async () => {
    const { engine, bodies } = makeEngine(response(1));
    const result = await moderate({ input: [[TEXT_PART, IMAGE_PART]], engine });
    // The outer array is stripped: the wire carries the parts themselves.
    expect(wireInput(bodies)).toEqual([TEXT_PART, IMAGE_PART]);
    expect(Array.isArray(result)).toBe(false);
    expect((result as unknown as ModerationResult).flagged).toBe(false);
  });

  it('keeps a multi-item batch nested and returns ONE RESULT PER item', async () => {
    const { engine, bodies } = makeEngine(response(2));
    const result = await moderate({ input: [[TEXT_PART], [IMAGE_PART]], engine });
    expect(wireInput(bodies)).toEqual([[TEXT_PART], [IMAGE_PART]]);
    expect(Array.isArray(result)).toBe(true);
    expect(result as ModerationResult[]).toHaveLength(2);
  });

  it('a flat content-part array is one item, not a batch', async () => {
    const { engine, bodies } = makeEngine(response(1));
    const result = await moderate({ input: [TEXT_PART, IMAGE_PART], engine });
    expect(wireInput(bodies)).toEqual([TEXT_PART, IMAGE_PART]);
    expect(Array.isArray(result)).toBe(false);
  });

  it('string[] stays an array on the wire and returns an array', async () => {
    const { engine, bodies } = makeEngine(response(2));
    const result = await moderate({ input: ['a', 'b'], engine });
    expect(wireInput(bodies)).toEqual(['a', 'b']);
    expect(result as ModerationResult[]).toHaveLength(2);
  });
});

// ─── Empty input ──────────────────────────────────────────────────────────────

describe('moderate() — empty input', () => {
  it('sends the empty string and returns a single result', async () => {
    const { engine, bodies } = makeEngine(response(1));
    const result = await moderate({ input: [] as string[], engine });
    expect(wireInput(bodies)).toBe('');
    expect(Array.isArray(result)).toBe(false);
  });
});

// ─── Provider returned nothing ────────────────────────────────────────────────

describe('moderate() — provider returned no results', () => {
  it('returns an empty unflagged result instead of undefined', async () => {
    const { engine } = makeEngine(response(0));
    const result = (await moderate({ input: 'anything', engine })) as ModerationResult;
    expect(result).toBeDefined();
    expect(result.flagged).toBe(false);
    expect(result.categories).toEqual({} as ModerationResult['categories']);
    expect(result.categoryScores).toEqual({} as ModerationResult['categoryScores']);
  });

  it('the array path still returns the empty array, not a synthesised result', async () => {
    const { engine } = makeEngine(response(0));
    expect(await moderate({ input: ['a'], engine })).toEqual([]);
  });
});
