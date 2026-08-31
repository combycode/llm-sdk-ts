/** Byte-sniffing for audio, and the regression that made it necessary.
 *
 *  OpenAI chat completions return `message.audio` with no `format` key, so the
 *  adapter's `audio/${format ?? 'wav'}` labelled every clip 'audio/wav' whatever
 *  it actually was. The corpus cell `openai/completions::media.audio` requests
 *  mp3, receives `ID3`-prefixed bytes, and used to report wav. */
import { describe, expect, it } from 'bun:test';
import { sniffAudioMime } from '../../../src/util/audio-mime';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string, ...rest: number[]) =>
  new Uint8Array([...[...s].map((c) => c.charCodeAt(0)), ...rest]);

describe('sniffAudioMime', () => {
  it('reads an ID3-tagged mp3 — the exact shape OpenAI returns', () => {
    // 49 44 33 04 is what the recorded cell actually starts with.
    expect(sniffAudioMime(bytes(0x49, 0x44, 0x33, 0x04, 0x00, 0x00))).toBe('audio/mpeg');
  });

  it('reads a bare MPEG frame sync (mp3 with no ID3 tag)', () => {
    expect(sniffAudioMime(bytes(0xff, 0xfb, 0x90, 0x00))).toBe('audio/mpeg');
  });

  it('reads wav, and needs WAVE — not RIFF alone', () => {
    expect(sniffAudioMime(ascii('RIFF', 0, 0, 0, 0, ...ascii('WAVE')))).toBe('audio/wav');
    // RIFF is also AVI and WEBP; without the WAVE tag this must not claim audio.
    expect(sniffAudioMime(ascii('RIFF', 0, 0, 0, 0, ...ascii('AVI ')))).toBeUndefined();
  });

  it('reads ogg (the container Opus arrives in) and flac', () => {
    expect(sniffAudioMime(ascii('OggS', 0, 0))).toBe('audio/ogg');
    expect(sniffAudioMime(ascii('fLaC', 0, 0))).toBe('audio/flac');
  });

  it('prefers ADTS aac over the MPEG sync it also matches', () => {
    // 0xFF 0xF1 satisfies the (b[1] & 0xE0) === 0xE0 mp3 mask too, so ORDER is
    // load-bearing: checked the other way round, every aac clip reads as mpeg.
    expect(sniffAudioMime(bytes(0xff, 0xf1, 0x50, 0x80))).toBe('audio/aac');
    expect(sniffAudioMime(bytes(0xff, 0xf9, 0x50, 0x80))).toBe('audio/aac');
  });

  it('returns undefined rather than guessing, so the caller can fall back', () => {
    expect(sniffAudioMime(bytes(0x00, 0x01, 0x02, 0x03))).toBeUndefined();
    expect(sniffAudioMime(bytes())).toBeUndefined();
    expect(sniffAudioMime(bytes(0x49))).toBeUndefined(); // truncated "I" of ID3
  });
});
