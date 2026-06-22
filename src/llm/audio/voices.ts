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

/** Map an alias to the provider's voice id, else return the input unchanged. */
export function resolveVoice(provider: string, voice: string | undefined): string | undefined {
  if (!voice) return undefined;
  return VOICE_ALIASES[provider]?.[voice] ?? voice;
}
