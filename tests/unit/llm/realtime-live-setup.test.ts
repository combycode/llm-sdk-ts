/** A translator model we shipped and could not ask to translate.
 *
 *  `gemini-3.5-live-translate` has been in the catalog, connectable, and
 *  useless: the Live setup frame carried modalities, a prebuilt voice and a
 *  system instruction, and nothing else. There was no way to say which language
 *  to translate INTO, so the model had nothing to do.
 *
 *  Proved by streaming the same English sentence into two sessions
 *  (2026-09-30), which is the only way to tell — a bogus target language still
 *  returns `setupComplete`, so acceptance says nothing:
 *
 *    no translationConfig        output transcription: ""
 *    targetLanguageCode: 'es'    output transcription: "Buenos días. La reunión se ha"
 *
 *  The difference between no output at all and Spanish.
 *
 *  `echoTargetLanguage` decides what happens when the target language is
 *  ALREADY being spoken — parrot it back, or stay quiet. `false` is the
 *  interesting value and the one a truthy gate would eat, so it is sent
 *  whenever the caller mentions it and omitted only when they do not.
 */

import { describe, expect, it } from 'bun:test';
import { GoogleRealtimeAdapter } from '../../../src/llm/providers/google/realtime';
import type { RealtimeSessionConfig } from '../../../src/llm/realtime/types';

/** A connection just real enough to capture the setup frame. The session
 *  subscribes with `on(...)` and sends on `open`, so both have to exist. */
function fakeConn(sent: string[]) {
  const openCbs = new Set<() => void>();
  return {
    readyState: 1,
    sent,
    send(data: unknown) {
      sent.push(typeof data === 'string' ? data : '<binary>');
    },
    close() {},
    on(type: string, cb: unknown) {
      if (type === 'open') openCbs.add(cb as () => void);
      return () => undefined;
    },
    /** Fire it, which is what makes the adapter emit `setup`. */
    open() {
      for (const cb of openCbs) cb();
    },
  };
}

/** The `setup` frame the adapter sends once the socket opens. */
function setup(config: Partial<RealtimeSessionConfig>) {
  const sent: string[] = [];
  const conn = fakeConn(sent);
  new GoogleRealtimeAdapter({ apiKey: 'k' }).connect(
    { model: 'gemini-3.5-live-translate-preview', ...config } as RealtimeSessionConfig,
    (() => conn) as never,
  );
  conn.open();
  const frame = JSON.parse(sent[0] ?? '{}') as { setup?: Record<string, unknown> };
  return (frame.setup ?? {}) as Record<string, unknown>;
}

const gen = (s: Record<string, unknown>) => (s.generationConfig ?? {}) as Record<string, unknown>;

describe('live translation', () => {
  it('is absent when no target language was named', () => {
    // An empty translationConfig would be asking to translate into nothing.
    expect(gen(setup({}))).not.toHaveProperty('translationConfig');
    expect(gen(setup({ translation: {} }))).not.toHaveProperty('translationConfig');
  });

  it('carries the target language', () => {
    expect(gen(setup({ translation: { targetLanguageCode: 'es' } })).translationConfig).toEqual({
      targetLanguageCode: 'es',
    });
  });

  it('sends echoTargetLanguage: false, which is the useful value', () => {
    // The regression guard. A truthy gate would drop exactly this and the
    // session would parrot back speech already in the target language.
    expect(
      gen(setup({ translation: { targetLanguageCode: 'es', echoTargetLanguage: false } })).translationConfig,
    ).toEqual({ targetLanguageCode: 'es', echoTargetLanguage: false });
  });

  it('sends true as readily', () => {
    expect(
      gen(setup({ translation: { targetLanguageCode: 'fr', echoTargetLanguage: true } })).translationConfig,
    ).toEqual({ targetLanguageCode: 'fr', echoTargetLanguage: true });
  });

  it('omits echoTargetLanguage when the caller said nothing about it', () => {
    // Absent means "the server's default", which is not ours to guess.
    const cfg = gen(setup({ translation: { targetLanguageCode: 'es' } })).translationConfig;
    expect(cfg).not.toHaveProperty('echoTargetLanguage');
  });
});

describe('the other setup fields', () => {
  it('sends enableAffectiveDialog when asked, either way', () => {
    expect(gen(setup({ affectiveDialog: true })).enableAffectiveDialog).toBe(true);
    // `false` is a real choice: it turns the behaviour off explicitly rather
    // than leaving the server to decide.
    expect(gen(setup({ affectiveDialog: false })).enableAffectiveDialog).toBe(false);
    expect(gen(setup({}))).not.toHaveProperty('enableAffectiveDialog');
  });

  it('sends inputAudioTranscription only with a mode', () => {
    expect(setup({ inputTranscription: { mode: 'VERBATIM' } }).inputAudioTranscription).toEqual({
      mode: 'VERBATIM',
    });
    expect(setup({})).not.toHaveProperty('inputAudioTranscription');
    expect(setup({ inputTranscription: {} })).not.toHaveProperty('inputAudioTranscription');
  });
});

describe('the voice, split the same way as TTS', () => {
  it('keeps prebuiltVoiceConfig for a catalog name', () => {
    expect(gen(setup({ voice: 'Kore' })).speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
    });
  });

  it('uses the flat voice for one the caller owns', () => {
    expect(gen(setup({ voice: 'voice_abc', voiceOwned: true })).speechConfig).toEqual({
      voiceConfig: { voice: 'voice_abc' },
    });
  });

  it('sends no speechConfig when no voice was chosen', () => {
    expect(gen(setup({}))).not.toHaveProperty('speechConfig');
  });
});

describe('what was already there still is', () => {
  it('keeps the model, modalities and system instruction', () => {
    const s = setup({ modalities: ['audio'], instructions: 'be brief' });
    expect(s.model).toBe('models/gemini-3.5-live-translate-preview');
    expect(gen(s).responseModalities).toEqual(['AUDIO']);
    expect(s.systemInstruction).toEqual({ parts: [{ text: 'be brief' }] });
  });
});
