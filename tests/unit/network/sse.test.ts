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
