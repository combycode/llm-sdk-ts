/** Server-Sent Events parser. One implementation for all providers.
 *
 *  Line-based and incremental, because the previous block-based version had
 *  three faults that only show up on real traffic:
 *
 *  1. It re-split the WHOLE accumulated buffer on every chunk. A multi-megabyte
 *     event — a base64 partial image is exactly that — was rescanned from the
 *     start for each arriving chunk, which is quadratic in the event's size.
 *  2. Its boundary pattern was `\n\n | \r\n\r\n | \r\r`, so a MIXED terminator
 *     such as `\r\n\n` was not a boundary at all and two events were parsed as
 *     one. The spec ends a line with CRLF, LF or CR in any combination, and a
 *     blank line ends the event.
 *  3. `data:` values were `trimStart()`ed, which eats every leading space. The
 *     spec strips exactly ONE, so a payload that legitimately begins with
 *     whitespace came back corrupted.
 */

import type { SSEEvent } from './types';

/** Splits a byte stream into SSE lines without ever rescanning what it already
 *  scanned, and without losing a CRLF that straddles two chunks. */
function makeLineDecoder() {
  let buffer = '';
  /** Everything before this index is known to hold no terminator. */
  let scanned = 0;
  /** The previous chunk ended on `\r`: a leading `\n` now is its partner, not a
   *  blank line. Getting this wrong ends an event one line early. */
  let pendingLineFeed = false;

  return {
    push(chunk: string): string[] {
      let text = chunk;
      if (pendingLineFeed) {
        if (text.startsWith('\n')) text = text.slice(1);
        pendingLineFeed = false;
      }
      buffer += text;

      const lines: string[] = [];
      let start = 0;
      for (let i = scanned; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch === '\n') {
          lines.push(buffer.slice(start, i));
          start = i + 1;
        } else if (ch === '\r') {
          lines.push(buffer.slice(start, i));
          if (i + 1 < buffer.length) {
            if (buffer[i + 1] === '\n') i++;
          } else {
            pendingLineFeed = true;
          }
          start = i + 1;
        }
      }
      buffer = buffer.slice(start);
      // The tail carries no terminator, so the next push starts scanning at its
      // end rather than at zero. This is the whole of the linearity.
      scanned = buffer.length;
      return lines;
    },
    /** Whatever is left when the stream ends without a final terminator. */
    flush(): string | null {
      const rest = buffer;
      buffer = '';
      scanned = 0;
      return rest.length ? rest : null;
    },
  };
}

/** One field value, with exactly one leading space removed — not every one. */
function fieldValue(line: string, nameLength: number): string {
  const raw = line.slice(nameLength + 1);
  return raw.startsWith(' ') ? raw.slice(1) : raw;
}

class EventAccumulator {
  private event: string | undefined;
  private id: string | undefined;
  private data = '';
  private hasData = false;

  /** Returns the event when `line` is blank and one was pending. */
  push(line: string): SSEEvent | null {
    if (line === '') return this.dispatch();
    // A line starting with `:` is a comment. Checked BEFORE the field split so a
    // comment whose text contains a colon is not read as a field.
    if (line.startsWith(':')) return null;

    if (line.startsWith('event:')) {
      this.event = fieldValue(line, 5).trim();
    } else if (line.startsWith('id:')) {
      this.id = fieldValue(line, 2).trim();
    } else if (line.startsWith('data:')) {
      if (this.hasData) this.data += '\n';
      this.data += fieldValue(line, 4);
      this.hasData = true;
    }
    return null;
  }

  dispatch(): SSEEvent | null {
    if (!this.hasData) {
      this.reset();
      return null;
    }
    const out: SSEEvent = { event: this.event, data: this.data, id: this.id };
    this.reset();
    return out.data === '[DONE]' ? null : out;
  }

  private reset(): void {
    this.event = undefined;
    this.id = undefined;
    this.data = '';
    this.hasData = false;
  }
}

export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncIterable<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const lines = makeLineDecoder();
  const events = new EventAccumulator();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of lines.push(decoder.decode(value, { stream: true }))) {
        const event = events.push(line);
        if (event) yield event;
      }
    }
    // A stream that ends without a blank line still has an event to deliver.
    const tail = lines.flush();
    if (tail !== null) {
      const event = events.push(tail);
      if (event) yield event;
    }
    const last = events.dispatch();
    if (last) yield last;
  } finally {
    // Cancel the underlying body, don't just drop the lock. A consumer that breaks out
    // of the `for await` early (abort, error, or `break` after the first token) would
    // otherwise leave the HTTP response open until GC. `cancel()` tears the connection
    // down and is a no-op on an already-closed stream, so the happy path is unaffected.
    try {
      await reader.cancel();
    } catch {
      // already errored/closed — nothing to cancel
    }
    try {
      reader.releaseLock();
    } catch {
      // cancel() may have released it already
    }
  }
}
