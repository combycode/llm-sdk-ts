/** orxa:classify@1.0.0 — select best match from suggestions with confidence. */

import { defineLLMTool } from '../runner/define';
import { formatNumberedList } from '../runner/template';
import type { InternalTool } from '../types';

export interface ClassifyInput {
  request: string;
  suggestions: string[];
}

export interface ClassifyOutput {
  selectedIndex: number;
  confidence: number;
  reasoning: string;
}

export const classifyTool: InternalTool = defineLLMTool({
  id: 'orxa:classify@1.0.0',
  namespace: 'orxa',
  name: 'classify',
  version: '1.0.0',
  description: 'Select the most relevant suggestion from a list, with confidence score',
  inputSchema: {
    type: 'object',
    properties: {
      request: { type: 'string' },
      suggestions: { type: 'array', items: { type: 'string' }, minItems: 1 },
    },
    required: ['request', 'suggestions'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      selectedIndex: { type: 'integer', minimum: 0 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reasoning: { type: 'string' },
    },
    required: ['selectedIndex', 'confidence', 'reasoning'],
  },
  systemPrompt:
    'You are a deterministic classifier. Given a request and a list of suggestions, pick the single best match.',
  userTemplate: `Given the request: "{{request}}"

Select the most relevant option from the following:
{{suggestionsList}}

Return a JSON object with:
- selectedIndex: the 0-based index of the best match
- confidence: a number from 0 to 1 indicating confidence
- reasoning: a brief explanation of why this option was selected`,
  outputFormat: 'json',
  prepareInput: (input) => ({
    ...input,
    suggestionsList: formatNumberedList((input.suggestions as string[]) ?? [], 0),
  }),
  modelPreference: {
    preferredModel: 'openai/gpt-5.4-nano',
    fallbackModels: ['google/gemini-3.1-flash-lite-preview', 'anthropic/claude-haiku-4-5'],
    maxTokens: 300,
    temperature: 0,
  },
  tags: ['classify', 'routing', 'fast'],
});
