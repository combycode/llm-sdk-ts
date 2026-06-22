/** orxa:summarize@1.0.0 — compact long content while preserving key facts.
 *  Uses provider-specific variants because strict fact-preservation helps
 *  Haiku and Flash-Lite (they over-paraphrase by default) but hurts Nano
 *  (which becomes too literal and fails to compress). */

import { defineLLMTool } from '../runner/define';
import type { InternalTool } from '../types';
import type { PromptVariant } from '../runner/variants';

export interface SummarizeInput {
  content: string;
  /** Target max characters for the summary text. Converted to max_tokens via catalog ratio. */
  maxLength?: number;
  /** Target max tokens for the LLM response. Takes precedence over maxLength. */
  maxTokens?: number;
  /** Optional focus for the summary (narrows the content angle). */
  focus?: string;
}

export interface SummarizeOutput {
  summary: string;
  keyPoints: string[];
}

const sharedOutputExample = {
  summary:
    'MIT researchers built a lithium-sulfur battery charging in 5 minutes, lasting 1000+ cycles.',
  keyPoints: ['5-minute charge time', '1000+ cycle lifespan', 'Lithium-sulfur chemistry'],
};

const sharedUserTemplate = `Summarize the following content.

{{lengthLine}}
{{focusLine}}

Content:
{{content}}`;

const strictSystem = `You are a summarization tool. Follow these rules strictly:

1. OUTPUT OBJECT: Return exactly one JSON object with exactly two fields: "summary" (string) and "keyPoints" (array of strings). NO markdown, NO prose around the JSON.
2. FACT PRESERVATION: preserve every date, name, path, number, unit, quoted term, and ID EXACTLY as written in the source. Do NOT normalize, round, paraphrase, or substitute them.
3. NO INFERENCE: "summary" and "keyPoints" items MUST contain only claims explicitly in the source. Do NOT strengthen, broaden, soften, or generalize.
4. FOCUS SCOPING: if a focus is provided, BOTH "summary" AND every item in "keyPoints" MUST cover ONLY facts directly relevant to that focus. Exclude unrelated facts entirely.
5. COVERAGE (no focus): "summary" captures the main result plus the most decision-relevant qualifier or limitation. "keyPoints" covers the main result plus supporting facts and any explicit caveat, constraint, or blocker stated in the source.
6. LENGTH: "summary" MUST stay under the provided limit. Treat the limit as HARD — stop short rather than overshoot. Target 10-15% under the limit as safety margin.
7. "keyPoints" ITEMS: each is a short string with one fact or a tightly-related cluster. Copy exact wording where possible.
8. NO INVENTION: if the source lacks detail, return a smaller "keyPoints" array. NEVER invent facts.
9. NEGATIVE EXAMPLES: do NOT rewrite "over 1000 cycles" as "1000+ cycles". Do NOT rewrite "Scientists at MIT" as "MIT scientists". Do NOT omit an explicit limitation when it's a main qualifier.`;

const balancedSystem = `You are a summarizer. Follow these rules:

1. OUTPUT: Return exactly one JSON object with "summary" (string) and "keyPoints" (array of strings). No markdown.
2. PRESERVE KEY FACTS: keep exact dates, names, paths, numbers, units, and IDs verbatim. You may paraphrase surrounding narrative.
3. FOCUS SCOPING (HARD BINDING RULE): when a focus is provided, treat it as an allow-list. ONLY facts that are literally about the focus keywords may appear in "summary" or "keyPoints". Everything else — error codes, status codes, pagination, metrics, ports, unrelated features — MUST be EXCLUDED, even if the source mentions them.
   Procedure for "keyPoints":
     (a) List every candidate fact from the source.
     (b) For each, ask: does this fact DIRECTLY describe {focus}? If it merely COEXISTS in the source, EXCLUDE it.
     (c) Keep only the facts that pass (b). A 2-item array is correct if only 2 facts match the focus.
   A keyPoints item that mentions ANYTHING outside the focus is a RULE VIOLATION — drop it entirely rather than trim it.
4. COVERAGE (no focus only): capture the main result and include any important explicit caveat or limitation from the source.
5. LENGTH: stay at or under the requested limit — treat it as a ceiling, not a target.
6. NO INVENTION: every fact must come from the source.`;

const variants: PromptVariant[] = [
  {
    id: 'strict',
    description:
      'Very strict fact preservation — for models that over-paraphrase (Haiku, Flash-Lite).',
    supportedProviders: ['anthropic', 'google'],
    systemPrompt: strictSystem,
    userTemplate:
      sharedUserTemplate +
      `

Final checks before answering:
1. "summary" stays under the limit (target 10-15% under).
2. Every included fact with a date, name, path, number, unit, or ID matches the source exactly.
3. "keyPoints" contains only supported facts.
4. If the source includes an important explicit limitation or blocker, it's included (unless excluded by focus).`,
    outputExample: sharedOutputExample,
  },
  {
    id: 'balanced',
    description:
      'Balanced compression — default for OpenAI and other providers that summarize well.',
    isDefault: true,
    systemPrompt: balancedSystem,
    userTemplate: sharedUserTemplate,
    outputExample: sharedOutputExample,
  },
];

export const summarizeTool: InternalTool = defineLLMTool({
  id: 'orxa:summarize@1.0.0',
  namespace: 'orxa',
  name: 'summarize',
  version: '1.0.0',
  description:
    'Summarize long content while preserving key facts verbatim. maxLength (chars) or maxTokens (tokens) constrains size.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Text to summarize' },
      maxLength: { type: 'integer', minimum: 20, description: 'Max characters for summary text' },
      maxTokens: {
        type: 'integer',
        minimum: 20,
        description: 'Max tokens for the response (takes precedence over maxLength)',
      },
      focus: { type: 'string', description: 'Optional focus area', default: '' },
    },
    required: ['content'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      keyPoints: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'keyPoints'],
  },
  outputFormat: 'json',
  variants,
  prepareInput: (input) => {
    const maxLength = input.maxLength as number | undefined;
    const maxTokens = input.maxTokens as number | undefined;
    const focus = input.focus as string | undefined;
    const lengthLine = maxLength
      ? `Length target: keep the summary under ${maxLength} characters.`
      : maxTokens
        ? `Length target: keep the summary under ${maxTokens} tokens.`
        : 'Length target: concise (one or two sentences).';
    const focusLine = focus ? `Focus: ${focus}` : '';
    return { ...input, lengthLine, focusLine };
  },
  resolveMaxTokens: (input, ctx) => {
    const maxTokens = input.maxTokens as number | undefined;
    if (typeof maxTokens === 'number' && maxTokens > 0) return maxTokens;
    const maxLength = input.maxLength as number | undefined;
    if (typeof maxLength === 'number' && maxLength > 0) {
      const summaryTokens = ctx.counter.estimate('x'.repeat(maxLength), {
        provider: ctx.provider,
        model: ctx.model,
      });
      return Math.ceil(summaryTokens * 1.6) + 400;
    }
    return 800;
  },
  modelPreference: {
    preferredModel: 'openai/gpt-5.4-nano',
    fallbackModels: ['google/gemini-3.1-flash-lite-preview', 'anthropic/claude-haiku-4-5'],
    maxTokens: 800,
    temperature: 0.3,
  },
  recommendedThreshold: 95,
  tags: ['summarize', 'compaction', 'text'],
});
