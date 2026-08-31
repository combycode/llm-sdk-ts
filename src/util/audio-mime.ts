/** Detect an audio clip's MIME type from its leading magic bytes.
 *
 *  Same problem as `sniffImageMime`, from the opposite direction. OpenAI's chat
 *  completions return `message.audio` as `{ id, data, expires_at, transcript }`
 *  and NO `format` field, so the adapter's `audio/${format ?? 'wav'}` fell through
 *  to the default every single time: request mp3, receive mp3 bytes (`ID3...`),
 *  and get told it is `audio/wav`. Anything that trusts the label — an <audio>
 *  element, a file written to disk, a follow-up upload with a strict validator —
 *  is then working from a lie.
 *
 *  The bytes are the only honest source here, and the caller's requested format is
 *  not available at parse time.
 *
 *  Returns the CONTAINER, which is what a player needs: Opus arrives inside Ogg
 *  and is reported as `audio/ogg`. */
export function sniffAudioMime(b: Uint8Array): string | undefined {
  // MP3 with an ID3 tag: "ID3"
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg';
  // WAV: "RIFF"????"WAVE"
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x41 &&
    b[10] === 0x56 &&
    b[11] === 0x45
  ) {
    return 'audio/wav';
  }
  // Ogg (Opus / Vorbis): "OggS"
  if (b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) {
    return 'audio/ogg';
  }
  // FLAC: "fLaC"
  if (b.length >= 4 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) {
    return 'audio/flac';
  }
  // AAC in an ADTS frame: FF F1 (MPEG-4) or FF F9 (MPEG-2). Checked BEFORE the
  // bare MPEG sync below, because ADTS also satisfies that mask.
  if (b.length >= 2 && b[0] === 0xff && (b[1] === 0xf1 || b[1] === 0xf9)) return 'audio/aac';
  // MP3 with no ID3 tag: an MPEG frame sync, eleven set bits.
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return undefined;
}
