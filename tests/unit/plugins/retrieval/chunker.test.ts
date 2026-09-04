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
 *  Property 2 used to hold only for text that HAS spaces in it, and the tail of
 *  every document was emitted several times over. Both were pinned here as
 *  `DEFECT:` and both are now fixed; the tests that pinned them are still here,
 *  inverted, under `Regression:`.
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

  // Regression. `snapStep` used to jump the cursor to the END of the text when
  // there was no space at or after its target, WITHOUT emitting a chunk for the
  // span it skipped, so a document with no ASCII space after the first window
  // was silently truncated to that window -- 87% of the text below went
  // unindexed, and the only production symptom was a document that could not be
  // retrieved past its first page.
  it('Regression: space-free text is windowed to the end, not truncated', () => {
    const text = 'x'.repeat(3000);
    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 10 });

    expect(chunks).toHaveLength(9);
    expect(chunks[0].text).toHaveLength(400); // 100 tokens at 4 chars each
    expect(droppedContent(text, chunks)).toBe(0);
    const last = chunks[chunks.length - 1];
    expect(last.offset + last.text.length).toBe(text.length);
  });

  it('Regression: CJK text, which carries no ASCII spaces, is covered too', () => {
    const text = '漢'.repeat(3000);
    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 10 });
    expect(chunks).toHaveLength(9);
    expect(droppedContent(text, chunks)).toBe(0);
  });

  it('Regression: a document that turns space-free part way through keeps its tail', () => {
    // The realistic shape of that truncation: prose, then an embedded base64
    // image or a minified payload. Everything past the last space was dropped.
    const text = `${words(50)} ${'q'.repeat(2000)}`;
    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 10 });

    expect(droppedContent(text, chunks)).toBe(0);
    expect(chunks.some((c) => c.text.includes('q'.repeat(400)))).toBe(true);
  });

  // Regression, and the harder half of the same defect: when the space-free run
  // is in the MIDDLE, `text.indexOf(' ', target)` still finds a space -- the one
  // on the far side of the blob, thousands of characters away -- and snapping to
  // it steps over the whole blob. A README with one embedded base64 image lost
  // 17983 of its 26991 characters this way, and the first fix, which only
  // covered "no further space at all", did not touch this case.
  it('Regression: a space-free run in the MIDDLE of a document is not stepped over', () => {
    const blob = 'Q'.repeat(20000);
    const text = `${words(400)} ${blob} ${words(400)}`;
    const chunks = chunkText(text, { maxTokens: 512, overlapTokens: 64 });

    expect(droppedContent(text, chunks)).toBe(0);
    // Not merely covered -- windowed, so the blob is searchable in pieces.
    const inside = chunks.filter((c) => c.text.startsWith('Q') && c.text.length > 1000);
    expect(inside.length).toBeGreaterThan(5);
  });

  it('the cursor never lands beyond the chunk it just emitted', () => {
    // The invariant that makes coverage hold, stated directly: a gap between
    // one chunk's end and the next chunk's start is text in no chunk at all.
    // One separator space is legitimately consumed, so +1 is the limit.
    const text = `${words(300)} ${'Z'.repeat(9000)} ${words(300)}`;
    const chunks = chunkText(text, { maxTokens: 256, overlapTokens: 32 });
    for (let i = 1; i < chunks.length; i++) {
      const prevEnd = chunks[i - 1].offset + chunks[i - 1].text.length;
      expect(chunks[i].offset).toBeLessThanOrEqual(prevEnd + 1);
    }
  });

  it('a leading space is not itself a usable boundary, and the text is still covered', () => {
    const text = ` ${'y'.repeat(3000)}`;
    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 10 });
    // No empty chunk is produced: snapToWordBoundary requires lastSpace > 0.
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
    expect(chunks[0].text).toHaveLength(400);
    expect(droppedContent(text, chunks)).toBe(0);
  });

  // Regression. Once a window reached the end of the text, `hasMore` was false,
  // so the chunk was the whole remainder and the step shrank to one word at a
  // time: the tail came out as a run of ever-shorter chunks all ending in the
  // same place. Not lost text -- duplicate index entries, each one embedded at
  // the caller's expense and each one competing for a result slot.
  it('Regression: the tail is emitted once, by the last chunk only', () => {
    const text = words(400);
    const chunks = chunkText(text, { maxTokens: 50, overlapTokens: 10 });

    const endingAtEnd = chunks.filter((c) => c.offset + c.text.length === text.length);
    expect(endingAtEnd).toHaveLength(1);
    expect(endingAtEnd[0]).toBe(chunks[chunks.length - 1]);
  });
});

describe('chunkText — the approach to a space-free run', () => {
  /** Prose, then a base64 image, then prose: the shape of a README. */
  const readme = `${words(400)} ![logo](data:image/png;base64,${'Q'.repeat(20000)}) ${words(400)}`;

  // The step is derived from the SNAPPED length, so a window snapped back hard —
  // its only space near its start, which is what the last window before a blob
  // looks like — leaves a step below the overlap, and `max(step, 1)` becomes 1.
  // The walk then crawled one word at a time across the whole approach, emitting
  // a shorter chunk each time: 42 of 58 chunks under half the budget, the
  // smallest 8 characters. Each one was embedded, and they crowded each other
  // out of the results, being the same sentence shifted by a word.
  it('emits no runt chunks where a document turns space-free', () => {
    const chunks = chunkText(readme, { maxTokens: 512, overlapTokens: 64 });
    const budget = 512 * 4;
    const runts = chunks.filter((c, i) => i < chunks.length - 1 && c.text.length < budget / 2);

    expect(runts).toEqual([]);
    expect(chunks.length).toBeLessThan(20);
    expect(droppedContent(readme, chunks)).toBe(0);
  });

  it('cuts a token only where there is no word within a window to cut', () => {
    // What refusing the snap costs. It is only ever spent inside a run with no
    // space in it — base64, minified JSON — because a window that ends in prose
    // always has a space in its second half.
    const chunks = chunkText(readme, { maxTokens: 512, overlapTokens: 64 });
    const budget = 512 * 4;
    for (const c of chunks) {
      const end = c.offset + c.text.length;
      if (end === readme.length || readme[end] === ' ' || readme[end - 1] === ' ') continue;
      // A mid-token cut: the half-window behind it must hold no space at all,
      // or a word really was split.
      const behind = readme.slice(Math.max(0, end - budget / 2), end);
      expect(behind).not.toContain(' ');
    }
  });

  it('leaves ordinary prose alone', () => {
    // The refusal must never fire on a document made of words: every window
    // ending in prose has a space well past the halfway mark.
    const text = words(6000);
    const chunks = chunkText(text, { maxTokens: 512, overlapTokens: 64 });

    expect(droppedContent(text, chunks)).toBe(0);
    for (const c of chunks) {
      const next = c.offset + c.text.length;
      expect(next === text.length || text[next] === ' ').toBe(true);
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
