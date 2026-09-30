/** Asking for a video with no sound, and choosing the voice that speaks.
 *
 *  xAI's video models generate an audio track by DEFAULT. So the useful thing
 *  `generateAudio` does is carry `false` — and `false` is exactly the value a
 *  presence gate throws away. Mapped with `presence: 'defined'` for that
 *  reason: a `truthy` gate would have sent the flag only when it agreed with
 *  the default, which is the one case where sending it changes nothing.
 *
 *  `referenceAudios` conditions the generated speech on voices from xAI's own
 *  text-to-speech catalog (`[{ voiceId: 'ara' }]`, at most three). The wire
 *  shape is `AudioUrlContent`, whose `source` is a protobuf `oneof` — so an
 *  entry with no voice id is not an empty object the server tolerates, it is a
 *  request it has to reject. Those entries are dropped instead.
 */

import { describe, expect, it } from 'bun:test';
import { XAIMediaAdapter } from '../../../src/llm/providers/xai/media';

const adapter = new XAIMediaAdapter({ apiKey: 'k' });

function body(params?: Record<string, unknown>) {
  const req = { provider: 'xai', prompt: 'a cat', ...(params ? { params } : {}) } as never;
  return adapter.buildVideoRequest(req, 'grok-imagine-video-1.5').body as Record<string, unknown>;
}

describe('generateAudio', () => {
  it('is absent when the caller did not ask', () => {
    // Absent, not `true`: the provider's default is its own to choose, and
    // restating it would freeze today's default into every request we send.
    expect(body()).not.toHaveProperty('generate_audio');
    expect(body({})).not.toHaveProperty('generate_audio');
  });

  it('sends FALSE — the reason the flag exists', () => {
    // The regression guard. `presence: 'truthy'` here would drop this silently
    // and the caller would get a video with sound.
    expect(body({ generateAudio: false }).generate_audio).toBe(false);
  });

  it('sends true when asked explicitly', () => {
    expect(body({ generateAudio: true }).generate_audio).toBe(true);
  });
});

describe('referenceAudios', () => {
  it('becomes xAI voice references', () => {
    expect(body({ referenceAudios: [{ voiceId: 'ara' }, { voiceId: 'rex' }] }).reference_audios).toEqual([
      { voice_id: 'ara' },
      { voice_id: 'rex' },
    ]);
  });

  it('is absent when not asked for', () => {
    expect(body()).not.toHaveProperty('reference_audios');
  });

  it('is absent rather than empty when nothing usable arrived', () => {
    // `reference_audios: []` is a different request from not asking for
    // reference audio, and the empty one has no meaning to send.
    expect(body({ referenceAudios: [] })).not.toHaveProperty('reference_audios');
    expect(body({ referenceAudios: [{ voiceId: '' }] })).not.toHaveProperty('reference_audios');
    expect(body({ referenceAudios: 'ara' })).not.toHaveProperty('reference_audios');
  });

  it('drops an entry with no voice id rather than sending an empty one', () => {
    // `AudioUrlContent.source` is a protobuf oneof; `{}` selects no branch.
    expect(body({ referenceAudios: [{ voiceId: 'ara' }, {}] }).reference_audios).toEqual([{ voice_id: 'ara' }]);
  });
});

describe('the rest of the video request is untouched', () => {
  it('still carries prompt, model and the existing params', () => {
    const b = body({ duration: 6, aspectRatio: '16:9', resolution: '1080p', generateAudio: false });
    expect(b.prompt).toBe('a cat');
    expect(b.model).toBe('grok-imagine-video-1.5');
    expect(b.duration).toBe(6);
    expect(b.aspect_ratio).toBe('16:9');
    expect(b.resolution).toBe('1080p');
    expect(b.generate_audio).toBe(false);
  });
});
