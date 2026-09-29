/** A request that continues SERVER-SIDE state is not replayed on its own.
 *
 *  `previous_response_id` (OpenAI Responses) and `previous_interaction_id`
 *  (Google Interactions) both mean "append to the conversation you are holding".
 *  A failure that reached the provider may therefore have produced that turn
 *  already — and a retry appends a SECOND one, into a transcript the caller
 *  reads back later, with nothing in the reply to say so. A duplicated HTTP
 *  request you pay for twice; a duplicated TURN changes what the model is
 *  looking at on the next call.
 *
 *  The rule the official agents SDK settled on is the one transposed here: a
 *  stateful request is not retried unless the caller approves the replay.
 *  Everything else is untouched — a stateless request still retries, timeouts
 *  included, because refusing those would trade a common recovery for a rare
 *  one.
 */

import { describe, expect, it } from 'bun:test';
import { createEngine } from '../../../src/helpers/engine';
import { isStatefulRequest } from '../../../src/util/http';

const fast = { initialMs: 1, maxMs: 2, multiplier: 1, jitter: 0 };

const alwaysFails: typeof globalThis.fetch = (() =>
  Promise.resolve(
    new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
  )) as unknown as typeof globalThis.fetch;

/** How many retries one request costs. */
async function retriesFor(body: Record<string, unknown>, retry?: Record<string, unknown>) {
  const engine = createEngine({
    fetch: alwaysFails,
    registerAsDefault: false,
    retry: { backoff: fast, perKind: { server_error: { retryable: true, maxRetries: 3 } } },
  });
  let retries = 0;
  engine.hooks.on('onRetry', () => {
    retries++;
  });
  try {
    await engine.fetch({
      url: 'https://example.invalid/v1/x',
      headers: {},
      body,
      provider: 'openai',
      model: 'gpt-5.4-nano',
      ...(retry ? { retry } : {}),
    } as never);
  } catch {
    // expected — the point is how many attempts it made on the way
  }
  await engine.destroy();
  return retries;
}

describe('isStatefulRequest reads the built body, not a provider list', () => {
  it('recognises both spellings', () => {
    expect(isStatefulRequest({ previous_response_id: 'resp_1' })).toBe(true);
    expect(isStatefulRequest({ previous_interaction_id: 'int_1' })).toBe(true);
  });

  it('is false for an ordinary request', () => {
    expect(isStatefulRequest({ model: 'm', input: 'hi' })).toBe(false);
  });

  it('is false for an empty or absent id, which continues nothing', () => {
    expect(isStatefulRequest({ previous_response_id: '' })).toBe(false);
    expect(isStatefulRequest({ previous_response_id: null })).toBe(false);
  });

  it('survives a body that is not an object at all', () => {
    expect(isStatefulRequest(undefined)).toBe(false);
    expect(isStatefulRequest('raw')).toBe(false);
  });
});

describe('the retry layer refuses to duplicate a server-side turn', () => {
  it('retries a stateless request as it always has', async () => {
    expect(await retriesFor({ model: 'm', input: 'hi' })).toBe(3);
  });

  it('does not retry one that continues a response', async () => {
    expect(await retriesFor({ model: 'm', input: 'hi', previous_response_id: 'resp_1' })).toBe(0);
  });

  it('does not retry one that continues an interaction', async () => {
    expect(await retriesFor({ model: 'm', input: 'hi', previous_interaction_id: 'int_1' })).toBe(0);
  });

  it('retries it when the caller approves the replay', async () => {
    // For when you know it is safe to repeat: the provider said it never
    // landed, or the conversation is disposable.
    expect(
      await retriesFor(
        { model: 'm', input: 'hi', previous_response_id: 'resp_1' },
        { approveUnsafeReplay: true },
      ),
    ).toBe(3);
  });

  it('leaves the approval alone for a stateless request', async () => {
    // The flag permits; it never changes anything that was already permitted.
    expect(
      await retriesFor({ model: 'm', input: 'hi' }, { approveUnsafeReplay: true }),
    ).toBe(3);
  });
});
