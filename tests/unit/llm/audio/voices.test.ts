/** resolveVoice — alias mapping + passthrough. */

import { describe, expect, it } from 'bun:test';
import { resolveVoice } from '../../../../src/llm/audio/voices';

describe('resolveVoice', () => {
  it('maps a known alias to the provider voice id', () => {
    expect(resolveVoice('openai', 'warm')).toBe('coral');
    expect(resolveVoice('openai', 'neutral')).toBe('alloy');
    expect(resolveVoice('google', 'neutral')).toBe('Kore');
    expect(resolveVoice('google', 'bright')).toBe('Zephyr');
  });

  it('passes a raw provider voice id through unchanged', () => {
    expect(resolveVoice('openai', 'shimmer')).toBe('shimmer');
    expect(resolveVoice('google', 'Puck')).toBe('Puck');
  });

  it('passes through for an unknown provider', () => {
    expect(resolveVoice('xai', 'whatever')).toBe('whatever');
  });

  it('returns undefined for no voice', () => {
    expect(resolveVoice('openai', undefined)).toBeUndefined();
  });
});
