/** The agent's final answer excludes commentary.
 *
 *  This is the bug `phase` exists to fix: codex-family models narrate before answering, and
 *  `response.text` is the concatenation of both — so an agent's final output used to contain its
 *  own thinking-out-loud. Parsing the field was only half the job; this is the half that matters to
 *  a caller. */

import { describe, expect, it } from 'bun:test';
import { contentText, finalAnswerText } from '../../../src/llm/types/messages';
import type { Content } from '../../../src/llm/types/messages';
import { accumulateStreamEvent, buildStepResponse, makeStepState } from '../../../src/agent/loop-internals';
import type { StreamEvent } from '../../../src/llm/types/stream';

describe('finalAnswerText', () => {
  it('drops commentary and keeps the answer', () => {
    const content: Content = [
      { type: 'text', text: 'let me check…', phase: 'commentary' },
      { type: 'text', text: 'It is 21°C.', phase: 'final_answer' },
    ];
    expect(finalAnswerText(content)).toBe('It is 21°C.');
    // contentText is unchanged — callers who want everything still get everything.
    expect(contentText(content)).toBe('let me check…It is 21°C.');
  });

  it('is identical to contentText when no phase is reported', () => {
    const content: Content = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ];
    expect(finalAnswerText(content)).toBe(contentText(content));
  });

  it('keeps text under an UNRECOGNISED phase rather than dropping it', () => {
    // The vocabulary is open (R1). Keeping only 'final_answer' would silently discard the answer
    // the day a provider introduces a third phase; excluding only 'commentary' cannot.
    const content: Content = [{ type: 'text', text: 'important', phase: 'summary_of_some_kind' }];
    expect(finalAnswerText(content)).toBe('important');
  });

  it('passes a plain string through', () => {
    expect(finalAnswerText('just text')).toBe('just text');
  });
});

describe('streaming step accumulation', () => {
  const text = (t: string, phase?: string): StreamEvent =>
    ({ type: 'text', text: t, ...(phase ? { phase } : {}) }) as StreamEvent;

  it('keeps commentary out of the step answer but still yields it to the consumer', () => {
    const state = makeStepState();
    const yielded = [
      accumulateStreamEvent(text('thinking…', 'commentary'), state),
      accumulateStreamEvent(text('the answer', 'final_answer'), state),
    ];

    expect(state.stepText).toBe('the answer');
    expect(state.stepCommentary).toBe('thinking…');
    // The consumer still sees both deltas — it may well want to render the narration live.
    expect(yielded.map((e) => e && 'text' in e && e.text)).toEqual(['thinking…', 'the answer']);
  });

  it('preserves commentary in the assembled content as its own phase-tagged part', () => {
    const state = makeStepState();
    accumulateStreamEvent(text('narration', 'commentary'), state);
    accumulateStreamEvent(text('answer', 'final_answer'), state);

    const { response } = buildStepResponse(state, 'gpt-5.5-codex', performance.now());

    expect(response.text).toBe('answer');
    expect(response.content).toEqual([
      { type: 'text', text: 'narration', phase: 'commentary' },
      { type: 'text', text: 'answer', phase: 'final_answer' },
    ]);
  });

  it('does not invent a phase for a model that reports none', () => {
    const state = makeStepState();
    accumulateStreamEvent(text('hello'), state);
    const { response } = buildStepResponse(state, 'gpt-5.5', performance.now());

    expect(response.text).toBe('hello');
    expect(response.content).toEqual([{ type: 'text', text: 'hello' }]);
  });
});
