/** WAV container helper unit tests. */

import { describe, expect, it } from 'bun:test';
import {
  ensurePlayableAudio,
  isRawPcmMime,
  parsePcmParams,
  pcmToWav,
} from '../../../src/util/wav';

const str = (b: Uint8Array, start: number, len: number): string =>
  String.fromCharCode(...b.slice(start, start + len));

const u32 = (b: Uint8Array, off: number): number =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, true);
const u16 = (b: Uint8Array, off: number): number =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(off, true);

describe('isRawPcmMime', () => {
  it('matches Google L16 and PCM mimes', () => {
    expect(isRawPcmMime('audio/l16; rate=24000; channels=1')).toBe(true);
    expect(isRawPcmMime('audio/pcm')).toBe(true);
  });

  it('does not match playable containers', () => {
    expect(isRawPcmMime('audio/wav')).toBe(false);
    expect(isRawPcmMime('audio/mpeg')).toBe(false);
  });
});

describe('parsePcmParams', () => {
  it('reads rate and channels', () => {
    expect(parsePcmParams('audio/l16; rate=24000; channels=2')).toEqual({
      sampleRate: 24000,
      channels: 2,
    });
  });

  it('falls back to 24kHz mono', () => {
    expect(parsePcmParams('audio/l16')).toEqual({ sampleRate: 24000, channels: 1 });
  });
});

describe('pcmToWav', () => {
  it('prepends a valid 44-byte RIFF/WAVE header', () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = pcmToWav(pcm, 24000, 1);

    expect(wav.length).toBe(44 + pcm.length);
    expect(str(wav, 0, 4)).toBe('RIFF');
    expect(u32(wav, 4)).toBe(36 + pcm.length);
    expect(str(wav, 8, 4)).toBe('WAVE');
    expect(str(wav, 12, 4)).toBe('fmt ');
    expect(u32(wav, 16)).toBe(16);
    expect(u16(wav, 20)).toBe(1); // PCM
    expect(u16(wav, 22)).toBe(1); // channels
    expect(u32(wav, 24)).toBe(24000); // sample rate
    expect(u32(wav, 28)).toBe(48000); // byte rate = rate * blockAlign(2)
    expect(u16(wav, 32)).toBe(2); // block align
    expect(u16(wav, 34)).toBe(16); // bits per sample
    expect(str(wav, 36, 4)).toBe('data');
    expect(u32(wav, 40)).toBe(pcm.length);
    expect([...wav.slice(44)]).toEqual([...pcm]);
  });
});

describe('ensurePlayableAudio', () => {
  it('wraps raw PCM and switches mime to audio/wav', () => {
    const pcm = new Uint8Array([0, 1, 2, 3]);
    const out = ensurePlayableAudio(pcm, 'audio/l16; rate=24000; channels=1');
    expect(out.mimeType).toBe('audio/wav');
    expect(out.data.length).toBe(44 + pcm.length);
    expect(str(out.data, 0, 4)).toBe('RIFF');
  });

  it('passes through already-playable audio unchanged', () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const out = ensurePlayableAudio(bytes, 'audio/wav');
    expect(out.mimeType).toBe('audio/wav');
    expect(out.data).toBe(bytes);
  });
});
