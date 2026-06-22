/** consolidate — multi-agent debate that runs up to N rounds, stops early
 *  when the agents converge, and produces a final summary.
 *
 *  Each round, every agent answers the task in parallel (seeing the prior
 *  round's answers). After each round a judge LLM evaluates whether the
 *  agents reached substantive agreement (structured JSON output). When
 *  it returns `agreed: true`, the loop exits early. Either way a closing
 *  summary call returns the consensus + per-agent unique points. */

import { parseStructured } from '../llm/client-internal';
import { complete as defaultComplete } from './one-shot';
import type { CompleteOptions, CompleteResult } from './one-shot';

export interface ConsolidateAgent {
  /** Display name surfaced via `onRound` and inside summary prompts. */
  name: string;
  /** Namespaced model id, e.g. `anthropic/claude-haiku-4-5`. */
  model: string;
  /** Persona / role text. */
  system: string;
}

export interface ConsolidateAnswer {
  agent: string;
  text: string;
}

export interface ConsolidateRoundInfo {
  round: number;
  answers: ConsolidateAnswer[];
  agreed: boolean;
  judgeReason: string;
}

export interface ConsolidateJudge {
  /** Namespaced model id for the judge. SHOULD be different from any
   *  participating agent's model — otherwise the judge is evaluating its
   *  own answer as one of the inputs, which biases the verdict. */
  model: string;
  /** Optional override for the judge system prompt. */
  system?: string;
}

/** Internal type for the completion function signature. */
export type CompleteFn = (opts: CompleteOptions) => Promise<CompleteResult>;

export interface ConsolidateOptions {
  /** Two or more agents — heterogeneous models recommended. */
  agents: ConsolidateAgent[];
  /** The question / task they are debating. */
  task: string;
  /** External judge that decides round-by-round agreement and writes the
   *  closing summary. Must be a separate model from the debate participants
   *  to avoid self-evaluation bias. */
  judge: ConsolidateJudge;
  /** Maximum rounds before the loop ends regardless of agreement. */
  rounds?: number;
  /** Per-agent maxTokens for each round. */
  maxTokens?: number;
  /** Fires after every round with the answers + judge verdict. */
  onRound?: (info: ConsolidateRoundInfo) => void;
  /** Internal seam for tests — inject a fake complete() instead of the real one.
   *  Not part of the public API; omit in production code. */
  _complete?: CompleteFn;
}

export interface ConsolidateResult {
  /** Closing summary text (consensus + per-agent unique points). */
  summary: string;
  /** Every round's answers, in order. */
  rounds: ConsolidateAnswer[][];
  /** 1-based round index where the judge declared agreement, or null
   *  if the loop ran to `rounds`. */
  agreedAt: number | null;
}

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agreed: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['agreed', 'reason'],
};

interface JudgeVerdict {
  agreed: boolean;
  reason: string;
}

const DEFAULT_JUDGE_SYSTEM =
  'You are an impartial judge evaluating whether multiple agents have reached substantive ' +
  'agreement on a task. Disagreement on framing or emphasis with the same core ' +
  'recommendation = agreed. You are NOT one of the agents — your role is purely evaluative.';

const DEFAULT_SUMMARY_SYSTEM =
  'You are an impartial editor who consolidates multi-agent debate into a clear, balanced summary. ' +
  'Do not express your own opinion; reflect what the agents collectively concluded.';

export async function consolidate(opts: ConsolidateOptions): Promise<ConsolidateResult> {
  if (opts.agents.length < 2) {
    throw new Error('consolidate: need at least 2 agents');
  }
  if (!opts.judge?.model) {
    throw new Error('consolidate: `judge.model` is required');
  }
  const judgeModel = opts.judge.model;
  if (opts.agents.some((a) => a.model === judgeModel)) {
    throw new Error(
      `consolidate: judge.model "${judgeModel}" is also a participating agent — ` +
        'pick a different model for the judge to avoid self-evaluation bias',
    );
  }
  const complete = opts._complete ?? defaultComplete;
  const maxRounds = opts.rounds ?? 3;
  const maxTokens = opts.maxTokens ?? 220;
  const judgeSystem = opts.judge.system ?? DEFAULT_JUDGE_SYSTEM;

  const transcript: ConsolidateAnswer[][] = [];
  let agreedAt: number | null = null;

  for (let round = 1; round <= maxRounds; round++) {
    const priorBlock = transcript.length
      ? '\n\nPrevious round answers:\n' +
        transcript[transcript.length - 1].map((a) => `[${a.agent}]: ${a.text}`).join('\n')
      : '';
    const userMsg =
      `${opts.task}\n\n` +
      `This is round ${round} of ${maxRounds}. Try to converge with the other agents ` +
      `where their points are valid; restate your position concisely.${priorBlock}`;

    const answers = await Promise.all(
      opts.agents.map(async (agent) => ({
        agent: agent.name,
        text: (
          await complete({
            model: agent.model,
            system:
              `${agent.system} ` +
              'Reply concisely (≤3 sentences). State your concrete recommendation.',
            prompt: userMsg,
            maxTokens,
          })
        ).text.trim(),
      })),
    );
    transcript.push(answers);

    let verdict: JudgeVerdict;
    try {
      const judge = await complete({
        model: judgeModel,
        system: judgeSystem,
        prompt:
          `Task:\n${opts.task}\n\nAgents' answers (round ${round}):\n` +
          answers.map((a) => `[${a.agent}]: ${a.text}`).join('\n'),
        structured: { schema: JUDGE_SCHEMA },
        maxTokens: 200,
      });
      verdict = parseStructured<JudgeVerdict>(judge.text);
    } catch {
      verdict = { agreed: false, reason: 'judge parse failed' };
    }

    opts.onRound?.({ round, answers, agreed: verdict.agreed, judgeReason: verdict.reason });

    if (verdict.agreed) {
      agreedAt = round;
      break;
    }
  }

  const finalAnswers = transcript[transcript.length - 1];
  const summary = await complete({
    model: judgeModel,
    system: DEFAULT_SUMMARY_SYSTEM,
    prompt:
      `Task:\n${opts.task}\n\nFinal answers from each agent:\n` +
      finalAnswers.map((a) => `[${a.agent}]: ${a.text}`).join('\n') +
      '\n\nWrite in markdown:\n' +
      '## Consensus\n(one or two sentences capturing the shared recommendation)\n' +
      '## Per-agent unique points\n(one short bullet per agent for non-shared insight)',
    maxTokens: 400,
  });

  return { summary: summary.text, rounds: transcript, agreedAt };
}
