/** Small HTTP header helpers shared across network + server layers. */

/** Lowercase-keyed plain record from a WHATWG `Headers`. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Parse an integer header value, or null if absent / not a number. */
export function parseIntHeader(headers: Record<string, string>, key: string): number | null {
  const val = headers[key];
  if (!val) return null;
  const n = Number.parseInt(val, 10);
  return Number.isNaN(n) ? null : n;
}

/** Combine multiple AbortSignals into one that aborts when any of them does. */
export function anySignal(...signals: AbortSignal[]): AbortSignal {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      return c.signal;
    }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

/** Parse a fetch Response body by declared type. */
export async function parseResponseBody(
  response: Response,
  type: 'json' | 'arraybuffer' | 'text',
): Promise<unknown> {
  if (type === 'arraybuffer') return new Uint8Array(await response.arrayBuffer());
  if (type === 'text') return await response.text();
  return await response.json();
}
