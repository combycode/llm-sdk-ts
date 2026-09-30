import type { VoiceRef } from '../../plugins/media/types';

/** Hybrid voice resolution (A3): a small per-provider alias table maps a unified
 *  alias to that provider's voice id; any unrecognized string passes through
 *  unchanged, so raw provider voice ids always work. */

/** Unified voice aliases. Values are real provider voice ids (verified against the
 *  provider SDKs / docs). Unknown voices are passed through verbatim. */
const VOICE_ALIASES: Record<string, Record<string, string>> = {
  openai: { neutral: 'alloy', warm: 'coral', bright: 'shimmer', deep: 'echo' },
  google: { neutral: 'Kore', warm: 'Aoede', bright: 'Zephyr', deep: 'Charon' },
  // xai has no first-party TTS voices today.
};

export const VOICE_ALIASES_LIST = ['neutral', 'warm', 'bright', 'deep'] as const;
export type VoiceAlias = (typeof VOICE_ALIASES_LIST)[number];

/** Map an alias to the provider's voice id, else return the input unchanged.
 *
 *  A `{ id }` is a voice the caller OWNS -- a custom voice whose id is not a
 *  name anyone could guess. It is never alias-mapped: the aliases translate our
 *  four adjectives into a provider's catalog names, and a custom id is already
 *  the final answer. Returned as-is. */
export function resolveVoice(provider: string, voice: VoiceRef | undefined): string | undefined {
  if (!voice) return undefined;
  if (typeof voice === 'object') return voice.id || undefined;
  return VOICE_ALIASES[provider]?.[voice] ?? voice;
}

/** Is this a voice the caller owns, rather than one from a provider catalog?
 *
 *  Decides which wire field carries it. Measured 2026-09-30: Google's flat
 *  `voiceConfig.voice` accepts BOTH a catalog name and a custom id (a bogus one
 *  returns `404 The voice was not found or the caller does not have permission
 *  to access it`), while `prebuiltVoiceConfig.voiceName` is the field we have
 *  always sent. So a plain string keeps its existing path byte-for-byte and
 *  only a `{ id }` takes the new one. */
export function isOwnedVoice(voice: VoiceRef | undefined): boolean {
  return typeof voice === 'object' && voice !== null && typeof voice.id === 'string' && voice.id.length > 0;
}
