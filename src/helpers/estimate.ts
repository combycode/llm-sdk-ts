/** estimate() — pure, pre-flight cost estimation. Sends nothing to the
 *  network.  Counts input tokens via the existing HybridTokenCounter (which
 *  falls back to a heuristic when tiktoken is absent), then prices using the
 *  ModelCatalog exactly as CostCollector does at runtime.
 *
 *    const est = await estimate({
 *      model: 'anthropic/claude-haiku-4-5',
 *      prompt: 'Hello',
 *    });
 *    // est.cost.expected  — mid-range cost in USD
 *    // est.cost.high      — worst-case (output = maxOutput cap)
 */

import type { ContentPart, Message } from '../llm/types/messages';
import type { ProviderName } from '../llm/types/provider';
import type { ModelPricing } from '../plugins/model-catalog/catalog';
import { HybridTokenCounter } from '../plugins/context-measurer/counter/hybrid';
import { resolveModel } from './client-resolver';
import { coreRegistry, type EngineHandle } from './engine';
import {
  DEFAULT_EXPECTED_OUTPUT_TOKENS,
  FALLBACK_MAX_OUTPUT_TOKENS,
  UnknownModelError,
} from './estimate-types';
import type { EstimateResult } from './estimate-types';

// ─── Public request shape (same fields complete() understands) ───────────────

export interface EstimateRequest {
  /** Model string: bare (`gpt-5.4-nano` + `provider`) or namespaced
   *  (`openai/gpt-5.4-nano`). */
  model: string;
  /** Required when `model` is bare. */
  provider?: ProviderName;
  /** Either a string prompt, an array of content parts, or a messages array.
   *  Matches the `prompt` field on `CompleteOptions`. */
  prompt: string | ContentPart[] | Message[];
  /** Optional system prompt — included in input-token count. */
  system?: string;
  /** Hard limit on output tokens (used for the `high` bound). */
  maxTokens?: number;
}

export interface EstimateOptions {
  /** Override the model (else taken from `request.model`). */
  model?: string;
  /** Caller's guess for the expected output token count. When absent, the
   *  helper uses `DEFAULT_EXPECTED_OUTPUT_TOKENS` and notes it in
   *  `assumptions`. */
  expectedOutputTokens?: number;
  /** Optional engine for catalog + api-key access. Falls back to coreRegistry. */
  engine?: EngineHandle;
}

// ─── Core implementation ─────────────────────────────────────────────────────

/** Pre-flight cost estimate.  Pure — touches no network, no LLM provider.
 *
 *  Throws `UnknownModelError` when the model is absent from the catalog
 *  (so callers never silently get $0 instead of a real estimate). */
export async function estimate(
  request: EstimateRequest,
  opts: EstimateOptions = {},
): Promise<EstimateResult> {
  const engine = opts.engine ?? coreRegistry.get();
  const modelStr = opts.model ?? request.model;
  const { provider, model } = resolveModel(modelStr, request.provider, 'estimate');

  const pricing = engine.catalog.getPricing(provider, model);
  if (!pricing) {
    throw new UnknownModelError(provider, model);
  }

  const assumptions: string[] = [];

  // ─── Count input tokens ───────────────────────────────────────────────────
  const counter = new HybridTokenCounter({ catalog: engine.catalog, countApiKeys: {} });
  const tokenCtx = { provider, model };

  const inputTokens = await countInputTokens(counter, tokenCtx, request, assumptions);

  // ─── Price image and audio content parts ──────────────────────────────────
  const { imageUsd, audioUsd } = priceMediaParts(request.prompt, pricing, provider, model, assumptions);

  // ─── Resolve output-token bounds ──────────────────────────────────────────
  const estOutputTokens = resolveExpectedOutput(
    opts.expectedOutputTokens,
    request.maxTokens,
    assumptions,
  );

  const highOutputTokens = resolveHighOutput(
    request.maxTokens,
    engine.catalog.get(provider, model)?.maxOutput,
    assumptions,
  );

  // ─── Price each bound ─────────────────────────────────────────────────────
  const inputRate = pricing.inputPerMTok ?? 0;
  const outputRate = pricing.outputPerMTok ?? 0;

  const inputUsd = (inputTokens / 1_000_000) * inputRate;
  const mediaUsd = imageUsd + audioUsd;
  const lowUsd = inputUsd + mediaUsd; // 0 output tokens
  const expectedOutputUsd = (estOutputTokens / 1_000_000) * outputRate;
  const highOutputUsd = (highOutputTokens / 1_000_000) * outputRate;

  return {
    model: `${provider}/${model}`,
    inputTokens,
    estOutputTokens,
    cost: {
      low: lowUsd,
      expected: inputUsd + mediaUsd + expectedOutputUsd,
      high: inputUsd + mediaUsd + highOutputUsd,
    },
    breakdown: {
      inputUsd,
      outputUsd: expectedOutputUsd,
      imageUsd: imageUsd > 0 ? imageUsd : undefined,
      audioUsd: audioUsd > 0 ? audioUsd : undefined,
    },
    currency: 'USD',
    assumptions,
  };
}

// ─── Private helpers ─────────────────────────────────────────────────────────

async function countInputTokens(
  counter: HybridTokenCounter,
  tokenCtx: { provider: string; model: string },
  request: EstimateRequest,
  assumptions: string[],
): Promise<number> {
  let total = 0;

  if (request.system) {
    total += counter.estimate(request.system, tokenCtx);
  }

  const input = request.prompt;
  if (typeof input === 'string') {
    total += counter.estimate(input, tokenCtx);
  } else if (Array.isArray(input) && input.length > 0) {
    if ('role' in (input[0] as object)) {
      // Message[]
      for (const m of input as Message[]) {
        total += counter.estimateMessage(m, tokenCtx);
      }
    } else {
      // ContentPart[]
      for (const part of input as ContentPart[]) {
        total += counter.estimateMessage({ role: 'user', content: [part] }, tokenCtx);
      }
    }
  }

  assumptions.push('no local tokenizer: heuristic used for input token count');
  return total;
}

function resolveExpectedOutput(
  callerGuess: number | undefined,
  maxTokens: number | undefined,
  assumptions: string[],
): number {
  if (callerGuess !== undefined) {
    return callerGuess;
  }
  if (maxTokens !== undefined && maxTokens < DEFAULT_EXPECTED_OUTPUT_TOKENS) {
    assumptions.push(`output bounded by maxTokens=${maxTokens} (used as expected)`);
    return maxTokens;
  }
  assumptions.push(
    `expected output tokens defaulted to DEFAULT_EXPECTED_OUTPUT_TOKENS=${DEFAULT_EXPECTED_OUTPUT_TOKENS}`,
  );
  return DEFAULT_EXPECTED_OUTPUT_TOKENS;
}

function resolveHighOutput(
  maxTokens: number | undefined,
  catalogMaxOutput: number | undefined,
  assumptions: string[],
): number {
  if (maxTokens !== undefined) {
    assumptions.push(`high bound: output capped at request maxTokens=${maxTokens}`);
    return maxTokens;
  }
  if (catalogMaxOutput !== undefined) {
    assumptions.push(`high bound: output capped at catalog maxOutput=${catalogMaxOutput}`);
    return catalogMaxOutput;
  }
  assumptions.push(
    `high bound: catalog maxOutput unknown, using FALLBACK_MAX_OUTPUT_TOKENS=${FALLBACK_MAX_OUTPUT_TOKENS}`,
  );
  return FALLBACK_MAX_OUTPUT_TOKENS;
}

/** Collect all ContentParts from a prompt (string, ContentPart[], or Message[]). */
function collectContentParts(prompt: string | ContentPart[] | Message[]): ContentPart[] {
  if (typeof prompt === 'string') return [];
  if (Array.isArray(prompt) && prompt.length > 0 && 'role' in (prompt[0] as object)) {
    const parts: ContentPart[] = [];
    for (const m of prompt as Message[]) {
      if (Array.isArray(m.content)) parts.push(...(m.content as ContentPart[]));
    }
    return parts;
  }
  return prompt as ContentPart[];
}

/** Price image and audio parts in the prompt using the SAME catalog rates the
 *  cost-collector uses at runtime (perImage for images; audioInputPerMTok for
 *  audio parts where duration is unknown so we fall back to the text token rate
 *  and note the assumption). */
function priceMediaParts(
  prompt: string | ContentPart[] | Message[],
  pricing: ModelPricing,
  provider: string,
  model: string,
  assumptions: string[],
): { imageUsd: number; audioUsd: number } {
  const parts = collectContentParts(prompt);
  let imageUsd = 0;
  const audioUsd = 0;
  let imageCount = 0;
  let audioCount = 0;

  for (const part of parts) {
    if (part.type === 'image') {
      imageCount++;
      if (pricing.perImage != null) {
        imageUsd += pricing.perImage;
      }
    } else if (part.type === 'audio') {
      audioCount++;
      // Audio input parts: price at audioInputPerMTok if available.
      // Duration is unknown at estimation time — we cannot price accurately;
      // note this as an assumption.
    }
  }

  if (imageCount > 0) {
    if (pricing.perImage != null) {
      assumptions.push(`${imageCount} image part(s) priced at perImage=$${pricing.perImage} each`);
    } else {
      assumptions.push(
        `${imageCount} image part(s) present but unpriced: no perImage rate for ${provider}/${model}`,
      );
    }
  }

  if (audioCount > 0) {
    // Audio input parts in a chat request are priced per token (audioInputPerMTok),
    // but token count requires decoding. Duration is not known at estimation time.
    // Emit a note rather than silently dropping. audioUsd stays 0.
    assumptions.push(
      `${audioCount} audio part(s) present but unpriced: audio token count requires runtime data`,
    );
  }

  return { imageUsd, audioUsd };
}
