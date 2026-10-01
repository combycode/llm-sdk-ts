/** Backup models for a step of an agent run.
 *
 *  `route()` already falls over between models, but only for a one-shot
 *  `complete()`. An agent run is where it matters more: a rate limit on step 7 of
 *  a nine-step run threw away six steps of work and every tool call they paid
 *  for, and the caller's only recourse was to start the whole run again.
 *
 *  Four rules, and the third is the one that cannot be got wrong:
 *
 *   1. **Each client is tried once per step.** Retrying one client is a different
 *      concern and already belongs to the network engine; doing it here too would
 *      retry a single failure twice over, at two layers.
 *   2. **Only a failure another model could survive moves on.** A 429 or a 503 is
 *      worth another model; a bad request, an auth failure or a content filter is
 *      the same request failing the same way everywhere, so it propagates
 *      immediately rather than being asked of every backup in turn. The classes
 *      are `route()`'s, so the two surfaces agree on what "retryable" means.
 *   3. **Never switch once output has reached the caller.** A streamed turn can
 *      fail after several chunks. Falling over then splices two models into one
 *      turn: the consumer has already rendered half an answer, and the backup
 *      starts a different one. So the chain is live only until the first event.
 *   4. **Every step starts from the primary.** A rate limit is transient, and a
 *      run that fell over once should not spend the rest of its life on the
 *      backup. This matches the upstream wrapper, which is per model call.
 *
 *  The chain reports WHO served, because a report or a span naming the primary
 *  when a backup answered is worse than no attribution at all.
 */

import type { LLMClient } from '../llm/client';
import type { CompletionResponse } from '../llm/types/response';
import type { StreamEvent } from '../llm/types/stream';
import type { ExecuteOptions } from '../llm/types/options';
import type { ErrorKind } from '../network/errors';
import { LLMError } from '../network/errors';

/** Failures worth trying another model for. The same set `route()` uses — a
 *  model swap cannot fix auth, a malformed request, a content filter or a prompt
 *  that is simply too long. */
export const DEFAULT_AGENT_FALLBACK_KINDS: readonly ErrorKind[] = [
  'rate_limit',
  'server_error',
  'model_not_found',
  'timeout',
  'network',
  'quota_exceeded',
  'unsupported',
];

/** What happened on the way to an answer, for the warning the loop emits. */
export interface FallbackNotice {
  /** The client that failed. */
  from: string;
  /** The client tried next. */
  to: string;
  kind: ErrorKind | undefined;
  message: string;
}

function kindOf(error: unknown): ErrorKind | undefined {
  return error instanceof LLMError ? error.kind : undefined;
}

function retryable(error: unknown, kinds: ReadonlySet<ErrorKind>): boolean {
  const kind = kindOf(error);
  return kind != null && kinds.has(kind);
}

/** The ordered clients a step may use. The primary is always first; a duplicate
 *  of it among the backups is dropped, because trying the same client twice is
 *  exactly the retry this layer is not doing. */
export function clientChain(
  primary: LLMClient,
  backups: readonly LLMClient[] | undefined,
): LLMClient[] {
  const chain = [primary];
  for (const c of backups ?? []) if (!chain.includes(c)) chain.push(c);
  return chain;
}

export interface FallbackRun {
  chain: readonly LLMClient[];
  kinds?: readonly ErrorKind[];
  /** Called before each hand-off, so the loop can warn with the reason. */
  onFallback?: (notice: FallbackNotice) => void;
}

/** A buffered step, with backups. Returns the response AND who produced it. */
export async function completeWithFallback(
  run: FallbackRun,
  messages: Parameters<LLMClient['complete']>[0],
  options: ExecuteOptions,
): Promise<{ response: CompletionResponse; servedBy: LLMClient }> {
  const kinds = new Set(run.kinds ?? DEFAULT_AGENT_FALLBACK_KINDS);
  const last = run.chain.length - 1;
  for (let i = 0; ; i++) {
    const client = run.chain[i]!;
    try {
      return { response: await client.complete(messages, options), servedBy: client };
    } catch (error) {
      // The last client's error is the caller's error: handing them a wrapper
      // would bury the provider's own message, which is the useful half.
      if (i === last || !retryable(error, kinds)) throw error;
      run.onFallback?.({
        from: client.model,
        to: run.chain[i + 1]!.model,
        kind: kindOf(error),
        message: (error as Error).message,
      });
    }
  }
}

/** A streamed step, with backups — and only until the first event.
 *
 *  `servedBy` is a box rather than a return value because a generator's return
 *  value is not reachable through `for await`: the caller needs to know which
 *  client answered in order to stamp the step, and would otherwise have to guess
 *  from the primary. */
export async function* streamWithFallback(
  run: FallbackRun,
  messages: Parameters<LLMClient['stream']>[0],
  options: ExecuteOptions,
  servedBy: { client: LLMClient },
): AsyncIterable<StreamEvent> {
  const kinds = new Set(run.kinds ?? DEFAULT_AGENT_FALLBACK_KINDS);
  const last = run.chain.length - 1;
  for (let i = 0; ; i++) {
    const client = run.chain[i]!;
    servedBy.client = client;
    let emitted = false;
    try {
      for await (const event of client.stream(messages, options)) {
        emitted = true;
        yield event;
      }
      return;
    } catch (error) {
      // `emitted` comes FIRST. Once part of this model's turn has reached the
      // consumer, a backup cannot continue it — it would start a second answer
      // mid-sentence — so the failure is theirs to handle.
      if (emitted || i === last || !retryable(error, kinds)) throw error;
      run.onFallback?.({
        from: client.model,
        to: run.chain[i + 1]!.model,
        kind: kindOf(error),
        message: (error as Error).message,
      });
    }
  }
}
