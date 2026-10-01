/** Join a base URL and a path without destroying the base's query string.
 *
 *  `baseURL() + path` is correct for every base that is only a host, which is
 *  every base this library ships. It is wrong for the one shape callers actually
 *  configure by hand: an Azure-style endpoint carrying a query string.
 *
 *      'https://x.openai.azure.com/openai?api-version=2026-05-01' + '/v1/responses'
 *      -> 'https://x.openai.azure.com/openai?api-version=2026-05-01/v1/responses'
 *
 *  The path has become part of the `api-version` VALUE. The request goes to the
 *  base path with a nonsense version, and the error that comes back is about the
 *  version, not about the URL — so the one clue points at the wrong thing.
 *
 *  So: split the base at its first `?`, append the path to the path half, and put
 *  the query back on the end. A trailing slash on the base and a leading one on
 *  the path collapse to one, because `//` is a different path to a strict router
 *  and the two halves come from different places (our adapter's constant and the
 *  caller's config) — neither can know what the other ended with.
 *
 *  A fragment is dropped rather than carried: `#x` has no meaning to an HTTP
 *  server, it is never sent, and keeping it in the middle of a URL we then append
 *  to would move it somewhere it means even less. */
export function joinUrl(base: string, path: string): string {
  const hash = base.indexOf('#');
  const withoutHash = hash === -1 ? base : base.slice(0, hash);
  const q = withoutHash.indexOf('?');
  const head = q === -1 ? withoutHash : withoutHash.slice(0, q);
  const query = q === -1 ? '' : withoutHash.slice(q);
  if (!path) return head + query;
  const joined =
    head.endsWith('/') && path.startsWith('/') ? head + path.slice(1) : head + path;
  return joined + query;
}

/** A WebSocket URL from an http(s) base, a path and query parameters.
 *
 *  Three things go wrong when this is spelled out at the call site, and Azure-style
 *  endpoints hit all three at once
 *  (`wss://<res>.openai.azure.com/openai/realtime?api-version=...`):
 *
 *   - the scheme has to change, `https` -> `wss`;
 *   - the path has to land before the base's query, not inside it (see `joinUrl`);
 *   - the extra parameters have to MERGE with the base's query rather than start a
 *     second one -- `?api-version=x?model=y` is one parameter called
 *     `api-version` whose value ends in `?model=y`.
 *
 *  Parameters with an `undefined` value are dropped rather than sent empty: a
 *  provider that validates its query rejects `model=` differently from an absent
 *  `model`, and the absent one is what "not specified" means. */
export function wsUrl(
  base: string,
  path: string,
  params: Record<string, string | undefined> = {},
): string {
  const joined = joinUrl(base, path).replace(/^http/, 'ws');
  const [head, existing = ''] = joined.split('?', 2);
  const search = new URLSearchParams(existing);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  const query = search.toString();
  return query ? `${head}?${query}` : (head as string);
}
