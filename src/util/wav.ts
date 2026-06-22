/** WAV (RIFF) container helpers.
 *
 *  Some providers return raw, header-less PCM samples — notably Google TTS,
 *  which emits `audio/l16; rate=24000; channels=1`. Players that expect a
 *  container (browsers' <audio>, most audio libraries) can't read bare PCM,
 *  so we wrap it in a minimal 44-byte WAV header. */

/** True for raw PCM mime types that need a WAV container (e.g. Google's L16). */
export function isRawPcmMime(mime: string): boolean {
  return /\b(l16|pcm)\b/i.test(mime);
}

/** Parse `rate=` / `channels=` params out of an L16 mime, with sane defaults. */
export function parsePcmParams(mime: string): { sampleRate: number; channels: number } {
  const sampleRate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? '24000');
  const channels = Number(/channels=(\d+)/.exec(mime)?.[1] ?? '1');
  return { sampleRate, channels };
}

/** Prepend a 44-byte WAV header to little-endian 16-bit PCM samples. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44 + pcm.length);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, pcm.length, true);
  new Uint8Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}

/** If `mime` is raw PCM, return WAV-wrapped bytes + `audio/wav`; else unchanged. */
export function ensurePlayableAudio(
  data: Uint8Array,
  mime: string,
): { data: Uint8Array; mimeType: string } {
  if (!isRawPcmMime(mime)) return { data, mimeType: mime };
  const { sampleRate, channels } = parsePcmParams(mime);
  return { data: pcmToWav(data, sampleRate, channels), mimeType: 'audio/wav' };
}
