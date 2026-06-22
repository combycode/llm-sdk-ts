/** orxa:clarify@1.0.0 — validate prompt against requirements, produce questions for gaps. */

import { defineLLMTool } from '../runner/define';
import { formatBulletedList } from '../runner/template';
import type { InternalTool } from '../types';

export interface ClarifyInput {
  prompt: string;
  requirements: string[];
}

export interface ClarifyOutput {
  satisfied: boolean;
  missingRequirements: string[];
  clarificationQuestions: string[];
}

export const clarifyTool: InternalTool = defineLLMTool({
  id: 'orxa:clarify@1.0.0',
  namespace: 'orxa',
  name: 'clarify',
  version: '1.0.0',
  description:
    'Validate whether a prompt meets given requirements; produce clarifying questions for gaps',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      requirements: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
    required: ['prompt', 'requirements'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      satisfied: { type: 'boolean' },
      missingRequirements: { type: 'array', items: { type: 'string' } },
      clarificationQuestions: { type: 'array', items: { type: 'string' } },
    },
    required: ['satisfied', 'missingRequirements', 'clarificationQuestions'],
  },
  systemPrompt:
    'You validate prompts against requirements. Be strict — only mark satisfied=true if EVERY requirement is addressed in the prompt.',
  userTemplate: `Check if the following prompt satisfies all the listed requirements.

Prompt:
{{prompt}}

Requirements:
{{requirementsList}}

Return a JSON object with:
- satisfied: boolean indicating if all requirements are met
- missingRequirements: array of requirements that are not satisfied (empty if all met)
- clarificationQuestions: array of questions to ask to gather missing information`,
  outputFormat: 'json',
  prepareInput: (input) => ({
    ...input,
    requirementsList: formatBulletedList((input.requirements as string[]) ?? []),
  }),
  modelPreference: {
    preferredModel: 'openai/gpt-5.4-nano',
    fallbackModels: ['google/gemini-3.1-flash-lite-preview', 'anthropic/claude-haiku-4-5'],
    maxTokens: 500,
    temperature: 0.2,
  },
  tags: ['clarify', 'validation', 'requirements'],
});
