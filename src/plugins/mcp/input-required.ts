/** Multi-round-trip requests (MRTR, SEP-2322) — the 2026-07-28 replacement for the server→client
 *  back-channel.
 *
 *  On the handshake wire a server that needs sampling/elicitation/roots PUSHES a request at us
 *  mid-call. At 2026-07-28 there is no back-channel: the server instead RETURNS
 *  `resultType: 'input_required'` carrying the requests it needs answered, and the client re-issues
 *  the *same* call with the answers plus the server's opaque `requestState`.
 *
 *  Both mechanisms feed the SAME callbacks — a caller who wired up sampling once gets it on either
 *  wire without knowing which is in play. Algorithm mirrors mcp-py 2.0.0 `client/_input_required.py`.
 */

import { McpError, McpErrorCode } from './jsonrpc';
import type { McpInputRequest, McpInputRequiredFields } from './types';

/** Cap on retry rounds before the driver gives up. Matches the TypeScript SDK's default; the C#
 *  and Go SDKs use the same value as a hard constant. */
export const DEFAULT_INPUT_REQUIRED_MAX_ROUNDS = 10;

/** First sleep when a leg carries only `requestState` and no input requests — the server is
 *  saying "still working, ask again". */
const STATE_ONLY_BACKOFF_INITIAL_MS = 50;
/** Upper bound on that sleep, reached after three consecutive state-only legs. */
const STATE_ONLY_BACKOFF_CAP_MS = 250;

/** Answer one embedded request through the client's sampling / elicitation / roots handling. */
export type InputRequestDispatcher = (key: string, request: McpInputRequest) => Promise<unknown>;

/** Re-issue the original call with the collected answers and the latest state. */
export type InputRequiredRetry<T> = (
  responses: Record<string, unknown> | undefined,
  requestState: string | undefined,
) => Promise<T>;

/** True when a result is the server asking for more input rather than a final answer.
 *
 *  The discriminant is `resultType`. Per spec an ABSENT `resultType` MUST be read as `'complete'`:
 *  servers on earlier revisions never send the field, and treating absent as anything else would
 *  make every legacy result look like a question. */
export function isInputRequired(result: unknown): boolean {
  return (
    !!result &&
    typeof result === 'object' &&
    (result as McpInputRequiredFields).resultType === 'input_required'
  );
}

/** Drive an `input_required` result to a terminal one.
 *
 *  Each round either answers every embedded request and retries with the responses, or — when the
 *  server sent state but no questions — backs off and retries empty. `requestState` is echoed back
 *  byte-exact and never inspected: it is the server's sealed continuation token. */
export async function runInputRequiredDriver<T>(
  first: T,
  opts: {
    dispatch: InputRequestDispatcher;
    retry: InputRequiredRetry<T>;
    maxRounds?: number;
  },
): Promise<T> {
  const maxRounds = opts.maxRounds ?? DEFAULT_INPUT_REQUIRED_MAX_ROUNDS;
  let current = first;
  let rounds = 0;
  let stateOnlyDelay = STATE_ONLY_BACKOFF_INITIAL_MS;

  while (isInputRequired(current)) {
    rounds++;
    if (rounds > maxRounds) {
      throw new McpError({
        code: McpErrorCode.InternalError,
        message:
          `MCP server returned input_required for more than ${maxRounds} rounds. ` +
          `Raise inputRequiredMaxRounds if the server legitimately needs more, or check the ` +
          `sampling/elicitation handler — a handler that never satisfies the server loops forever.`,
      });
    }

    const step = current as McpInputRequiredFields;
    const requests = step.inputRequests;
    let responses: Record<string, unknown> | undefined;

    if (requests && Object.keys(requests).length > 0) {
      stateOnlyDelay = STATE_ONLY_BACKOFF_INITIAL_MS; // a real question resets the backoff
      const keys = Object.keys(requests);
      const answered = await Promise.all(
        keys.map(async (key) => [key, await opts.dispatch(key, requests[key] as McpInputRequest)] as const),
      );
      responses = Object.fromEntries(answered);
    } else {
      // State-only leg: the server is still working. Sleep before asking again so a slow tool does
      // not turn into a spin loop against the server.
      await new Promise((r) => setTimeout(r, stateOnlyDelay));
      stateOnlyDelay = Math.min(stateOnlyDelay * 2, STATE_ONLY_BACKOFF_CAP_MS);
    }

    current = await opts.retry(responses, step.requestState);
  }

  return current;
}
