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
