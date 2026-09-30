/** A voice you own, and a conversation between two of them.
 *
 *  `voice` was a string: an alias we map (`'warm'`) or a provider catalog name
 *  (`'Kore'`). A custom voice has neither — its id (`voice_…`) is issued when
 *  the voice is created and is not a name anyone could guess. So the type
 *  widens to `string | { id }`, additively: a string means exactly what it
 *  always meant, and the request it produces is byte-for-byte the one it
 *  produced before.
 *
 *  Which wire field carries it is measured, not assumed (2026-09-30):
 *
 *  - `prebuiltVoiceConfig.voiceName` is what we have always sent, and still is
 *    for a catalog name.
 *  - the flat `voiceConfig.voice` is what Google validates custom ids against —
 *    a bogus one returns `404 The voice was not found or the caller does not
 *    have permission to access it`, which is the right answer arriving at the
 *    right validator.
 *
 *  **Multi-speaker is one feature, not two.** A request carrying
 *  `multiSpeakerVoiceConfig` without a speaker on every text part is refused:
 *  *"Multi-speaker generation requests must specify speech_metadata.speaker for
 *  each text part in the contents."* So a caller gives `segments` once and the
 *  adapter derives both halves from them — there is no way to supply one and
 *  forget the other.
 */

import { describe, expect, it } from 'bun:test';
import { GoogleMediaAdapter } from '../../../src/llm/providers/google/media';
import { isOwnedVoice, resolveVoice } from '../../../src/llm/audio/voices';

const adapter = new GoogleMediaAdapter({ apiKey: 'k' });

function tts(params: Record<string, unknown>, input = 'hello') {
  const body = adapter.buildAudioRequest({ provider: 'google', input, params } as never, 'gemini-3.8-flash-tts')
    .body as {
    contents: Array<{ parts: Array<Record<string, unknown>> }>;
    generationConfig: { speechConfig: Record<string, unknown> };
  };
  return { parts: body.contents[0]?.parts ?? [], speech: body.generationConfig.speechConfig };
}

describe('resolveVoice with the widened type', () => {
  it('still maps an alias and passes a catalog name through', () => {
    expect(resolveVoice('google', 'warm')).toBe('Aoede');
    expect(resolveVoice('google', 'Kore')).toBe('Kore');
    expect(resolveVoice('google', undefined)).toBeUndefined();
  });

  it('returns an owned id untouched', () => {
    // Never alias-mapped: the aliases translate four adjectives into a
    // catalog, and a custom id is already the final answer.
    expect(resolveVoice('google', { id: 'voice_abc123' })).toBe('voice_abc123');
  });

  it('treats an empty id as no voice at all', () => {
    expect(resolveVoice('google', { id: '' })).toBeUndefined();
    expect(isOwnedVoice({ id: '' })).toBe(false);
    expect(isOwnedVoice('Kore')).toBe(false);
    expect(isOwnedVoice({ id: 'voice_x' })).toBe(true);
  });
});

describe('one voice', () => {
  it('keeps the existing wire shape for a catalog name', () => {
    // The compatibility guard. This request must not change.
    expect(tts({ voice: 'Kore' }).speech).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
    });
  });

  it('resolves an alias down the same path', () => {
    expect(tts({ voice: 'warm' }).speech).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
    });
  });

  it('falls back to the default when no voice was named', () => {
    expect(tts({}).speech).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } });
  });

  it('sends an owned voice on the field that validates them', () => {
    expect(tts({ voice: { id: 'voice_abc123' } }).speech).toEqual({
      voiceConfig: { voice: 'voice_abc123' },
    });
  });

  it('carries the input as a single part', () => {
    expect(tts({ voice: 'Kore' }, 'read this').parts).toEqual([{ text: 'read this' }]);
  });
});

describe('several voices', () => {
  const CAST = [
    { name: 'Ada', voice: 'Kore' },
    { name: 'Grace', voice: { id: 'voice_grace' } },
  ];
  const SCRIPT = [
    { speaker: 'Ada', text: 'The meeting is Tuesday.', style: 'brisk' },
    { speaker: 'Grace', text: 'I will be there.' },
  ];

  it('builds the speaker configs, each with its own kind of voice', () => {
    expect(tts({ speakers: CAST, segments: SCRIPT }).speech).toEqual({
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs: [
          { speaker: 'Ada', voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          { speaker: 'Grace', voiceConfig: { voice: 'voice_grace' } },
        ],
      },
    });
  });

  it('puts the speaker on every part, which the provider requires', () => {
    // Without this the request is refused outright, so it is not optional
    // polish — it is the other half of the same feature.
    expect(tts({ speakers: CAST, segments: SCRIPT }).parts).toEqual([
      { text: 'The meeting is Tuesday.', speechMetadata: { speaker: 'Ada', style: 'brisk' } },
      { text: 'I will be there.', speechMetadata: { speaker: 'Grace' } },
    ]);
  });

  it('omits style when a segment did not ask for one', () => {
    const [, second] = tts({ speakers: CAST, segments: SCRIPT }).parts;
    expect(second?.speechMetadata).toEqual({ speaker: 'Grace' });
  });

  it('lets a cast win over a single voice', () => {
    // Asking for both is a contradiction; the cast is the more specific ask.
    const { speech } = tts({ voice: 'Kore', speakers: CAST, segments: SCRIPT });
    expect(speech).toHaveProperty('multiSpeakerVoiceConfig');
    expect(speech).not.toHaveProperty('voiceConfig');
  });

  it('ignores a speaker with no name', () => {
    const { speech } = tts({ speakers: [{ name: '', voice: 'Kore' }, ...CAST], segments: SCRIPT });
    const cfgs = (speech.multiSpeakerVoiceConfig as { speakerVoiceConfigs: unknown[] }).speakerVoiceConfigs;
    expect(cfgs).toHaveLength(2);
  });

  it('falls back to the plain input when segments are empty', () => {
    // An empty script is not a multi-speaker request.
    expect(tts({ segments: [] }, 'just this').parts).toEqual([{ text: 'just this' }]);
  });

  it('drops a segment with no text rather than sending an empty part', () => {
    const { parts } = tts({ speakers: CAST, segments: [{ speaker: 'Ada' }, ...SCRIPT] });
    expect(parts).toHaveLength(2);
  });
});
