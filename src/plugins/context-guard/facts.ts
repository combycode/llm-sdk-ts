/** ExtractedFact — universal fact shape used by ContextGuard's strategies.
 *  Producers (fact-extract tools, memory tools, custom extractors) emit facts
 *  in this shape; consumers (renderFactsLayer, snapshots) read them. */

export const FACT_CATEGORIES = [
  'name',
  'date',
  'time',
  'path',
  'url',
  'email',
  'phone',
  'address',
  'amount',
  'number',
  'identifier',
  'other',
] as const;

export type FactCategory = (typeof FACT_CATEGORIES)[number];

/** Narrow a parsed category to the union, falling back to `other`.
 *
 *  Categories are read back out of a system prompt or off a fact-extract tool's
 *  JSON, so the string is model-influenced rather than ours. Casting it into
 *  `FactCategory` would type a value the union does not contain, and every
 *  consumer that switches on the category would then meet a branch it was
 *  compiled believing could not happen. `other` is the union's catch-all and is
 *  what an unrecognised category means. */
export function toFactCategory(raw: string): FactCategory {
  return (FACT_CATEGORIES as readonly string[]).includes(raw) ? (raw as FactCategory) : 'other';
}

export interface ExtractedFact {
  /** Short descriptive label. Lowercase, snake_or_dotted notation. */
  key: string;
  /** Fact value — verbatim from source for verifiability. */
  value: string;
  category: FactCategory;
  /** Optional surrounding context for ambiguous values. */
  span?: string;
}
