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

    // This window reached the end, so it already holds every character that is
    // left. Walking on would re-emit the same tail as a run of ever-shorter
    // chunks -- duplicate index entries, each one paid for at the embedding
    // endpoint and each one competing with the others for a result slot.
    if (end >= text.length) break;

    // Advance by (window - overlap), snapping to word boundary. The chunk just
    // emitted reaches `offset + snapped.length`, and the walk may consume the
    // single space that separates it from the next window -- so that, plus one,
    // is the furthest the cursor may legally land.
    const step = Math.max(snapped.length - overlapChars, 1);
    offset += snapStep(text, offset, step, snapped.length + 1);
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
 *  landing on a word boundary.
 *
 *  `limit` is how far the cursor may legally travel: past it, the next window
 *  would start beyond the end of the chunk just emitted and the text in between
 *  would belong to no chunk at all. */
function snapStep(text: string, offset: number, step: number, limit: number): number {
  const target = offset + step;
  if (target >= text.length) return text.length - offset;
  // Look for the next space at/after the target -- but only accept it while it
  // is close enough. The next space after a base64 blob or a minified payload
  // can be thousands of characters away, and snapping to it steps over every
  // one of them: they reach no chunk and cannot be retrieved at any query.
  const nextSpace = text.indexOf(' ', target);
  if (nextSpace >= 0 && nextSpace - offset + 1 <= limit) return nextSpace - offset + 1;
  // No usable boundary: advance by the STEP, never to the end of the text.
  // Jumping to the end here looks like termination and is really data loss --
  // text carrying no ASCII space after the first window (CJK prose, minified
  // JSON, base64, one long URL) would be indexed as that first window alone,
  // with the remainder silently dropped and unretrievable.
  return step;
}
