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

  return new LLMError(msg, 'server_error', provider, status, status >= 500);
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

/** A delay is usable only if it is a finite, non-negative number of milliseconds. Anything else —
 *  NaN from a malformed header, Infinity, a negative value — is discarded rather than propagated:
 *  `setTimeout(fn, NaN)` fires immediately, turning one bad header into a retry storm. */
function usableDelay(ms: number): number | undefined {
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** `Retry-After` per RFC 9110: delay-seconds OR an HTTP-date. Both forms are parsed now; the date
 *  form used to return `undefined`, which was safe but silently ignored the server's instruction.
 *  A skewed client clock can only yield a value the caller's cap rejects, never a negative wait. */
function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const ms = headers['retry-after-ms'];
  if (ms) {
    const parsed = usableDelay(Number.parseInt(ms, 10));
    if (parsed !== undefined) return parsed;
  }

  const value = headers['retry-after'];
  if (!value) return undefined;

  const seconds = Number.parseInt(value, 10);
  if (!Number.isNaN(seconds)) return usableDelay(seconds * 1000);

  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return usableDelay(at - Date.now());
}
