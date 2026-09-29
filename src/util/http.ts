/** Small HTTP header helpers shared across network + server layers. */

/** Lowercase-keyed plain record from a WHATWG `Headers`. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Case-insensitive header lookup. HTTP header names are case-insensitive
 *  (RFC 9110 §5.1) but a plain record is not, and the casing a server or fetch
 *  implementation actually sends varies — so read response headers through here
 *  instead of guessing casings at the call site. */
export function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const k in headers) if (k.toLowerCase() === lower) return headers[k];
  return undefined;
}

/** True when a request body cannot be replayed for a retry (the first attempt
 *  consumes it). FormData, strings and byte views are replayable; a stream is not. */
/** Whether this body continues a conversation the PROVIDER is holding.
 *
 *  `previous_response_id` (OpenAI Responses) and `previous_interaction_id`
 *  (Google Interactions) both say "append to that". Read off the built body
 *  rather than from a provider list: the question is what this request does,
 *  which stays the same question when another provider grows the same idea.
 *
 *  It matters to the retry layer, where replaying such a request appends a
 *  SECOND turn to a transcript the caller will read back later -- silently. */
export function isStatefulRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return Boolean(b.previous_response_id) || Boolean(b.previous_interaction_id);
}

export function isStreamBody(body: unknown): boolean {
  return typeof ReadableStream !== 'undefined' && body instanceof ReadableStream;
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
