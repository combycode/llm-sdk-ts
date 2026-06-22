/** consolidate() runtime-path tests.
 *
 *  Uses the `_complete` seam to inject a scripted fake that returns canned
 *  answers so no network or real API keys are required. Covers:
 *   - multi-round debate that reaches agreement (agreedAt set, loop exits early)
 *   - debate that never agrees (runs to maxRounds, agreedAt is null)
 *   - judge-verdict parsing: well-formed JSON drives the decision
 *   - malformed/unparseable judge verdict falls back gracefully (no crash)
 *   - summary generation is invoked and its output is returned
 *   - onRound callback fires with correct per-round data
 *   - validation guards still throw (regression from the original test file) */

import { describe, expect, it } from 'bun:test';
import { consolidate } from '../../../src/helpers/consolidate';
import type { CompleteFn, ConsolidateOptions } from '../../../src/helpers/consolidate';
import type { CompleteOptions, CompleteResult } from '../../../src/helpers/one-shot';
import { emptyUsage } from '../../../src/llm/types/response';

// ─── Constants ───────────────────────────────────────────────────────────────

const MODEL_AGENT_A = 'anthropic/claude-a';
const MODEL_AGENT_B = 'openai/gpt-b';
const MODEL_JUDGE = 'anthropic/claude-judge';

const AGENT_A = { name: 'Agent A', model: MODEL_AGENT_A, system: 'You are agent A.' };
const AGENT_B = { name: 'Agent B', model: MODEL_AGENT_B, system: 'You are agent B.' };
const JUDGE = { model: MODEL_JUDGE };

const TASK = 'Which database should we use?';
const SUMMARY_TEXT = '## Consensus\nUse PostgreSQL.\n## Per-agent unique points\n- Agent A: relational\n- Agent B: ecosystem';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeResponse(text: string): CompleteResult {
  return {
    text,
    response: {
      id: 'fake-id',
      model: 'fake-model',
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: emptyUsage(),
      text,
      toolCalls: [],
      thinking: null,
      media: [],
      latencyMs: 0,
      raw: null,
    },
  };
}

/** Returns a well-formed judge verdict JSON string. */
function verdictJson(agreed: boolean, reason: string): string {
  return JSON.stringify({ agreed, reason });
}

/** Build a scripted fake complete() from an ordered queue of responses.
 *  Each call to the fake pops the next entry. */
function makeScriptedComplete(responses: string[]): CompleteFn {
  const queue = [...responses];
  return async (_opts: CompleteOptions): Promise<CompleteResult> => {
    const text = queue.shift();
    if (text === undefined) throw new Error('scripted complete: ran out of responses');
    return makeResponse(text);
  };
}

function baseOpts(overrides: Partial<ConsolidateOptions> = {}): ConsolidateOptions {
  return {
    agents: [AGENT_A, AGENT_B],
    task: TASK,
    judge: JUDGE,
    ...overrides,
  };
}

// ─── Runtime: debate reaches agreement ───────────────────────────────────────

describe('consolidate — runtime: early agreement', () => {
  it('stops the loop at the round where judge returns agreed:true and sets agreedAt', async () => {
    // Round 1: 2 agent answers + 1 judge verdict (agreed) + 1 summary = 4 calls total.
    const fake = makeScriptedComplete([
      'Agent A says PostgreSQL.',       // round 1, agent A
      'Agent B says PostgreSQL too.',   // round 1, agent B
      verdictJson(true, 'Both recommend PostgreSQL'), // round 1 judge
      SUMMARY_TEXT,                      // summary
    ]);

    const result = await consolidate(baseOpts({ rounds: 3, _complete: fake }));

    expect(result.agreedAt).toBe(1);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]).toHaveLength(2);
    expect(result.rounds[0][0].agent).toBe('Agent A');
    expect(result.rounds[0][1].agent).toBe('Agent B');
    expect(result.summary).toBe(SUMMARY_TEXT);
  });

  it('reports onRound for the agreement round with agreed:true', async () => {
    const fake = makeScriptedComplete([
      'A answer', 'B answer',
      verdictJson(true, 'Agreed on round 1'),
      SUMMARY_TEXT,
    ]);

    const roundInfos: Array<{ round: number; agreed: boolean; judgeReason: string }> = [];
    await consolidate(baseOpts({
      rounds: 3,
      _complete: fake,
      onRound: (info) => roundInfos.push({ round: info.round, agreed: info.agreed, judgeReason: info.judgeReason }),
    }));

    expect(roundInfos).toHaveLength(1);
    expect(roundInfos[0].round).toBe(1);
    expect(roundInfos[0].agreed).toBe(true);
    expect(roundInfos[0].judgeReason).toBe('Agreed on round 1');
  });

  it('agrees on round 2 when round 1 disagrees', async () => {
    // Round 1: 2 agent + judge(disagree). Round 2: 2 agent + judge(agree). + summary.
    const fake = makeScriptedComplete([
      'A round1', 'B round1',
      verdictJson(false, 'Not yet'),
      'A round2', 'B round2',
      verdictJson(true, 'Now yes'),
      SUMMARY_TEXT,
    ]);

    const result = await consolidate(baseOpts({ rounds: 3, _complete: fake }));

    expect(result.agreedAt).toBe(2);
    expect(result.rounds).toHaveLength(2);
    expect(result.summary).toBe(SUMMARY_TEXT);
  });
});

// ─── Runtime: debate never agrees ────────────────────────────────────────────

describe('consolidate — runtime: no agreement', () => {
  it('runs to maxRounds, agreedAt is null, summary is still returned', async () => {
    // 2 rounds x (2 agents + 1 judge) + 1 summary = 7 calls.
    const fake = makeScriptedComplete([
      'A r1', 'B r1', verdictJson(false, 'Disagree'),
      'A r2', 'B r2', verdictJson(false, 'Still no'),
      SUMMARY_TEXT,
    ]);

    const result = await consolidate(baseOpts({ rounds: 2, _complete: fake }));

    expect(result.agreedAt).toBeNull();
    expect(result.rounds).toHaveLength(2);
    expect(result.summary).toBe(SUMMARY_TEXT);
  });

  it('fires onRound for every round when never agreed', async () => {
    const fake = makeScriptedComplete([
      'A r1', 'B r1', verdictJson(false, 'No1'),
      'A r2', 'B r2', verdictJson(false, 'No2'),
      SUMMARY_TEXT,
    ]);

    const rounds: number[] = [];
    await consolidate(baseOpts({
      rounds: 2,
      _complete: fake,
      onRound: (info) => rounds.push(info.round),
    }));

    expect(rounds).toEqual([1, 2]);
  });
});

// ─── Runtime: judge verdict parsing ──────────────────────────────────────────

describe('consolidate — runtime: judge verdict parsing', () => {
  it('well-formed verdict with agreed:true stops the loop', async () => {
    const fake = makeScriptedComplete([
      'A', 'B',
      verdictJson(true, 'clear agreement'),
      SUMMARY_TEXT,
    ]);
    const result = await consolidate(baseOpts({ rounds: 3, _complete: fake }));
    expect(result.agreedAt).toBe(1);
  });

  it('malformed verdict (not valid JSON) falls back gracefully — no crash, loop continues', async () => {
    // Round 1 judge returns garbage. Round 2 judge returns real agreement.
    const fake = makeScriptedComplete([
      'A r1', 'B r1',
      'THIS IS NOT JSON',                      // malformed verdict
      'A r2', 'B r2',
      verdictJson(true, 'agree on round 2'),
      SUMMARY_TEXT,
    ]);

    const result = await consolidate(baseOpts({ rounds: 3, _complete: fake }));

    // Malformed verdict must not crash; fallback is agreed:false, loop continues.
    expect(result.agreedAt).toBe(2);
    expect(result.rounds).toHaveLength(2);
  });

  it('malformed verdict produces judgeReason "judge parse failed" in onRound', async () => {
    const fake = makeScriptedComplete([
      'A', 'B',
      'GARBAGE',
      'A2', 'B2',
      verdictJson(true, 'ok'),
      SUMMARY_TEXT,
    ]);

    const reasons: string[] = [];
    await consolidate(baseOpts({
      rounds: 3,
      _complete: fake,
      onRound: (info) => reasons.push(info.judgeReason),
    }));

    expect(reasons[0]).toBe('judge parse failed');
  });

  it('verdict with agreed:false does not stop the loop early', async () => {
    const fake = makeScriptedComplete([
      'A', 'B',
      verdictJson(false, 'not yet'),
      'A2', 'B2',
      verdictJson(false, 'still no'),
      SUMMARY_TEXT,
    ]);

    const result = await consolidate(baseOpts({ rounds: 2, _complete: fake }));
    expect(result.agreedAt).toBeNull();
    expect(result.rounds).toHaveLength(2);
  });
});

// ─── Runtime: summary generation ─────────────────────────────────────────────

describe('consolidate — runtime: summary generation', () => {
  it('summary text is returned directly from the final complete() call', async () => {
    const expectedSummary = '## Consensus\nUse Redis.\n## Per-agent unique points\n- A: fast\n- B: simple';
    const fake = makeScriptedComplete([
      'A ans', 'B ans',
      verdictJson(true, 'agreed'),
      expectedSummary,
    ]);

    const result = await consolidate(baseOpts({ rounds: 3, _complete: fake }));
    expect(result.summary).toBe(expectedSummary);
  });

  it('summary is always called even when debate never agreed', async () => {
    const expectedSummary = 'No consensus reached but here is what each said.';
    const fake = makeScriptedComplete([
      'A', 'B', verdictJson(false, 'no'),
      expectedSummary,
    ]);

    const result = await consolidate(baseOpts({ rounds: 1, _complete: fake }));
    expect(result.summary).toBe(expectedSummary);
    expect(result.agreedAt).toBeNull();
  });
});

// ─── Runtime: transcript structure ───────────────────────────────────────────

describe('consolidate — runtime: transcript structure', () => {
  it('rounds array contains per-round answers in agent order', async () => {
    const fake = makeScriptedComplete([
      'A answer text', 'B answer text',
      verdictJson(true, 'ok'),
      SUMMARY_TEXT,
    ]);

    const result = await consolidate(baseOpts({ rounds: 3, _complete: fake }));

    expect(result.rounds[0][0]).toEqual({ agent: 'Agent A', text: 'A answer text' });
    expect(result.rounds[0][1]).toEqual({ agent: 'Agent B', text: 'B answer text' });
  });

  it('agent answer text is trimmed', async () => {
    const fake = makeScriptedComplete([
      '  leading space  ', '\ttab answer\t',
      verdictJson(true, 'agree'),
      SUMMARY_TEXT,
    ]);

    const result = await consolidate(baseOpts({ rounds: 3, _complete: fake }));
    expect(result.rounds[0][0].text).toBe('leading space');
    expect(result.rounds[0][1].text).toBe('tab answer');
  });
});

// ─── Validation guards (regression from original test file) ──────────────────

describe('consolidate — validation guards (regression)', () => {
  it('throws when fewer than 2 agents', async () => {
    await expect(consolidate(baseOpts({ agents: [AGENT_A] }))).rejects.toThrow('need at least 2 agents');
  });

  it('throws when agents array is empty', async () => {
    await expect(consolidate(baseOpts({ agents: [] }))).rejects.toThrow('need at least 2 agents');
  });

  it('throws when judge.model is empty', async () => {
    await expect(consolidate(baseOpts({ judge: { model: '' } }))).rejects.toThrow(/judge.model.*required/);
  });

  it('throws when judge model matches a participating agent model', async () => {
    await expect(
      consolidate(baseOpts({ judge: { model: MODEL_AGENT_A } })),
    ).rejects.toThrow(/self-evaluation bias/);
  });
});
