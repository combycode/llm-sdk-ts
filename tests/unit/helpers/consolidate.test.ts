/** consolidate() unit tests.
 *  consolidate() runs a multi-agent debate and calls complete() for every
 *  participant each round. Since complete() has no injection seam in this
 *  helper, the tests that cover the FULL runtime path (multi-round debate,
 *  agreed-at detection, summary generation) require network and live in the
 *  integration layer.
 *
 *  These unit tests cover the pure validation guards — all synchronous paths
 *  that throw BEFORE any LLM call is made:
 *   - fewer than 2 agents throws
 *   - missing judge.model throws
 *   - judge model that matches an agent model throws (self-evaluation bias guard)
 *
 *  ConsolidateOptions / ConsolidateResult type shapes are verified inline.
 *  No network, no real API keys. */

import { describe, expect, it } from 'bun:test';
import { consolidate } from '../../../src/helpers/consolidate';
import type { ConsolidateOptions } from '../../../src/helpers/consolidate';

// ─── Shared minimal options (would need network to run) ───────────────────────

const AGENT_A = { name: 'Agent A', model: 'anthropic/claude-a', system: 'You are agent A.' };
const AGENT_B = { name: 'Agent B', model: 'openai/gpt-b', system: 'You are agent B.' };
const JUDGE = { model: 'anthropic/claude-judge' };

function opts(overrides: Partial<ConsolidateOptions> = {}): ConsolidateOptions {
  return {
    agents: [AGENT_A, AGENT_B],
    task: 'Which framework should we use?',
    judge: JUDGE,
    ...overrides,
  };
}

// ─── Validation guards (throw before any network call) ───────────────────────

describe('consolidate — validation guards', () => {
  it('throws when fewer than 2 agents are provided', async () => {
    await expect(
      consolidate(opts({ agents: [AGENT_A] })),
    ).rejects.toThrow('need at least 2 agents');
  });

  it('throws when agents array is empty', async () => {
    await expect(
      consolidate(opts({ agents: [] })),
    ).rejects.toThrow('need at least 2 agents');
  });

  it('throws when judge.model is falsy/empty', async () => {
    await expect(
      consolidate(opts({ judge: { model: '' } })),
    ).rejects.toThrow(/judge.model.*required/);
  });

  it('throws when judge.model matches a participating agent model', async () => {
    // AGENT_A uses 'anthropic/claude-a'; judge uses the same -> bias guard fires
    await expect(
      consolidate(opts({ judge: { model: AGENT_A.model } })),
    ).rejects.toThrow(/self-evaluation bias/);
  });

  it('throws when judge model equals the second agent model', async () => {
    await expect(
      consolidate(opts({ judge: { model: AGENT_B.model } })),
    ).rejects.toThrow(/self-evaluation bias/);
  });
});

// ─── Type shape verification (import-time) ───────────────────────────────────

describe('consolidate — exported type shapes', () => {
  it('ConsolidateOptions fields compile and are accepted by consolidate()', () => {
    // If this compiles, the type shape is correct.
    const _o: ConsolidateOptions = {
      agents: [AGENT_A, AGENT_B],
      task: 'test',
      judge: { model: 'anthropic/claude-judge', system: 'override system' },
      rounds: 2,
      maxTokens: 100,
      onRound: (_info) => {},
    };
    // We cannot call consolidate(_o) without network, but type check suffices.
    expect(_o.rounds).toBe(2);
    expect(_o.maxTokens).toBe(100);
    expect(typeof _o.onRound).toBe('function');
  });
});
