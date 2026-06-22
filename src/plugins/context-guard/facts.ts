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

export interface ExtractedFact {
  /** Short descriptive label. Lowercase, snake_or_dotted notation. */
  key: string;
  /** Fact value — verbatim from source for verifiability. */
  value: string;
  category: FactCategory;
  /** Optional surrounding context for ambiguous values. */
  span?: string;
}
