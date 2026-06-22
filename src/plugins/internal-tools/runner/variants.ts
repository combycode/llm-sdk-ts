/** Prompt variant system — one tool, many prompts. Matched by mode, provider, or model. */

import type { JsonSchema } from '../../../llm/types/tools';
import type { ResolveMaxTokensContext } from './types';

export interface PromptVariant {
  /** Unique identifier within a tool. Conventions: "default", "strict", "for-haiku", "tool-mode". */
  id: string;
  description?: string;

  systemPrompt: string;
  userTemplate: string;
  outputExample?: unknown;
  outputSchema?: JsonSchema;
  resolveMaxTokens?: (input: Record<string, unknown>, ctx: ResolveMaxTokensContext) => number;

  modes?: string[];
  supportedProviders?: string[];
  supportedModels?: string[];
  isDefault?: boolean;
}

export interface VariantSelectorContext {
  provider: string;
  model: string;
  mode?: string;
}

/**
 * Pick the best-matching variant for the given context.
 *
 * Priority (most-specific wins):
 *   1. mode + supportedModels match
 *   2. mode + supportedProviders match
 *   3. mode + isDefault within mode filter
 *   4. no mode + supportedModels match
 *   5. no mode + supportedProviders match
 *   6. global isDefault
 */
export function selectVariant(
  variants: PromptVariant[],
  ctx: VariantSelectorContext,
): PromptVariant {
  if (variants.length === 0) {
    throw new Error('selectVariant: variants array is empty');
  }

  const fullModelId = `${ctx.provider}/${ctx.model}`;

  const modeMatches = ctx.mode ? variants.filter((v) => v.modes?.includes(ctx.mode!)) : null;

  const candidates = modeMatches ?? variants;

  const byModel = candidates.find((v) => v.supportedModels?.includes(fullModelId));
  if (byModel) return byModel;

  const byProvider = candidates.find((v) => v.supportedProviders?.includes(ctx.provider));
  if (byProvider) return byProvider;

  const modeDefault = candidates.find((v) => v.isDefault);
  if (modeDefault) return modeDefault;

  if (modeMatches && modeMatches.length > 0) {
    return modeMatches[0];
  }

  const globalDefault = variants.find((v) => v.isDefault);
  if (globalDefault) return globalDefault;

  throw new Error(
    'selectVariant: no match and no default variant. ' +
      `Tried mode="${ctx.mode ?? ''}", provider="${ctx.provider}", model="${ctx.model}". ` +
      `Variants: [${variants.map((v) => v.id).join(', ')}]`,
  );
}
