/** Google Interactions: the signature a turn must hand back, and the reason a
 *  failed one gives.
 *
 *  Both measured live on 2026-09-29 against `gemini-3.1-flash-lite`:
 *
 *    - an ordinary turn returns a `thought` step carrying NOTHING but a
 *      `signature`, which this library used to drop: the buffered parse had no
 *      case for the step type, and the stream spec called the delta "internal";
 *    - echoing that step on the next turn is accepted (200) and the model
 *      answers normally;
 *    - echoing it with the signature corrupted is refused 400 "Corrupted thought
 *      signature", so the server READS it rather than tolerating it. That is
 *      what makes dropping it a defect and not a tidy-up.
 *
 *  In a stream the signature reaches the client only as its own `step.delta`
 *  (`delta.type === 'thought_signature'`): `step.start` announces the thought
 *  without one, and the terminal `interaction.completed` carries the envelope
 *  with no steps at all.
 */

import { describe, expect, it } from 'bun:test';
import { GoogleInteractionsAdapter } from '../../../src/llm/providers/google/interactions';
import { buildAssistantMessage } from '../../../src/llm/client-internal';
import type { Message } from '../../../src/llm/types/messages';
import type { CompletionResponse } from '../../../src/llm/types/response';
import type { NormalizedRequest } from '../../../src/llm/types/request';
import type { SSEEvent } from '../../../src/network/types';

const adapter = new GoogleInteractionsAdapter({ apiKey: 'k' });

const SIGNATURE = 'EnMKcQFpFH0TSvkjoKwOEghRRZdGvC3ICA0FZOoJaq4F2i';

const interaction = (over: Record<string, unknown> = {}) => ({
  id: 'int_1',
  object: 'interaction',
  status: 'completed',
  model: 'gemini-3.1-flash-lite',
  steps: [
    { type: 'thought', signature: SIGNATURE },
    { type: 'model_output', content: [{ type: 'text', text: 'OK' }] },
  ],
  usage: { prompt_tokens: 3, candidates_tokens: 1, total_tokens: 4 },
  ...over,
});

describe('a signed step survives the parse', () => {
  it('keeps the step verbatim, because verbatim is what goes back', () => {
    const res = adapter.parseResponse(interaction(), 1);
    expect(res.signatures).toEqual([{ type: 'thought', signature: SIGNATURE }]);
  });

  it('says nothing when no step carried one', () => {
    const res = adapter.parseResponse(
      interaction({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'OK' }] }] }),
      1,
    );
    expect(res.signatures).toBeUndefined();
  });

  it('keeps a signed step of a type this library does not model', () => {
    // Matched on the PRESENCE of a signature, not on a list of step types:
    // `processing_call`, `processing_result`, `retrieval_call` and
    // `retrieval_result` all declare one and are all accepted as input types —
    // the live API enumerates them when it rejects an unknown one. A type list
    // would lose each new one silently until someone edited it.
    const res = adapter.parseResponse(
      interaction({
        steps: [
          { type: 'processing_call', id: 'p1', signature: 'sig-processing' },
          { type: 'model_output', content: [{ type: 'text', text: 'OK' }] },
        ],
      }),
      1,
    );
    expect(res.signatures).toEqual([
      { type: 'processing_call', id: 'p1', signature: 'sig-processing' },
    ]);
  });
});

describe('and reaches the next request', () => {
  const assistantWith = (response: CompletionResponse): Message =>
    buildAssistantMessage(response, {
      provider: 'google',
      model: 'gemini-3.1-flash-lite',
      api: 'interactions',
    });

  const inputOf = (messages: Message[]) =>
    (
      adapter.buildRequest({
        model: 'gemini-3.1-flash-lite',
        messages,
      } as unknown as NormalizedRequest) as { body: { input: Array<Record<string, unknown>> } }
    ).body.input;

  it('is stamped onto the assistant message', () => {
    const msg = assistantWith(adapter.parseResponse(interaction(), 1));
    expect(msg.origin?.signatures).toEqual([{ type: 'thought', signature: SIGNATURE }]);
  });

  it('goes back out BEFORE the model_output it preceded', () => {
    const msg = assistantWith(adapter.parseResponse(interaction(), 1));
    const input = inputOf([{ role: 'user', content: 'hi' }, msg, { role: 'user', content: 'again' }]);
    expect(input.map((i) => i.type)).toEqual([
      'user_input',
      'thought',
      'model_output',
      'user_input',
    ]);
    expect(input[1]).toEqual({ type: 'thought', signature: SIGNATURE });
  });

  it("never sends another provider's signature", () => {
    // `origin.signatures` is provider-bound by contract: a blob minted
    // elsewhere is meaningless here and a 400 at best.
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'OK' }],
      origin: {
        provider: 'openai',
        model: 'gpt-5.4-nano',
        signatures: [{ type: 'thought', signature: 'not-ours' }],
      },
    };
    const input = inputOf([{ role: 'user', content: 'hi' }, msg]);
    expect(input.map((i) => i.type)).toEqual(['user_input', 'model_output']);
  });

  it('sends nothing extra when the turn carried no signature', () => {
    const msg = assistantWith(
      adapter.parseResponse(
        interaction({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'OK' }] }] }),
        1,
      ),
    );
    const input = inputOf([{ role: 'user', content: 'hi' }, msg]);
    expect(input.map((i) => i.type)).toEqual(['user_input', 'model_output']);
  });
});

describe('a streamed turn keeps it too', () => {
  const parse = () => adapter.createStreamParser();

  it('rebuilds the step from the delta and carries it on `done`', () => {
    const feed = parse();
    feed({ event: 'step.start', data: JSON.stringify({ event_type: 'step.start', step: { type: 'thought' } }) } as SSEEvent);
    feed({
      event: 'step.delta',
      data: JSON.stringify({ event_type: 'step.delta', delta: { type: 'thought_signature', signature: SIGNATURE } }),
    } as SSEEvent);
    feed({ event: 'step.stop', data: JSON.stringify({ event_type: 'step.stop' }) } as SSEEvent);
    const done = feed({
      event: 'interaction.completed',
      data: JSON.stringify({
        event_type: 'interaction.completed',
        interaction: { id: 'int_1', status: 'completed' },
      }),
    } as SSEEvent).find((e) => e.type === 'done');

    expect(done && 'signatures' in done && done.signatures).toEqual([
      { type: 'thought', signature: SIGNATURE },
    ]);
  });

  it('leaves `done` alone when nothing was signed', () => {
    const feed = parse();
    feed({ event: 'step.start', data: JSON.stringify({ event_type: 'step.start', step: { type: 'model_output' } }) } as SSEEvent);
    const done = feed({
      event: 'interaction.completed',
      data: JSON.stringify({
        event_type: 'interaction.completed',
        interaction: { id: 'int_1', status: 'completed' },
      }),
    } as SSEEvent).find((e) => e.type === 'done');
    expect(done && 'signatures' in done ? done.signatures : undefined).toBeUndefined();
  });
});

describe('a failed interaction says why', () => {
  it('lifts `errors[]` onto the response error', () => {
    // Before this, a failed interaction arrived as `finishReason: 'error'` and
    // nothing else: an empty answer, no exception to catch, and no way to tell a
    // content refusal from a platform fault.
    const res = adapter.parseResponse(
      interaction({
        status: 'failed',
        steps: [],
        errors: [{ code: 'https://developers.google.com/errors/internal', message: 'boom' }],
      }),
      1,
    );
    expect(res.finishReason).toBe('error');
    expect(res.error).toEqual({
      code: 'https://developers.google.com/errors/internal',
      message: 'boom',
    });
  });

  it('joins every recorded message, not just the first', () => {
    const res = adapter.parseResponse(
      interaction({
        status: 'failed',
        steps: [],
        errors: [{ message: 'first' }, { message: 'second' }],
      }),
      1,
    );
    expect(res.error?.message).toBe('first; second');
  });

  it('still says SOMETHING when the failure recorded no detail', () => {
    const res = adapter.parseResponse(interaction({ status: 'failed', steps: [] }), 1);
    expect(res.error?.message).toContain('failed');
  });

  it('leaves a completed interaction without an error', () => {
    // `errors[]` is documented as diagnostics, not as the cause. Putting it on
    // `error` for a completed turn would report a successful call as failed; it
    // stays reachable on `response.raw`.
    const res = adapter.parseResponse(interaction({ errors: [{ message: 'a diagnostic' }] }), 1);
    expect(res.error).toBeUndefined();
    expect(res.finishReason).toBe('stop');
  });
});
