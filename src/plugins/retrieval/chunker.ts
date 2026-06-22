/** Text chunker — splits text into overlapping windows of approximate token size.
 *
 *  Uses a character-based approximation for token counting (no external dep,
 *  works in the browser). The `countTokensFn` injection point lets callers
 *  swap in a more accurate counter without changing the chunker contract.
 *
 *  Named constants govern all defaults — no magic values. */

// ─── Named constants ──────────────────────────────────────────────────────────

/** Default maximum chunk size in tokens (approximate). */
export const DEFAULT_CHUNK_MAX_TOKENS = 512;

/** Default overlap between consecutive chunks in tokens. */
export const DEFAULT_CHUNK_OVERLAP_TOKENS = 64;

/** Characters-per-token heuristic used when no external counter is injected. */
const CHARS_PER_TOKEN_HEURISTIC = 4;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

export interface TextChunk {
  /** The chunk content. */
  text: string;
  /** Byte offset of the chunk start in the source text. */
  offset: number;
  /** 0-based chunk index within the document. */
  index: number;
}

/** Optional injected token counter (synchronous estimate only; no I/O path). */
export type EstimateTokensFn = (text: string) => number;

// ─── Chunker ─────────────────────────────────────────────────────────────────

/** Split `text` into overlapping windows based on approximate token count.
 *  Splits on whitespace boundaries to avoid cutting words mid-token. */
export function chunkText(
  text: string,
  opts: ChunkOptions = {},
  estimateTokens?: EstimateTokensFn,
): TextChunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_CHUNK_MAX_TOKENS;
  const overlapTokens = opts.overlapTokens ?? DEFAULT_CHUNK_OVERLAP_TOKENS;
  const estimate = estimateTokens ?? defaultEstimate;

  const maxChars = maxTokens * CHARS_PER_TOKEN_HEURISTIC;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN_HEURISTIC;

  if (text.length === 0) return [];

  // Fast path: text fits in one chunk
  if (estimate(text) <= maxTokens) {
    return [{ text, offset: 0, index: 0 }];
  }

  const chunks: TextChunk[] = [];
  let offset = 0;
  let index = 0;

  while (offset < text.length) {
    const end = Math.min(offset + maxChars, text.length);
    const raw = text.slice(offset, end);

    // Snap to a word boundary (find last whitespace before end)
    const snapped = snapToWordBoundary(raw, end < text.length);
    chunks.push({ text: snapped, offset, index });

    // Advance by (window - overlap), snapping to word boundary
    const step = Math.max(snapped.length - overlapChars, 1);
    offset += snapStep(text, offset, step);
    index++;
  }

  return chunks;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function defaultEstimate(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_HEURISTIC);
}

/** Trim `raw` to the last whitespace boundary when it is not the final chunk. */
function snapToWordBoundary(raw: string, hasMore: boolean): string {
  if (!hasMore) return raw;
  const lastSpace = raw.lastIndexOf(' ');
  if (lastSpace > 0) return raw.slice(0, lastSpace);
  return raw;
}

/** Find the number of characters to advance from `offset` by approx `step` chars,
 *  landing on a word boundary. */
function snapStep(text: string, offset: number, step: number): number {
  const target = offset + step;
  if (target >= text.length) return text.length - offset;
  // Look for the next space at/after the target
  const nextSpace = text.indexOf(' ', target);
  if (nextSpace >= 0) return nextSpace - offset + 1;
  return text.length - offset;
}
