/** A safety block that explains itself is worth more than one that does not.
 *
 *  A Responses call can fail INSIDE a 200: `status: 'failed'` with a
 *  `response.error`. There is no exception to catch, so that object is the only
 *  thing the caller ever learns about the failure — and we were keeping two
 *  fields of it.
 *
 *  Two things were lost.
 *
 *  **A numeric code was dropped entirely.** The field was read only when it was
 *  already a string, so `code: 429` became an error with NO code — not a
 *  wrong one, an absent one, which reads as "the provider did not say why".
 *  OpenAI sends both forms; openai-py 3.14 began coercing it for the same
 *  reason.
 *
 *  **`misalignment` was never read.** Added 2026-09 beside the new
 *  `misalignment_policy_violation` code, it carries the explanation for the
 *  block and, sometimes, `steer.message` — a continuation the caller can
 *  actually send. Without it an agent learns only that it was stopped, which is
 *  the difference between a run that recovers and one that ends.
 */

import { describe, expect, it } from 'bun:test';
import { OPENAI_RESPONSES_REGISTRY, openaiMisalignment } from '../../../src/llm/providers/openai/responses-registry';

/** Run the registry's `oaiRespError` against a raw `response` body. */
function errorOf(raw: Record<string, unknown>) {
  const fn = OPENAI_RESPONSES_REGISTRY.transforms?.oaiRespError;
  if (!fn) throw new Error('oaiRespError is not registered');
  return fn(undefined, { req: { raw, out: { content: [], toolCalls: [], reasoningItems: [] } } } as never) as
    | { code?: string; message?: string; misalignment?: Record<string, unknown> }
    | undefined;
}

describe('the error object inside a 200', () => {
  it('is absent when the provider reported no failure', () => {
    expect(errorOf({})).toBeUndefined();
    expect(errorOf({ error: null })).toBeUndefined();
    expect(errorOf({ error: {} })).toBeUndefined();
  });

  it('keeps a string code and message, as before', () => {
    expect(errorOf({ error: { code: 'data_residency_mismatch', message: 'nope' } })).toEqual({
      code: 'data_residency_mismatch',
      message: 'nope',
    });
  });

  it('reads a NUMERIC code as its decimal string', () => {
    // Previously dropped: the caller saw a failure with no code at all.
    expect(errorOf({ error: { code: 429, message: 'slow down' } })).toEqual({
      code: '429',
      message: 'slow down',
    });
  });

  it('reads a numeric code even when it is zero', () => {
    // `0` is falsy, which is how this kind of fix usually still loses one value.
    expect(errorOf({ error: { code: 0, message: 'x' } })?.code).toBe('0');
  });

  it('ignores a code that is neither string nor number', () => {
    expect(errorOf({ error: { code: { nested: true }, message: 'x' } })).toEqual({ message: 'x' });
  });
});

describe('misalignment', () => {
  it('carries the explanation, the classification and the steer', () => {
    expect(
      errorOf({
        error: {
          code: 'misalignment_policy_violation',
          message: 'Blocked by safety systems.',
          misalignment: {
            detailed_explanation: 'The tool call would have emailed the contents of a private file.',
            error_type: 'potentially_unintended_data_transfer',
            steer: { message: 'Ask the user to confirm the recipient before sending.' },
          },
        },
      }),
    ).toEqual({
      code: 'misalignment_policy_violation',
      message: 'Blocked by safety systems.',
      misalignment: {
        detailedExplanation: 'The tool call would have emailed the contents of a private file.',
        errorType: 'potentially_unintended_data_transfer',
        steer: { message: 'Ask the user to confirm the recipient before sending.' },
      },
    });
  });

  it('passes an unknown error_type straight through', () => {
    // The provider documents four values and says clients must accept more, so
    // validating against the four would drop precisely the new ones.
    expect(
      openaiMisalignment({ error_type: 'potentially_unintended_credential_use' })?.misalignment?.errorType,
    ).toBe('potentially_unintended_credential_use');
  });

  it('keeps whichever parts arrived', () => {
    expect(openaiMisalignment({ detailed_explanation: 'why' })).toEqual({
      misalignment: { detailedExplanation: 'why' },
    });
    expect(openaiMisalignment({ steer: { message: 'try this' } })).toEqual({
      misalignment: { steer: { message: 'try this' } },
    });
  });

  it('is absent rather than empty when nothing usable arrived', () => {
    // `misalignment: {}` would read as "a safety system explained itself" when
    // none did.
    expect(openaiMisalignment(undefined)).toBeUndefined();
    expect(openaiMisalignment({})).toBeUndefined();
    expect(openaiMisalignment(null)).toBeUndefined();
    expect(openaiMisalignment('blocked')).toBeUndefined();
    expect(openaiMisalignment({ steer: {} })).toBeUndefined();
    expect(openaiMisalignment({ steer: null })).toBeUndefined();
  });

  it('does not appear on an error that carries none', () => {
    const e = errorOf({ error: { code: 'server_error', message: 'x' } });
    expect(e).not.toHaveProperty('misalignment');
  });
});
