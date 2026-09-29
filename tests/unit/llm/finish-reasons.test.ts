/** Why a turn ended — and the rule that the answer cannot depend on HOW it was fetched.
 *
 *  The stream registry carried its own copy of Google's terminal-reason table
 *  holding exactly one entry, `MAX_TOKENS`. Everything else fell through to
 *  `stop`, so the same response finished differently depending on whether it was
 *  streamed: a SAFETY block read as a clean finish with no content, and
 *  MALFORMED_FUNCTION_CALL never reached `reflectAndRetry` on a stream.
 *
 *  `FinishReason` is OPEN by design (CONSTITUTION R1), which is what lets a new
 *  terminal state keep its own name instead of being folded into `stop` (a claim
 *  the turn ended cleanly) or `length` (a claim about tokens). */

import { describe, expect, it } from 'bun:test';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';
import { GOOGLE_FINISH } from '../../../src/llm/providers/google/response-registry';
import { OpenAIResponsesAdapter } from '../../../src/llm/providers/openai/responses';

const cfg = { apiKey: 'k' };

const buffered = (finishReason: string) =>
  new GoogleAdapter(cfg).parseResponse({
    candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason }],
    usageMetadata: {},
  } as never, 1).finishReason;

const streamed = (finishReason: string) => {
  const parse = new GoogleAdapter(cfg).createStreamParser();
  const events = parse({
    data: JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [] }, finishReason }],
    }),
  });
  return events.find((e) => e.type === 'done')?.finishReason;
};

describe('Google terminal reasons', () => {
  it('reports TOO_MANY_TOOL_CALLS under its own name, not as a clean stop', () => {
    expect(buffered('TOO_MANY_TOOL_CALLS')).toBe('too_many_tool_calls');
  });

  it('still maps the reasons it already knew', () => {
    expect(buffered('MAX_TOKENS')).toBe('length');
    expect(buffered('SAFETY')).toBe('content_filter');
    expect(buffered('MALFORMED_FUNCTION_CALL')).toBe('malformed_tool_call');
  });

  it('falls back to stop for a reason this SDK has never seen', () => {
    expect(buffered('SOMETHING_GOOGLE_INVENTED_TODAY')).toBe('stop');
  });
});

describe('streaming cannot change the answer', () => {
  // The structural assertion: not "these four agree", but EVERY key agrees.
  it.each(Object.keys(GOOGLE_FINISH))('%s finishes the same either way', (reason) => {
    expect(streamed(reason)).toBe(buffered(reason));
  });

  it('and SAFETY specifically is no longer a clean stop on a stream', () => {
    expect(streamed('SAFETY')).toBe('content_filter');
  });

  it('an unknown reason still falls back to stop on both paths', () => {
    expect(streamed('NEVER_SEEN')).toBe('stop');
    expect(buffered('NEVER_SEEN')).toBe('stop');
  });
});

describe('OpenAI incomplete_details.reason', () => {
  const finish = (reason: string) =>
    new OpenAIResponsesAdapter(cfg).parseResponse({
      id: 'r',
      status: 'incomplete',
      incomplete_details: { reason },
      output: [],
      usage: {},
    } as never, 1).finishReason;

  it('only max_output_tokens means what `length` means', () => {
    expect(finish('max_output_tokens')).toBe('length');
  });

  it('a MESSAGE cap is not a token cap', () => {
    expect(finish('max_messages')).toBe('max_messages');
  });

  /** Steering finishes a response and a successor `response.created` follows it
   *  automatically, so reporting `length` claimed a truncation that never
   *  happened and hid the fact that more is coming. */
  it('steered keeps its own name', () => {
    expect(finish('steered')).toBe('steered');
  });

  it('content_filter is unchanged', () => {
    expect(finish('content_filter')).toBe('content_filter');
  });
});
