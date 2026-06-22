/** orxa:score@1.0.0 — score how well an answer fulfills a task, per criteria. */

import { defineLLMTool } from '../runner/define';
import { formatBulletedList } from '../runner/template';
import type { InternalTool } from '../types';

export interface ScoreInput {
  task: string;
  answer: string;
  criteria?: string[];
}

export interface ScoreOutput {
  score: number;
  breakdown: Record<string, number>;
  feedback: string;
}

export const scoreTool: InternalTool = defineLLMTool({
  id: 'orxa:score@1.0.0',
  namespace: 'orxa',
  name: 'score',
  version: '1.0.0',
  description: 'Score how well an answer fulfills a task (0-100 overall, per-criterion breakdown)',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The task description the answer is meant to fulfill' },
      answer: { type: 'string', description: 'The answer to evaluate' },
      criteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Evaluation criteria (e.g. accuracy, completeness, clarity)',
        default: ['accuracy', 'completeness', 'clarity'],
      },
    },
    required: ['task', 'answer'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      score: { type: 'number', minimum: 0, maximum: 100 },
      breakdown: { type: 'object' },
      feedback: { type: 'string' },
    },
    required: ['score', 'breakdown', 'feedback'],
  },
  systemPrompt:
    'You are an impartial evaluator. Score answers strictly based on the given criteria. The overall score must equal the average of breakdown scores.',
  userTemplate: `Score how well the following answer fulfills the task.

Task:
{{task}}

Answer:
{{answer}}

Evaluation Criteria:
{{criteriaList}}

Return a JSON object with:
- score: overall score from 0 to 100 (must equal the average of breakdown values)
- breakdown: object with a 0-100 score for each criterion (keys match criterion names)
- feedback: concise, constructive feedback on the answer`,
  outputFormat: 'json',
  prepareInput: (input) => ({
    ...input,
    criteriaList: formatBulletedList((input.criteria as string[]) ?? []),
  }),
  modelPreference: {
    preferredModel: 'openai/gpt-5.4-nano',
    fallbackModels: ['google/gemini-3.1-flash-lite-preview', 'anthropic/claude-haiku-4-5'],
    // Generous ceiling — reasoning models consume output budget for thought.
    maxTokens: 2000,
    temperature: 0,
  },
  tags: ['score', 'evaluation', 'benchmark'],
});
