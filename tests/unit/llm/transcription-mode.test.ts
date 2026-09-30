/** A transcript that came back empty, and a mode that only works on one model.
 *
 *  Two findings from the same probe, on deliberately disfluent audio
 *  ("Um, so, I was — I was thinking, uh, maybe we could…").
 *
 *  **The transcript was being dropped.** `gemini-3.5-transcribe` does not
 *  answer with `parts[].text`. It answers with
 *  `parts[].audioTranscription.text`, and this library read only the former —
 *  so a successful, billed transcription returned an EMPTY string. Nothing
 *  errored; the caller just got nothing.
 *
 *  **`mode` is honoured, but not everywhere.** Measured 2026-09-30:
 *
 *  | model | VERBATIM | SMART |
 *  | --- | --- | --- |
 *  | `gemini-3.5-transcribe` | 4 fillers kept | **0** — all removed, false start cleaned |
 *  | `gemini-3.1-flash-lite` | 4 | 4 — indistinguishable from two runs of no config |
 *
 *  The noise floor matters for reading that: two runs of the SAME config on
 *  the dedicated model were byte-identical, so the VERBATIM/SMART difference
 *  there is signal. On flash-lite two plain runs already differed by
 *  punctuation, so the "difference" between modes there was nothing.
 *
 *  An invalid value is a 400 naming `audio_transcription_config.mode` on both,
 *  which is why "it was accepted" proves nothing on its own.
 */

import { describe, expect, it } from 'bun:test';
import { GoogleAdapter } from '../../../src/llm/providers/google/generate';

const adapter = new GoogleAdapter({ apiKey: 'k' });

describe('a transcription-model response', () => {
  /** What `gemini-3.5-transcribe` actually returns. */
  const TRANSCRIPT = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ audioTranscription: { text: 'Um, so I was thinking uh maybe Tuesday.' } }],
        },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 261, totalTokenCount: 261 },
  };

  it('is read, not dropped', () => {
    // Was `''`: the part has no `text` key at all.
    const r = adapter.parseResponse(TRANSCRIPT, 0);
    expect(r.text).toBe('Um, so I was thinking uh maybe Tuesday.');
    expect(r.content).toEqual([{ type: 'text', text: 'Um, so I was thinking uh maybe Tuesday.' }]);
  });

  it('finishes cleanly rather than looking like an empty failure', () => {
    expect(adapter.parseResponse(TRANSCRIPT, 0).finishReason).toBe('stop');
  });

  it('does not disturb an ordinary text part', () => {
    const r = adapter.parseResponse(
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
        usageMetadata: {},
      },
      0,
    );
    expect(r.text).toBe('hello');
  });

  it('prefers the transcript when a part somehow carries both', () => {
    // Defensive: if a part ever carried both, the transcript is the answer and
    // the other is not.
    const r = adapter.parseResponse(
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ignored', audioTranscription: { text: 'kept' } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {},
      },
      0,
    );
    expect(r.text).toBe('kept');
  });

  it('ignores an audioTranscription with no text', () => {
    const r = adapter.parseResponse(
      {
        candidates: [
          { content: { role: 'model', parts: [{ audioTranscription: {} }] }, finishReason: 'STOP' },
        ],
        usageMetadata: {},
      },
      0,
    );
    expect(r.text).toBe('');
  });
});

describe('the mode reaches the wire', () => {
  function body(providerOptions?: Record<string, unknown>) {
    return adapter.buildRequest({
      model: 'gemini-3.5-transcribe',
      messages: [{ role: 'user', content: 'transcribe' }],
      ...(providerOptions ? { providerOptions } : {}),
    } as never).body as { generationConfig?: Record<string, unknown> };
  }

  it('lands in generationConfig.audioTranscriptionConfig', () => {
    const cfg = body({ audioTranscriptionConfig: { mode: 'SMART' } }).generationConfig;
    expect(cfg?.audioTranscriptionConfig).toEqual({ mode: 'SMART' });
  });

  it('carries VERBATIM just as readily', () => {
    const cfg = body({ audioTranscriptionConfig: { mode: 'VERBATIM' } }).generationConfig;
    expect(cfg?.audioTranscriptionConfig).toEqual({ mode: 'VERBATIM' });
  });

  it('is absent when the caller asked for nothing', () => {
    // An empty config on every completion would be noise on requests that have
    // no audio in them at all.
    expect(body().generationConfig ?? {}).not.toHaveProperty('audioTranscriptionConfig');
    expect(body({}).generationConfig ?? {}).not.toHaveProperty('audioTranscriptionConfig');
  });
});
