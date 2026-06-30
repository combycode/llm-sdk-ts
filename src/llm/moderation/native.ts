/** Native OpenAI inline-moderation wire helpers.
 *
 *  buildNativeModeration → the `moderation` request field OpenAI accepts on both
 *  the Responses API and Chat Completions.
 *
 *  parseNativeModeration → reads the `moderation` field OpenAI returns. Handles
 *  BOTH wire shapes:
 *    - Responses API:      moderation.{input,output} = moderation_result | error
 *    - Chat Completions:   moderation.{input,output} = moderation_results | error,
 *                          where moderation_results wraps `results: [moderation_result]`. */

import type {
  ModerationCategories,
  ModerationResult,
  ModerationScores,
} from '../../helpers/moderate-types';
import type { ModerationEntry, ModerationReport, ModerationRequest } from './types';
import { MODERATION_DEFAULT_MODEL } from './types';

/** The `moderation` request field for the OpenAI native path. */
export function buildNativeModeration(mod: ModerationRequest): { model: string } {
  return { model: mod.model ?? MODERATION_DEFAULT_MODEL };
}

/** Parse OpenAI's returned `moderation` object into a unified report, or undefined
 *  when the server returned nothing usable. */
export function parseNativeModeration(raw: unknown): ModerationReport | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  const input = parseEntry(m.input);
  const output = parseEntry(m.output);
  if (!input && !output) return undefined;
  return {
    source: 'native',
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
  };
}

function parseEntry(entry: unknown): ModerationEntry | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const e = entry as Record<string, unknown>;
  if (e.type === 'error') {
    return { error: String(e.message ?? e.code ?? 'moderation error') };
  }
  // Chat Completions wraps the result(s) in a `moderation_results` envelope.
  if (e.type === 'moderation_results' && Array.isArray(e.results)) {
    const first = e.results[0] as Record<string, unknown> | undefined;
    return first ? toResult(first) : undefined;
  }
  // Responses API returns the `moderation_result` directly.
  if (e.type === 'moderation_result' || e.categories) {
    return toResult(e);
  }
  return undefined;
}

function toResult(r: Record<string, unknown>): ModerationResult {
  return {
    flagged: Boolean(r.flagged),
    categories: (r.categories ?? {}) as unknown as ModerationCategories,
    categoryScores: (r.category_scores ?? {}) as unknown as ModerationScores,
    categoryAppliedInputTypes: r.category_applied_input_types as
      | Record<string, string[]>
      | undefined,
  };
}
