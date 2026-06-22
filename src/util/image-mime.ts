/** Detect an image's MIME type from its leading magic bytes.
 *
 *  Providers sometimes return a generated image with the WRONG declared mime
 *  (e.g. xAI hands back JPEG bytes labeled "image/png"). When that image is then
 *  forwarded as a source for image-to-video / image-edit, strict validators like
 *  Google Veo compare the declared mime against the actual bytes and reject the
 *  request with a 400. Sniffing the bytes lets us self-correct the label. */
export function sniffImageMime(b: Uint8Array): string | undefined {
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png';
  }
  // GIF: "GIF8"
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return 'image/gif';
  }
  // WEBP: "RIFF"????"WEBP"
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return undefined;
}
