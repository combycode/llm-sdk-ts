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

/** Combine several AbortSignals into one, and hand back the way to unsubscribe.
 *
 *  `dispose()` matters wherever a SHORT-lived signal is linked to a LONG-lived
 *  one -- a tool call against its run, say. The listener lives on the long-lived
 *  signal, so without unsubscribing every finished call leaves its dead
 *  controller reachable until the run ends. One call is nothing; a long run with
 *  a tool call per step is a slow leak nobody would think to look for. */
export function linkSignals(...signals: AbortSignal[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const c = new AbortController();
  const off: Array<() => void> = [];
  const dispose = () => {
    for (const f of off) f();
    off.length = 0;
  };
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      dispose();
      return { signal: c.signal, dispose };
    }
    const onAbort = () => c.abort(s.reason);
    s.addEventListener('abort', onAbort, { once: true });
    off.push(() => s.removeEventListener('abort', onAbort));
  }
  return { signal: c.signal, dispose };
}

/** Combine multiple AbortSignals into one that aborts when any of them does. */
export function anySignal(...signals: AbortSignal[]): AbortSignal {
  return linkSignals(...signals).signal;
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

/** Redirect statuses that PRESERVE the method and body. 307 and 308 are defined
 *  to; 301, 302 and 303 are the ones every client turns into a body-less GET. */
const METHOD_PRESERVING = new Set([307, 308]);

/** Is `location` on `origin`'s origin — or its https upgrade on default ports?
 *
 *  The upgrade is allowed because it is strictly a security improvement to the
 *  same host, and it is the one exception the reference implementations make. */
function sameOrigin(from: URL, to: URL): boolean {
  if (from.protocol === to.protocol && from.host === to.host) return true;
  return (
    from.hostname === to.hostname &&
    from.protocol === 'http:' &&
    to.protocol === 'https:' &&
    (from.port === '' || from.port === '80') &&
    (to.port === '' || to.port === '443')
  );
}

/** Where a redirect response wants to go, if we are willing to follow it.
 *
 *  Willing means all of:
 *
 *  - the METHOD survives. 307/308 preserve it; 301/302/303 turn a POST into a
 *    body-less GET, which for a JSON-RPC transport means the message is dropped
 *    and the server answers a question nobody asked. A GET redirect is fine
 *    under any of them, since there is no method or body to lose.
 *  - the target is the SAME ORIGIN (or its https upgrade on default ports).
 *    Everything on the request — bearer token, session header, body — was
 *    configured for one endpoint, so following cross-origin hands those to
 *    whoever controls the `Location` header.
 *  - the target brings no USERINFO of its own. `https://attacker@host/` is sent
 *    as Basic auth by the platform, so a Location that introduces credentials is
 *    a redirect that changes who we are authenticating as.
 *
 *  Returns null for anything else, including a non-redirect — the caller then
 *  treats the redirect response as the non-success it is, which is what the
 *  platform does when redirects are off. */
export function followSameOrigin(
  requestUrl: string,
  method: string,
  status: number,
  location: string | null,
): string | null {
  if (!location) return null;
  const verb = method.toUpperCase();
  if (!METHOD_PRESERVING.has(status) && verb !== 'GET' && verb !== 'HEAD') return null;
  let from: URL;
  let to: URL;
  try {
    from = new URL(requestUrl);
    to = new URL(location, requestUrl);
  } catch {
    // A Location we cannot even parse is not one to follow.
    return null;
  }
  if (to.username || to.password) {
    // Userinfo the CONFIGURED url already carried is fine and survives a
    // relative Location; userinfo the Location introduces is not.
    if (to.username !== from.username || to.password !== from.password) return null;
  }
  if (!sameOrigin(from, to)) return null;
  return to.toString();
}
