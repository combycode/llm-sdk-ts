/** Server-Sent Events parser. One implementation for all providers. */

import type { SSEEvent } from './types';

export async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncIterable<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split(/\n\n|\r\n\r\n|\r\r/);
      buffer = parts.pop() ?? '';

      for (const part of parts) {
        const event = parseSSEMessage(part);
        if (event) yield event;
      }
    }
    if (buffer.trim()) {
      const event = parseSSEMessage(buffer);
      if (event) yield event;
    }
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

function parseSSEMessage(raw: string): SSEEvent | null {
  const lines = raw.split(/\n|\r\n|\r/);
  let event: string | undefined;
  let id: string | undefined;
  let data = '';
  let hasData = false;

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('id:')) {
      id = line.slice(3).trim();
    } else if (line.startsWith('data:')) {
      if (hasData) data += '\n';
      data += line.slice(5).trimStart();
      hasData = true;
    }
    // lines starting with `:` are SSE comments — ignored
  }

  if (!hasData) return null;
  if (data === '[DONE]') return null;

  return { event, data, id };
}
