/** countTokens() unit tests.
 *  Tests the heuristic path (no tiktoken, no network).
 *  Uses a minimal engine stub with an empty catalog so HybridTokenCounter
 *  falls through to HeuristicCounter on every call. */

import { describe, expect, it } from 'bun:test';
import { countTokens } from '../../../src/helpers/count-tokens';
import { ModelCatalog } from '../../../src/plugins/model-catalog/catalog';
import type { EngineHandle } from '../../../src/helpers/engine';

// ─── Minimal engine stub ──────────────────────────────────────────────────────

function makeEngine(): EngineHandle {
  return { catalog: new ModelCatalog(), apiKeys: {} } as unknown as EngineHandle;
}

// ─── Happy path — heuristic, string input ─────────────────────────────────────

describe('countTokens — string input (heuristic)', () => {
  it('returns a positive integer for a non-empty string', async () => {
    const n = await countTokens({
      model: 'openai/gpt-5-nano',
      input: 'Hello, world!',
      engine: makeEngine(),
    });
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });

  it('is deterministic for the same input string', async () => {
    const engine = makeEngine();
    const a = await countTokens({ model: 'openai/gpt-5-nano', input: 'test input', engine });
    const b = await countTokens({ model: 'openai/gpt-5-nano', input: 'test input', engine });
    expect(a).toBe(b);
  });

  it('longer text produces more tokens than shorter text', async () => {
    const engine = makeEngine();
    const short = await countTokens({ model: 'openai/gpt-5-nano', input: 'hi', engine });
    const long = await countTokens({
      model: 'openai/gpt-5-nano',
      input: 'This is a much longer sentence with many more words and therefore more tokens.',
      engine,
    });
    expect(long).toBeGreaterThan(short);
  });

  it('bare model + provider resolves correctly', async () => {
    const n = await countTokens({
      model: 'gpt-5-nano',
      provider: 'openai',
      input: 'test',
      engine: makeEngine(),
    });
    expect(n).toBeGreaterThan(0);
  });
});

// ─── exact:false — sync estimate path ────────────────────────────────────────

describe('countTokens — exact:false (sync estimate)', () => {
  it('returns a positive integer without hitting a count API', async () => {
    const n = await countTokens({
      model: 'openai/gpt-5-nano',
      input: 'estimate this',
      exact: false,
      engine: makeEngine(),
    });
    expect(n).toBeGreaterThan(0);
    expect(Number.isInteger(n)).toBe(true);
  });
});

// ─── Message[] input ──────────────────────────────────────────────────────────

describe('countTokens — Message[] input', () => {
  it('sums tokens across multiple messages', async () => {
    const engine = makeEngine();
    const n = await countTokens({
      model: 'openai/gpt-5-nano',
      input: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'World' },
      ],
      engine,
    });
    expect(n).toBeGreaterThan(0);
  });

  it('more messages produce more tokens', async () => {
    const engine = makeEngine();
    const one = await countTokens({
      model: 'openai/gpt-5-nano',
      input: [{ role: 'user', content: 'Hello' }],
      engine,
    });
    const two = await countTokens({
      model: 'openai/gpt-5-nano',
      input: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'More content here adds tokens.' },
      ],
      engine,
    });
    expect(two).toBeGreaterThan(one);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('countTokens — edge cases', () => {
  it('empty string returns 0 or a small non-negative value', async () => {
    const n = await countTokens({
      model: 'openai/gpt-5-nano',
      input: '',
      engine: makeEngine(),
    });
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it('empty Message[] returns 0', async () => {
    const n = await countTokens({
      model: 'openai/gpt-5-nano',
      input: [],
      engine: makeEngine(),
    });
    expect(n).toBe(0);
  });
});
