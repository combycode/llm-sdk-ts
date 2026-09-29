import { describe, expect, it } from 'bun:test';
import { parseSSEStream } from '../../../src/network/sse';

function streamOf(chunks: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe('parseSSEStream', () => {
  it('parses events split across chunk boundaries', async () => {
    const out = [];
    for await (const ev of parseSSEStream(streamOf(['data: {"a":1}\n', '\ndata: {"b":2}\n\n']))) {
      out.push(ev.data);
    }
    expect(out).toEqual(['{"a":1}', '{"b":2}']);
  });

  // An early `break` must tear the HTTP body down, not just drop the reader lock —
  // otherwise the connection stays open until GC.
  it('cancels the underlying body when the consumer breaks early', async () => {
    let cancelled = false;
    const stream = streamOf(
      ['data: one\n\n', 'data: two\n\n', 'data: three\n\n'],
      () => {
        cancelled = true;
      },
    );
    for await (const ev of parseSSEStream(stream)) {
      expect(ev.data).toBe('one');
      break; // abandon the stream after the first event
    }
    expect(cancelled).toBe(true);
  });

  it('cancels when the consumer throws', async () => {
    let cancelled = false;
    const stream = streamOf(['data: one\n\n', 'data: two\n\n'], () => {
      cancelled = true;
    });
    await expect(
      (async () => {
        for await (const _ of parseSSEStream(stream)) {
          throw new Error('consumer blew up');
        }
      })(),
    ).rejects.toThrow('consumer blew up');
    expect(cancelled).toBe(true);
  });

  it('completes normally without error when the stream ends', async () => {
    const out = [];
    for await (const ev of parseSSEStream(streamOf(['data: done\n\n']))) out.push(ev.data);
    expect(out).toEqual(['done']);
  });
});

describe('parseSSEMessage — field handling', () => {
  it('reads the `id:` field alongside event and data', async () => {
    const out = [];
    for await (const ev of parseSSEStream(
      streamOf(['id: msg_1\nevent: delta\ndata: hello\n\n']),
    )) {
      out.push(ev);
    }
    expect(out).toEqual([{ event: 'delta', data: 'hello', id: 'msg_1' }]);
  });

  it('flushes a trailing event that arrives WITHOUT the final blank line', async () => {
    // Providers close the connection right after the last frame more often than
    // the spec suggests. Dropping the tail buffer loses the final chunk — which
    // for a `[DONE]`-less stream is the last content token.
    const out = [];
    for await (const ev of parseSSEStream(streamOf(['data: one\n\n', 'data: last\n']))) {
      out.push(ev.data);
    }
    expect(out).toEqual(['one', 'last']);
  });

  it('a trailing buffer of only whitespace yields nothing', async () => {
    const out = [];
    for await (const ev of parseSSEStream(streamOf(['data: one\n\n', '\n  \n']))) out.push(ev.data);
    expect(out).toEqual(['one']);
  });

  it('[DONE] is swallowed, including as the unterminated tail', async () => {
    const out = [];
    for await (const ev of parseSSEStream(streamOf(['data: one\n\n', 'data: [DONE]']))) {
      out.push(ev.data);
    }
    expect(out).toEqual(['one']);
  });

  it('comment lines and field-less frames produce no event', async () => {
    const out = [];
    for await (const ev of parseSSEStream(streamOf([': keep-alive\n\n', 'event: ping\n\n', 'data: real\n\n']))) {
      out.push(ev.data);
    }
    expect(out).toEqual(['real']);
  });

  it('multi-line data is joined with newlines, one per `data:` line', async () => {
    const out = [];
    for await (const ev of parseSSEStream(streamOf(['data: a\ndata: b\ndata: c\n\n']))) out.push(ev.data);
    expect(out).toEqual(['a\nb\nc']);
  });

  it('CRLF frame separators parse the same as LF', async () => {
    const out = [];
    for await (const ev of parseSSEStream(streamOf(['data: a\r\n\r\ndata: b\r\n\r\n']))) out.push(ev.data);
    expect(out).toEqual(['a', 'b']);
  });
});

/** The faults the block-based parser had, each of which only shows on real traffic. */
describe('parseSSEStream: line terminators', () => {
  const collect = async (chunks: string[]) => {
    const out: string[] = [];
    for await (const ev of parseSSEStream(streamOf(chunks))) out.push(ev.data);
    return out;
  };

  it.each([
    ['LF', 'data: one\n\ndata: two\n\n'],
    ['CRLF', 'data: one\r\n\r\ndata: two\r\n\r\n'],
    ['CR', 'data: one\r\rdata: two\r\r'],
  ])('separates events on %s', async (_label, body) => {
    expect(await collect([body])).toEqual(['one', 'two']);
  });

  /** The old boundary pattern was `\n\n | \r\n\r\n | \r\r`, so a MIXED
   *  terminator was not a boundary and two events arrived as one. */
  it.each([
    ['CRLF then LF', 'data: one\r\n\ndata: two\r\n\n'],
    ['LF then CRLF', 'data: one\n\r\ndata: two\n\r\n'],
    // LF ends the line, CR ends the blank one. Not a case the old pattern had.
    ['LF then CR blank', 'data: one\n\rdata: two\n\r'],
  ])('separates events on a mixed terminator: %s', async (_label, body) => {
    expect(await collect([body])).toEqual(['one', 'two']);
  });

  it('two data lines with no blank line between them are ONE event', async () => {
    // The spec joins them with a newline. This is what the mixed-terminator case
    // above is NOT: a separator needs a blank line, not merely two terminators.
    expect(await collect(['data: one\r\ndata: two\r\n\r\n'])).toEqual(['one\ntwo']);
  });

  it('keeps a CRLF that straddles two chunks from ending the event early', async () => {
    // The `\r` ends the line; the `\n` arriving next is its partner, NOT a blank
    // line. Treating it as one would dispatch after `one` and lose `two`.
    expect(await collect(['data: one\r', '\ndata: two\r\n\r\n'])).toEqual(['one\ntwo']);
  });

  it('delivers a final event that never got its blank line', async () => {
    expect(await collect(['data: last\n'])).toEqual(['last']);
  });
});

describe('parseSSEStream: exactly one leading space', () => {
  const first = async (chunk: string) => {
    for await (const ev of parseSSEStream(streamOf([chunk]))) return ev;
    return null;
  };

  /** The spec strips ONE space from a field value. `trimStart()` ate every one,
   *  so a payload that legitimately begins with whitespace came back changed. */
  it('keeps the second space', async () => {
    expect((await first('data:  two spaces\n\n'))?.data).toBe(' two spaces');
  });

  it('strips the single conventional space', async () => {
    expect((await first('data: normal\n\n'))?.data).toBe('normal');
  });

  it('keeps a value with no space at all', async () => {
    expect((await first('data:tight\n\n'))?.data).toBe('tight');
  });

  it('keeps leading whitespace inside a JSON payload', async () => {
    expect((await first('data:   {"a":1}\n\n'))?.data).toBe('  {"a":1}');
  });

  it('a comment whose text contains a colon is not read as a field', async () => {
    const out: string[] = [];
    for await (const ev of parseSSEStream(streamOf([': ping: still here\ndata: real\n\n']))) {
      out.push(ev.data);
    }
    expect(out).toEqual(['real']);
  });
});

describe('parseSSEStream: a very large event', () => {
  /** The old parser re-split the whole accumulated buffer on every chunk, which
   *  is quadratic in the size of one event — and a base64 partial image is
   *  exactly that shape. This asserts the RESULT is intact; the cost is the
   *  reason the decoder is incremental. */
  it('reassembles a multi-megabyte data line delivered in many chunks', async () => {
    const payload = 'x'.repeat(2_000_000);
    const chunks: string[] = ['data: '];
    for (let i = 0; i < payload.length; i += 64_000) chunks.push(payload.slice(i, i + 64_000));
    chunks.push('\n\n');
    const out: string[] = [];
    for await (const ev of parseSSEStream(streamOf(chunks))) out.push(ev.data);
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(payload.length);
  });
});
