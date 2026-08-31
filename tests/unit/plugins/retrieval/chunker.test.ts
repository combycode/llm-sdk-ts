/** chunkText — overlapping windows over a document.
 *
 *  The two properties that make retrieval work, and that a rewrite quietly
 *  breaks:
 *
 *    1. TERMINATION. The step is `max(window - overlap, 1)`; an overlap that
 *       meets or exceeds the window would advance by zero and loop forever.
 *    2. COVERAGE. Every character of the source should appear in at least one
 *       chunk, or the missing text simply cannot be retrieved.
 *
 *  Two cases where the current implementation does NOT hold property 2 are
 *  pinned below under `DEFECT:`. They are recorded as behaviour so a port does
 *  not copy them by accident, and so a fix flips a clearly-labelled test.
 */

import { describe, expect, it } from 'bun:test';
import {
  chunkText,
  DEFAULT_CHUNK_MAX_TOKENS,
  DEFAULT_CHUNK_OVERLAP_TOKENS,
} from '../../../../src/plugins/retrieval/chunker';

/** Space-separated words, so there are word boundaries to snap to. */
function words(count: number, wordLen = 5): string {
  return Array.from({ length: count }, (_, i) => String(i % 10).repeat(wordLen)).join(' ');
}

/** How many non-whitespace characters of the source appear in no chunk at all?
 *  The single separator space between two windows is legitimately consumed by
 *  the walk, so only real content counts. */
function droppedContent(text: string, chunks: Array<{ text: string; offset: number }>): number {
  const seen = new Array<boolean>(text.length).fill(false);
  for (const c of chunks) {
    for (let i = c.offset; i < c.offset + c.text.length && i < text.length; i++) seen[i] = true;
  }
  let dropped = 0;
  for (let i = 0; i < text.length; i++) {
    if (!seen[i] && text[i].trim().length > 0) dropped++;
  }
  return dropped;
}

describe('chunkText — the trivial cases', () => {
  it('empty text produces no chunks at all', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('text that fits in one window is returned whole, as chunk 0 at offset 0', () => {
    expect(chunkText('a short document')).toEqual([
      { text: 'a short document', offset: 0, index: 0 },
    ]);
  });

  it('a document of EXACTLY the window size is still one chunk', () => {
    // 40 characters is exactly 10 tokens at the chars/4 heuristic. An
    // exclusive boundary here would split a document that fits, and the split
    // is invisible until someone counts the index entries.
    const text = `${'a'.repeat(36)} bbb`;
    expect(text).toHaveLength(40);
    expect(chunkText(text, { maxTokens: 10, overlapTokens: 2 })).toEqual([
      { text, offset: 0, index: 0 },
    ]);
    // One token more than the window does split.
    expect(chunkText(`${text}x`, { maxTokens: 10, overlapTokens: 2 }).length).toBeGreaterThan(1);
  });

  it('the fast path is decided by the token estimate, not the character count', () => {
    const text = words(40);
    // A counter that calls everything huge forces the splitting path...
    expect(chunkText(text, { maxTokens: 10 }, () => 999).length).toBeGreaterThan(1);
    // ...and one that calls everything tiny takes the single-chunk path.
    expect(chunkText(text, { maxTokens: 10 }, () => 1)).toHaveLength(1);
  });

  it('the injected estimator is used instead of the built-in chars/4', () => {
    const calls: string[] = [];
    chunkText('some text', { maxTokens: 100 }, (t) => {
      calls.push(t);
      return 1;
    });
    expect(calls).toEqual(['some text']);
  });
});

describe('chunkText — splitting', () => {
  const text = words(400); // ~2400 characters

  it('produces sequential indices starting at 0', () => {
    const chunks = chunkText(text, { maxTokens: 50, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('offsets are strictly increasing — the walk always advances', () => {
    const chunks = chunkText(text, { maxTokens: 50, overlapTokens: 10 });
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].offset).toBeGreaterThan(chunks[i - 1].offset);
    }
  });

  it('every chunk is a verbatim slice of the source at its own offset', () => {
    const chunks = chunkText(text, { maxTokens: 50, overlapTokens: 10 });
    for (const c of chunks) {
      expect(text.slice(c.offset, c.offset + c.text.length)).toBe(c.text);
    }
  });

  it('the chunks together cover every character of the source', () => {
    expect(droppedContent(text, chunkText(text, { maxTokens: 50, overlapTokens: 10 }))).toBe(0);
  });

  it('consecutive chunks overlap, so a phrase on a boundary is still retrievable', () => {
    const chunks = chunkText(text, { maxTokens: 50, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length - 1; i++) {
      const prevEnd = chunks[i - 1].offset + chunks[i - 1].text.length;
      expect(chunks[i].offset).toBeLessThan(prevEnd);
    }
  });

  it('a larger overlap yields more chunks over the same document', () => {
    const few = chunkText(text, { maxTokens: 50, overlapTokens: 5 });
    const many = chunkText(text, { maxTokens: 50, overlapTokens: 30 });
    expect(many.length).toBeGreaterThan(few.length);
    expect(droppedContent(text, many)).toBe(0);
  });

  it('the last chunk ends exactly at the end of the source', () => {
    const chunks = chunkText(text, { maxTokens: 50, overlapTokens: 10 });
    const last = chunks[chunks.length - 1];
    expect(last.offset + last.text.length).toBe(text.length);
    expect(text.endsWith(last.text)).toBe(true);
  });

  it('no chunk ends mid-word: it stops at a space or at the end of the text', () => {
    const chunks = chunkText(text, { maxTokens: 50, overlapTokens: 10 });
    for (const c of chunks) {
      const next = c.offset + c.text.length;
      expect(next === text.length || text[next] === ' ').toBe(true);
    }
  });

  it('every chunk begins at the start of a word', () => {
    const chunks = chunkText(text, { maxTokens: 50, overlapTokens: 10 });
    for (const c of chunks) {
      expect(c.offset === 0 || text[c.offset - 1] === ' ').toBe(true);
    }
  });
});

describe('chunkText — the degenerate inputs that hang a naive implementation', () => {
  it('an overlap equal to the window still terminates and still covers everything', () => {
    const text = words(200);
    const chunks = chunkText(text, { maxTokens: 20, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(droppedContent(text, chunks)).toBe(0);
  });

  it('an overlap LARGER than the window still terminates', () => {
    const text = words(200);
    const chunks = chunkText(text, { maxTokens: 10, overlapTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(droppedContent(text, chunks)).toBe(0);
  });

  it('a zero overlap gives adjacent windows separated only by the joining space', () => {
    const text = words(300);
    const chunks = chunkText(text, { maxTokens: 40, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(droppedContent(text, chunks)).toBe(0);
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = chunks[i - 1].offset + chunks[i - 1].text.length;
      expect(chunks[i].offset).toBe(prevEnd + 1);
    }
  });

  // KNOWN DEFECT (pinned as current behaviour, not endorsed).
  // `snapStep` jumps the cursor to the END of the text when there is no space
  // at or after its target, WITHOUT emitting a chunk for the span it skips. A
  // document with no ASCII space after the first window is therefore silently
  // truncated to that first window: 87% of the text below is never indexed,
  // and the only production symptom is a document that cannot be retrieved
  // past its first page. Affects CJK text, minified JSON, base64 and long URLs.
  it('DEFECT: space-free text is truncated to the first window', () => {
    const text = 'x'.repeat(3000);
    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 10 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toHaveLength(400); // 100 tokens at 4 chars each
    expect(droppedContent(text, chunks)).toBe(2600);
  });

  it('DEFECT: the same truncation hits CJK text, which carries no ASCII spaces', () => {
    const text = '漢'.repeat(3000);
    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 10 });
    expect(chunks).toHaveLength(1);
    expect(droppedContent(text, chunks)).toBe(2600);
  });

  it('a leading space is not itself a usable boundary, so the same truncation applies', () => {
    const text = ` ${'y'.repeat(3000)}`;
    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 10 });
    // No empty chunk is produced: snapToWordBoundary requires lastSpace > 0.
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toHaveLength(400);
  });

  // KNOWN DEFECT (pinned as current behaviour, not endorsed).
  // Once a window reaches the end of the text, `hasMore` is false, so the chunk
  // is the whole remainder and the step shrinks to one word at a time. The tail
  // is re-emitted as a run of ever-shorter chunks that all end at the same
  // place: redundant index entries rather than lost text.
  it('DEFECT: the tail is re-emitted as a run of shrinking duplicate chunks', () => {
    const text = words(400);
    const chunks = chunkText(text, { maxTokens: 50, overlapTokens: 10 });

    const endingAtEnd = chunks.filter((c) => c.offset + c.text.length === text.length);
    expect(endingAtEnd.length).toBeGreaterThan(1);
    for (let i = 1; i < endingAtEnd.length; i++) {
      expect(endingAtEnd[i].text.length).toBeLessThan(endingAtEnd[i - 1].text.length);
      expect(endingAtEnd[i - 1].text.endsWith(endingAtEnd[i].text)).toBe(true);
    }
  });
});

describe('chunkText — defaults', () => {
  it('exports the documented default window and overlap', () => {
    expect(DEFAULT_CHUNK_MAX_TOKENS).toBe(512);
    expect(DEFAULT_CHUNK_OVERLAP_TOKENS).toBe(64);
  });

  it('with no options, a document just under the default window stays one chunk', () => {
    // 512 tokens at the 4-chars-per-token heuristic = 2048 characters.
    expect(chunkText('z'.repeat(2048))).toHaveLength(1);
  });

  it('with no options, a document over the default window is split', () => {
    const text = words(1000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(droppedContent(text, chunks)).toBe(0);
  });
});
