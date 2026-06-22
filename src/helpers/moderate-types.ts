/** Types for the moderate() helper and the OpenAI Moderations API. */

import type { ProviderName } from '../llm/types/provider';
import type { EngineHandle } from './engine';

// ─── Public API types ─────────────────────────────────────────────────────────

/** Boolean flags per harm category. */
export interface ModerationCategories {
  harassment: boolean;
  'harassment/threatening': boolean;
  hate: boolean;
  'hate/threatening': boolean;
  illicit: boolean;
  'illicit/violent': boolean;
  'self-harm': boolean;
  'self-harm/intent': boolean;
  'self-harm/instructions': boolean;
  'sexual': boolean;
  'sexual/minors': boolean;
  violence: boolean;
  'violence/graphic': boolean;
}

/** Confidence scores (0-1) per harm category -- parallel shape to ModerationCategories. */
export type ModerationScores = Record<keyof ModerationCategories, number>;

/** One item's moderation result (one per input element). */
export interface ModerationResult {
  /** True when any category was triggered. */
  flagged: boolean;
  /** Per-category boolean flags. */
  categories: ModerationCategories;
  /** Per-category confidence scores (0-1). */
  categoryScores: ModerationScores;
  /** Input types the moderation was applied to, per category (omni models only). */
  categoryAppliedInputTypes?: Record<string, string[]>;
}

/** A text content part for multimodal moderation input. */
export interface ModerationTextPart {
  type: 'text';
  text: string;
}

/** An image URL content part for multimodal moderation input. */
export interface ModerationImageUrlPart {
  type: 'image_url';
  image_url: { url: string };
}

/** A single content part: text or image_url. */
export type ModerationContentPart = ModerationTextPart | ModerationImageUrlPart;

/** Options for the moderate() helper. */
export interface ModerateOptions {
  /**
   * Input to moderate. One of:
   *   - a single string (returns a single ModerationResult)
   *   - an array of strings (returns one result per string)
   *   - a single content-part array (text + image_url, returns a single ModerationResult)
   *   - an array of content-part arrays (one per item, returns one result per array)
   */
  input: string | string[] | ModerationContentPart[] | ModerationContentPart[][];
  /** Model name. Defaults to omni-moderation-latest. */
  model?: string;
  provider?: ProviderName;
  apiKey?: string;
  engine?: EngineHandle;
}

// ─── Internal wire types (raw OpenAI response shapes) ────────────────────────

export interface ModerationRawResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  category_scores: Record<string, number>;
  category_applied_input_types?: Record<string, string[]>;
}

export interface ModerationRawResponse {
  id: string;
  model: string;
  results: ModerationRawResult[];
}
