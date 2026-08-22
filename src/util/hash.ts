/** FNV-1a, 32-bit. Deterministic, synchronous and dependency-free — used where a
 *  stable short id has to be derived from content rather than from a clock.
 *
 *  Not cryptographic. Collisions are acceptable for naming and bucketing; do not
 *  use it for integrity or security. */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Same value as 8 lowercase hex characters. */
export function fnv1a32Hex(input: string): string {
  return fnv1a32(input).toString(16).padStart(8, '0');
}
