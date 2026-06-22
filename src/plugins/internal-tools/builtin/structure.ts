/** orxa:structure@1.0.0 — extract structured JSON from unstructured text per schema. */

import { defineLLMTool } from '../runner/define';
import type { InternalTool } from '../types';
import type { JsonSchema } from '../../../llm/types/tools';

export interface StructureInput {
  request: string;
  schema: JsonSchema;
}

export interface StructureOutput {
  [key: string]: unknown;
}

export const structureTool: InternalTool = defineLLMTool({
  id: 'orxa:structure@1.0.0',
  namespace: 'orxa',
  name: 'structure',
  version: '1.0.0',
  description: 'Transform unstructured request into structured JSON matching a given schema',
  inputSchema: {
    type: 'object',
    properties: {
      request: { type: 'string', description: 'Unstructured text to parse' },
      schema: { type: 'object', description: 'Target JSON Schema the output must match' },
    },
    required: ['request', 'schema'],
  },
  systemPrompt:
    'You extract structured data from text. Your output must be valid JSON matching the target schema exactly — no extra fields, no missing required fields.',
  userTemplate: `Parse the following request into structured data matching the given schema.

Request: {{request}}

Target JSON Schema:
{{schema}}

Return a valid JSON object matching the schema exactly.`,
  outputFormat: 'json',
  prepareInput: (input) => ({
    ...input,
    schema: JSON.stringify(input.schema, null, 2),
  }),
  modelPreference: {
    preferredModel: 'openai/gpt-5.4-nano',
    fallbackModels: ['google/gemini-3.1-flash-lite-preview', 'anthropic/claude-haiku-4-5'],
    maxTokens: 600,
    temperature: 0,
  },
  tags: ['structure', 'json', 'parsing', 'extraction'],
});
