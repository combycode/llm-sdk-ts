/** moderate() -- one-shot content moderation via OpenAI's moderations API.
 *
 *    const result = await moderate({ input: 'some text' });
 *    if (result.flagged) { ... }
 *
 *  When input is a string or content-part array, a single ModerationResult is
 *  returned. When input is an array of strings (or array of content-part arrays),
 *  one ModerationResult per element is returned (matching array length).
 *
 *  The moderations endpoint is FREE; an honest-zero cost entry is always emitted
 *  so the cost ledger has a record of each call. HTTP flows through engine.fetch. */

import type { CostEntry } from '../bus/hook-map';
import {
  OPENAI_MODERATION_DEFAULT_MODEL,
  OpenAIModerationAdapter,
} from '../llm/providers/openai/moderations';
import type {
  ModerateOptions,
  ModerationContentPart,
  ModerationResult,
} from './moderate-types';
import { resolveModel } from './client-resolver';
import { coreRegistry } from './engine';

const MODERATION_COST_NOTE = 'free: moderations endpoint not billed';
const MODERATION_DEFAULT_PROVIDER = 'openai';

export async function moderate(
  opts: ModerateOptions,
): Promise<ModerationResult | ModerationResult[]> {
  const engine = opts.engine ?? coreRegistry.get();
  const { provider, model } = resolveModel(
    opts.model ?? `${MODERATION_DEFAULT_PROVIDER}/${OPENAI_MODERATION_DEFAULT_MODEL}`,
    opts.provider,
    'moderate',
  );

  if (provider !== 'openai') {
    throw new Error(
      `moderate: provider "${provider}" is not supported. Only "openai" has a public moderations API.`,
    );
  }

  const apiKey = opts.apiKey ?? engine.apiKeys[provider];
  if (!apiKey) {
    throw new Error(
      `moderate: no API key for provider "${provider}". Pass apiKey or set engine.apiKeys["${provider}"].`,
    );
  }

  const adapter = new OpenAIModerationAdapter({ apiKey });
  const { wireInput, returnArray } = buildWireInput(opts.input);
  const results = await adapter.moderate(wireInput, model, engine.fetch);

  emitModerationZero(engine, provider, model);

  return returnArray ? results : (results[0] ?? buildEmptyResult());
}

/** Normalise caller input to the OpenAI wire format and track return shape. */
function buildWireInput(
  input: ModerateOptions['input'],
): {
  wireInput: string | string[] | ModerationContentPart | ModerationContentPart[];
  returnArray: boolean;
} {
  if (typeof input === 'string') {
    return { wireInput: input, returnArray: false };
  }
  if (Array.isArray(input) && input.length > 0) {
    if (typeof input[0] === 'string') {
      return { wireInput: input as string[], returnArray: true };
    }
    const first = input[0];
    if (Array.isArray(first)) {
      const parts = input as ModerationContentPart[][];
      if (parts.length === 1) {
        return { wireInput: parts[0], returnArray: false };
      }
      return { wireInput: parts as unknown as ModerationContentPart[], returnArray: true };
    }
    return { wireInput: input as ModerationContentPart[], returnArray: false };
  }
  return { wireInput: '', returnArray: false };
}

/** Emit an honest-zero cost entry: the moderations endpoint is free. */
function emitModerationZero(engine: ReturnType<typeof coreRegistry.get>, provider: string, model: string): void {
  const cost: CostEntry['cost'] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    source: 'calculated',
  };
  const entry: CostEntry = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    provider,
    model,
    tokens: { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 },
    cost,
    providerEvidence: { note: MODERATION_COST_NOTE },
    tags: { provider, model, type: 'moderation' } as Record<string, string | undefined>,
  };
  engine.hooks.emitSync('onCostEntry', { entry, runningTotal: 0 });
}

function buildEmptyResult(): ModerationResult {
  const falseMap = {} as unknown as ModerationResult['categories'];
  const zeroMap = {} as unknown as ModerationResult['categoryScores'];
  return { flagged: false, categories: falseMap, categoryScores: zeroMap };
}
