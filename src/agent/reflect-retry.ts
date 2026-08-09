/** Reflect-and-retry — self-healing recovery from a recoverable MODEL failure.
 *
 *  Some turns fail in a way the model itself can fix: it produced malformed tool arguments, named a
 *  tool that does not exist, or was cut off mid-call. Surfacing that straight to the caller wastes a
 *  turn that a single corrective nudge would have salvaged. This injects structured guidance —
 *  naming the attempt number and telling the model not to repeat the same call — and lets the loop
 *  try again within a bounded budget.
 *
 *  Ported from google-adk `ReflectAndRetryModelPlugin` (adk 2.6), including its default trigger
 *  (`MALFORMED_FUNCTION_CALL`) and its raise-vs-give-up switch.
 *
 *  Deliberately NOT a network retry: `NetworkEngine` already retries transport failures. This is for
 *  a request that SUCCEEDED and came back unusable, which no amount of resending would fix. */

import type { FinishReason } from '../llm/types/response';

export interface ReflectAndRetryConfig {
  /** Consecutive recoverable failures to tolerate before giving up. Default 3. */
  maxRetries?: number;
  /** Which finish reasons count as recoverable. Default `['malformed_tool_call']`.
   *
   *  Adding `'content_filter'` is possible but rarely wise: a refusal is usually a decision, not a
   *  mistake, and retrying it burns budget to be refused again. */
  onFinishReasons?: FinishReason[];
  /** When the budget is exhausted: `true` (default) throws, `false` returns the last response as-is
   *  so the caller can decide. Upstream calls this `throw_exception_if_retry_exceeded`. */
  throwIfExceeded?: boolean;
}

export const DEFAULT_REFLECT_RETRY_REASONS: FinishReason[] = ['malformed_tool_call'];

const DEFAULTS = { maxRetries: 3, throwIfExceeded: true };

export class ReflectAndRetryPolicy {
  readonly maxRetries: number;
  readonly throwIfExceeded: boolean;
  private readonly reasons: ReadonlySet<string>;
  /** Consecutive failures for the CURRENT run. Reset by any successful turn, so an agent that
   *  recovers and then fails again much later gets a fresh budget rather than inheriting one. */
  private consecutive = 0;

  constructor(config: ReflectAndRetryConfig = {}) {
    if (config.maxRetries !== undefined && config.maxRetries < 0) {
      throw new Error('reflectAndRetry: maxRetries must be >= 0');
    }
    this.maxRetries = config.maxRetries ?? DEFAULTS.maxRetries;
    this.throwIfExceeded = config.throwIfExceeded ?? DEFAULTS.throwIfExceeded;
    this.reasons = new Set(config.onFinishReasons ?? DEFAULT_REFLECT_RETRY_REASONS);
  }

  /** Is this finish reason one we try to recover from? */
  handles(finishReason: FinishReason): boolean {
    return this.reasons.has(finishReason);
  }

  /** Record a successful turn — the failure streak is broken. */
  recordSuccess(): void {
    this.consecutive = 0;
  }

  /** Record a recoverable failure and report what to do next.
   *
   *  `attempt` counts from 1 so the guidance can say "attempt 1 of 3" the way a human would. */
  recordFailure(): { retry: boolean; attempt: number; exhausted: boolean } {
    this.consecutive++;
    const retry = this.consecutive <= this.maxRetries;
    return { retry, attempt: this.consecutive, exhausted: !retry };
  }

  get consecutiveFailures(): number {
    return this.consecutive;
  }

  /** Reset between runs so one run's failures never spend another run's budget. */
  reset(): void {
    this.consecutive = 0;
  }
}

/** The corrective message fed back to the model.
 *
 *  Names the attempt number and explicitly forbids repeating the identical call — without that, a
 *  model tends to re-emit the same malformed arguments and burn the whole budget on one mistake. */
export function reflectionGuidance(
  finishReason: FinishReason,
  attempt: number,
  maxRetries: number,
  detail?: string,
): string {
  return [
    `The previous turn failed (${finishReason}) and produced no usable tool call.`,
    detail ? `Details: ${detail}` : '',
    '',
    '**Reflection guidance:**',
    `- This is retry attempt ${attempt} of ${maxRetries}.`,
    '- Analyse the arguments you produced. Do NOT repeat the same call unchanged.',
    '- If a tool name was wrong, choose one from the tools actually available to you.',
    '',
    'Form a new plan from that analysis and try a corrected approach.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
