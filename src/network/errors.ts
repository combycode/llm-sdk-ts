/** Error taxonomy — each error type gets different retry behavior.
 *  Lives in the network layer so QueueState can classify before hooks fire. */

export type ErrorKind =
  | 'rate_limit'
  | 'auth'
  | 'context_overflow'
  | 'invalid_request'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'content_filter'
  | 'model_not_found'
  | 'quota_exceeded'
  | 'unsupported';

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly kind: ErrorKind,
    public readonly provider: string,
    public readonly status?: number,
    public readonly retryable: boolean = false,
    public readonly retryAfterMs?: number,
    public readonly raw?: unknown,
    /** The server's own `x-should-retry` instruction, when it sent one.
     *  `false` is authoritative: a server that says "do not retry this" knows
     *  something the status code alone does not. `true` only PERMITS a retry --
     *  it never overrides an operator who configured this kind as non-retryable,
     *  because that configuration is a cost decision, not a guess about
     *  idempotence. Undefined when the header is absent or unparseable. */
    public readonly shouldRetry?: boolean,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Map HTTP status + provider error body to our error taxonomy. */
export function classifyError(
  provider: string,
  status: number,
  body: unknown,
  headers: Record<string, string>,
): LLMError {
  const msg = extractErrorMessage(body);
  const shouldRetry = parseShouldRetry(headers);
  const withHint = (e: LLMError): LLMError =>
    shouldRetry === undefined
      ? e
      : new LLMError(e.message, e.kind, e.provider, e.status, e.retryable, e.retryAfterMs, e.raw, shouldRetry);

  return withHint(classifyByStatus(provider, status, msg, headers));
}

function classifyByStatus(
  provider: string,
  status: number,
  msg: string,
  headers: Record<string, string>,
): LLMError {
  if (status === 401 || status === 403) {
    return new LLMError(msg, 'auth', provider, status);
  }

  if (status === 429) {
    const retryAfter = parseRetryAfter(headers);
    return new LLMError(msg, 'rate_limit', provider, status, true, retryAfter);
  }

  if (status === 400) {
    if (/context|token|too long|max_tokens|too many tokens/i.test(msg)) {
      return new LLMError(msg, 'context_overflow', provider, status);
    }
    if (/model.*not found|does not exist|unknown model/i.test(msg)) {
      return new LLMError(msg, 'model_not_found', provider, status);
    }
    if (/not support|unsupported/i.test(msg)) {
      return new LLMError(msg, 'unsupported', provider, status);
    }
    return new LLMError(msg, 'invalid_request', provider, status);
  }

  if (status === 402 || status === 413) {
    return new LLMError(msg, 'quota_exceeded', provider, status);
  }

  if (status >= 500) {
    return new LLMError(msg, 'server_error', provider, status, true);
  }

  // Every other 4xx -- 404, 405, 409, 422 and friends -- used to fall through to
  // `server_error`. The error's own `retryable` was correctly false, but that is
  // not what decides: `perKind.server_error` is retryable, and the per-kind rule
  // wins over the error's flag. So a 404 was re-sent twice, and a 409 Conflict --
  // a status whose entire meaning is "this already happened" -- was retried into
  // the same conflict. The kind was the bug, not the flag.
  //
  // `invalid_request` is already non-retryable, so this needs no new ErrorKind:
  // adding one would break any consumer exhaustively switching over the union.
  if (status >= 400) {
    return new LLMError(msg, 'invalid_request', provider, status);
  }

  return new LLMError(msg, 'server_error', provider, status, false);
}

/** `x-should-retry` as the OpenAI and Anthropic clients send it. Only the two
 *  exact tokens count; anything else is treated as no instruction at all rather
 *  than guessed at. */
function parseShouldRetry(headers: Record<string, string>): boolean | undefined {
  const raw = headers['x-should-retry'] ?? headers['X-Should-Retry'];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

function extractErrorMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return String(body ?? 'Unknown error');
  const b = body as Record<string, unknown>;
  if (typeof b.error === 'object' && b.error !== null) {
    const e = b.error as Record<string, unknown>;
    return String(e.message ?? JSON.stringify(e));
  }
  if (typeof b.error === 'string') return b.error;
  if (typeof b.message === 'string') return b.message;
  return JSON.stringify(body).slice(0, 500);
}

/** What a parsed `Retry-After` means, in milliseconds.
 *
 *  Three outcomes, and the middle one used to be missing:
 *
 *    undefined   no usable instruction — NaN from a malformed header, or a
 *                negative wait, which is nonsense rather than a request.
 *    Infinity    the server asked for longer than any number can hold. This is a
 *                REFUSAL and must be carried as one.
 *    a number    the wait, as asked.
 *
 *  Overflow used to collapse into `undefined`, i.e. "the server said nothing" —
 *  so `retryAfterTooLong` stayed false and the request was retried on the SHORT
 *  exponential backoff. A server asking us to wait essentially forever got a
 *  retry almost immediately, which is the precise opposite of the instruction.
 *  A large but finite value already worked: it exceeds `maxRetryAfterMs` and is
 *  refused on that comparison. */
function usableDelay(ms: number): number | undefined {
  if (Number.isNaN(ms)) return undefined;
  if (ms < 0) return undefined;
  if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
  return ms;
}

/** `Retry-After` per RFC 9110: delay-seconds OR an HTTP-date. Both forms are parsed now; the date
 *  form used to return `undefined`, which was safe but silently ignored the server's instruction.
 *  A skewed client clock can only yield a value the caller's cap rejects, never a negative wait. */
function parseRetryAfter(headers: Record<string, string>): number | undefined {
  // parseFLOAT, not parseInt: `Retry-After: 1.5` is half a second of waiting that
  // `parseInt` threw away, and `retry-after-ms: 1500.7` lost its fraction too.
  // Rounding a server's instruction DOWN is the wrong direction to round.
  const ms = headers['retry-after-ms'];
  if (ms) {
    const parsed = usableDelay(Number.parseFloat(ms));
    if (parsed !== undefined) return parsed;
  }

  const value = headers['retry-after'];
  if (!value) return undefined;

  const seconds = Number.parseFloat(value);
  if (!Number.isNaN(seconds)) return usableDelay(seconds * 1000);

  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return usableDelay(at - Date.now());
}
