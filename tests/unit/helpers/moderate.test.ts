/** moderate() unit tests.
 *  Uses a stubbed engine with a fake fetch -- no real network calls, no API keys. */

import { describe, expect, it } from 'bun:test';
import { moderate } from '../../../src/helpers/moderate';
import { HookBus } from '../../../src/bus/hook-bus';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';
import type { EngineHandle } from '../../../src/helpers/engine';
import type { CostEntryContext } from '../../../src/bus/hook-map';
import type { ModerationRawResponse } from '../../../src/helpers/moderate-types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOT_FLAGGED_RESPONSE: ModerationRawResponse = {
  id: 'modr-test',
  model: 'omni-moderation-latest',
  results: [
    {
      flagged: false,
      categories: {
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
      },
      category_scores: {
        harassment: 0.001,
        'harassment/threatening': 0.001,
        hate: 0.001,
        'hate/threatening': 0.001,
        illicit: 0.001,
        'illicit/violent': 0.001,
        'self-harm': 0.001,
        'self-harm/intent': 0.001,
        'self-harm/instructions': 0.001,
        sexual: 0.001,
        'sexual/minors': 0.001,
        violence: 0.001,
        'violence/graphic': 0.001,
      },
    },
  ],
};

const FLAGGED_RESPONSE: ModerationRawResponse = {
  id: 'modr-flagged',
  model: 'omni-moderation-latest',
  results: [
    {
      flagged: true,
      categories: {
        harassment: true,
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
      },
      category_scores: {
        harassment: 0.97,
        'harassment/threatening': 0.01,
        hate: 0.01,
        'hate/threatening': 0.01,
        illicit: 0.01,
        'illicit/violent': 0.01,
        'self-harm': 0.01,
        'self-harm/intent': 0.01,
        'self-harm/instructions': 0.01,
        sexual: 0.01,
        'sexual/minors': 0.01,
        violence: 0.01,
        'violence/graphic': 0.01,
      },
    },
  ],
};

const ARRAY_RESPONSE: ModerationRawResponse = {
  id: 'modr-array',
  model: 'omni-moderation-latest',
  results: [
    {
      flagged: false,
      categories: { harassment: false, 'harassment/threatening': false, hate: false, 'hate/threatening': false, illicit: false, 'illicit/violent': false, 'self-harm': false, 'self-harm/intent': false, 'self-harm/instructions': false, sexual: false, 'sexual/minors': false, violence: false, 'violence/graphic': false },
      category_scores: { harassment: 0.001, 'harassment/threatening': 0.001, hate: 0.001, 'hate/threatening': 0.001, illicit: 0.001, 'illicit/violent': 0.001, 'self-harm': 0.001, 'self-harm/intent': 0.001, 'self-harm/instructions': 0.001, sexual: 0.001, 'sexual/minors': 0.001, violence: 0.001, 'violence/graphic': 0.001 },
    },
    {
      flagged: true,
      categories: { harassment: true, 'harassment/threatening': false, hate: false, 'hate/threatening': false, illicit: false, 'illicit/violent': false, 'self-harm': false, 'self-harm/intent': false, 'self-harm/instructions': false, sexual: false, 'sexual/minors': false, violence: false, 'violence/graphic': false },
      category_scores: { harassment: 0.9, 'harassment/threatening': 0.01, hate: 0.01, 'hate/threatening': 0.01, illicit: 0.01, 'illicit/violent': 0.01, 'self-harm': 0.01, 'self-harm/intent': 0.01, 'self-harm/instructions': 0.01, sexual: 0.01, 'sexual/minors': 0.01, violence: 0.01, 'violence/graphic': 0.01 },
    },
  ],
};

function makeEngine(response: ModerationRawResponse): {
  engine: EngineHandle;
  entries: CostEntryContext[];
  lastBody: unknown[];
} {
  const entries: CostEntryContext[] = [];
  const lastBody: unknown[] = [];
  const hooks = new HookBus();
  hooks.on('onCostEntry', (ctx) => { entries.push(ctx); });

  const fetch = async (req: { body?: unknown }) => {
    lastBody.push(req.body);
    return { status: 200, headers: {}, body: response };
  };

  const engine = {
    apiKeys: { openai: 'test-key' },
    catalog: new ModelCatalog(),
    hooks,
    fetch,
  } as unknown as EngineHandle;

  return { engine, entries, lastBody };
}

function makeNoKeyEngine(): EngineHandle {
  return {
    apiKeys: {},
    catalog: new ModelCatalog(),
    hooks: new HookBus(),
    fetch: async () => ({ status: 200, headers: {}, body: NOT_FLAGGED_RESPONSE }),
  } as unknown as EngineHandle;
}

// ─── Flagged result parsing ───────────────────────────────────────────────────

describe('moderate() -- flagged result', () => {
  it('returns flagged=true with correct category scores', async () => {
    const { engine } = makeEngine(FLAGGED_RESPONSE);
    const result = await moderate({ input: 'harmful text', engine });
    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) throw new Error('unexpected array');
    expect(result.flagged).toBe(true);
    expect(result.categories.harassment).toBe(true);
    expect(result.categoryScores.harassment).toBeCloseTo(0.97);
  });
});

// ─── Not-flagged result ───────────────────────────────────────────────────────

describe('moderate() -- not flagged result', () => {
  it('returns flagged=false for benign input', async () => {
    const { engine } = makeEngine(NOT_FLAGGED_RESPONSE);
    const result = await moderate({ input: 'hello world', engine });
    expect(Array.isArray(result)).toBe(false);
    if (Array.isArray(result)) throw new Error('unexpected array');
    expect(result.flagged).toBe(false);
    expect(result.categories.harassment).toBe(false);
  });
});

// ─── Array input returns array ────────────────────────────────────────────────

describe('moderate() -- array input', () => {
  it('returns an array when input is string[]', async () => {
    const { engine } = makeEngine(ARRAY_RESPONSE);
    const results = await moderate({ input: ['hello', 'harm'], engine });
    expect(Array.isArray(results)).toBe(true);
    if (!Array.isArray(results)) throw new Error('expected array');
    expect(results).toHaveLength(2);
    expect(results[0].flagged).toBe(false);
    expect(results[1].flagged).toBe(true);
  });
});

// ─── Missing OpenAI key throws ────────────────────────────────────────────────

describe('moderate() -- missing API key', () => {
  it('throws the same missing-key error as embed() when no openai key is present', async () => {
    await expect(
      moderate({ input: 'test', engine: makeNoKeyEngine() }),
    ).rejects.toThrow(/no API key for provider "openai"/);
  });

  it('throws missing-key error even when apiKey is explicitly undefined', async () => {
    await expect(
      moderate({ input: 'test', apiKey: undefined, engine: makeNoKeyEngine() }),
    ).rejects.toThrow(/no API key/);
  });
});

// ─── Honest-zero cost hook ────────────────────────────────────────────────────

describe('moderate() -- honest-zero cost hook', () => {
  it('always emits onCostEntry with total=0 and the free note', async () => {
    const { engine, entries } = makeEngine(NOT_FLAGGED_RESPONSE);
    await moderate({ input: 'test', engine });
    expect(entries).toHaveLength(1);
    expect(entries[0].entry.cost.total).toBe(0);
    expect(entries[0].entry.cost.source).toBe('calculated');
    expect(entries[0].entry.providerEvidence.note).toBe('free: moderations endpoint not billed');
  });

  it('tags the cost entry with type=moderation and provider=openai', async () => {
    const { engine, entries } = makeEngine(NOT_FLAGGED_RESPONSE);
    await moderate({ input: 'test', engine });
    expect(entries[0].entry.tags.type).toBe('moderation');
    expect(entries[0].entry.tags.provider).toBe('openai');
  });

  it('emits the zero entry for array input too', async () => {
    const { engine, entries } = makeEngine(ARRAY_RESPONSE);
    await moderate({ input: ['a', 'b'], engine });
    expect(entries).toHaveLength(1);
    expect(entries[0].entry.cost.total).toBe(0);
  });
});

// ─── Image + text content-part input ─────────────────────────────────────────

describe('moderate() -- image+text content-part input', () => {
  it('sends the content-part array directly as the wire input body', async () => {
    const { engine, lastBody } = makeEngine(NOT_FLAGGED_RESPONSE);
    const parts = [
      { type: 'text' as const, text: 'check this image' },
      { type: 'image_url' as const, image_url: { url: 'https://example.com/img.png' } },
    ];
    const result = await moderate({ input: parts, engine });
    expect(Array.isArray(result)).toBe(false);
    expect(lastBody).toHaveLength(1);
    const body = lastBody[0] as { input: unknown };
    expect(Array.isArray(body.input)).toBe(true);
    const arr = body.input as Array<{ type: string }>;
    expect(arr[0].type).toBe('text');
    expect(arr[1].type).toBe('image_url');
  });

  it('returns a single ModerationResult for a single content-part array', async () => {
    const { engine } = makeEngine(NOT_FLAGGED_RESPONSE);
    const parts = [{ type: 'text' as const, text: 'hello' }];
    const result = await moderate({ input: parts, engine });
    expect(Array.isArray(result)).toBe(false);
  });
});

// ─── Non-openai provider throws ──────────────────────────────────────────────

describe('moderate() -- provider guard', () => {
  it('throws when a non-openai provider is specified', async () => {
    const engine: EngineHandle = {
      apiKeys: { anthropic: 'key' },
      catalog: new ModelCatalog(),
      hooks: new HookBus(),
      fetch: async () => ({ status: 200, headers: {}, body: NOT_FLAGGED_RESPONSE }),
    } as unknown as EngineHandle;

    await expect(
      moderate({ input: 'test', model: 'anthropic/claude-haiku-4-5', engine }),
    ).rejects.toThrow(/provider "anthropic" is not supported/);
  });
});
