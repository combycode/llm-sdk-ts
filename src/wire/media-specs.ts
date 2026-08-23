/** The media wire specs the RUNTIME loads, resolved and memoised.
 *
 *  A sibling of `chat-specs.ts` and separate from it for the same reason that file
 *  is separate from `registry.ts`: the generated index imports all 71 specs, so any
 *  adapter reaching for it pulls in every family whether or not anything runs them.
 *  The runtime loads one family at a time, as each is migrated, so what ships is
 *  what executes.
 *
 *  Only the leaves are exported — the `*.base` specs exist to be inherited from and
 *  are never built directly, so naming one is a mistake worth catching.
 */

import { resolveSpec, type SpecDelta } from './inherit';
import type { WireSpec } from './interpreter';

import openaiMediaBase from './specs/openai-media/media.base.json' with { type: 'json' };
import openaiImagesBase from './specs/openai-media/images.base.json' with { type: 'json' };
import openaiImagesGenerations from './specs/openai-media/images.generations.json' with { type: 'json' };
import openaiImagesGenerationsDalle from './specs/openai-media/images.generations.dalle.json' with { type: 'json' };
import openaiImagesEdits from './specs/openai-media/images.edits.json' with { type: 'json' };
import openaiAudioSpeech from './specs/openai-media/audio.speech.json' with { type: 'json' };
import openaiVideos from './specs/openai-media/videos.json' with { type: 'json' };

import googleGenerateContentBase from './specs/google-media/generateContent.base.json' with { type: 'json' };
import googlePredictBase from './specs/google-media/predict.base.json' with { type: 'json' };
import googleGeminiImage from './specs/google-media/gemini-image.json' with { type: 'json' };
import googleGeminiImageEdit from './specs/google-media/gemini-image-edit.json' with { type: 'json' };
import googleGeminiTts from './specs/google-media/gemini-tts.json' with { type: 'json' };
import googleImagen from './specs/google-media/imagen.json' with { type: 'json' };
import googleVeo from './specs/google-media/veo.json' with { type: 'json' };

const DELTAS = new Map<string, SpecDelta>(
  (
    [
      openaiMediaBase,
      openaiImagesBase,
      openaiImagesGenerations,
      openaiImagesGenerationsDalle,
      openaiImagesEdits,
      openaiAudioSpeech,
      openaiVideos,
      googleGenerateContentBase,
      googlePredictBase,
      googleGeminiImage,
      googleGeminiImageEdit,
      googleGeminiTts,
      googleImagen,
      googleVeo,
    ] as unknown as SpecDelta[]
  ).map((s) => [s.id, s]),
);

/** Specs that exist only to be extended. Building one directly would produce a
 *  request with no endpoint, which is a silent wrong call rather than an error. */
const ABSTRACT = new Set([
  'openai/media.base',
  'openai/media.images',
  'google/media.generateContent',
  'google/media.predict',
]);

const resolved = new Map<string, WireSpec>();

/** The media spec for `id`, with its inheritance chain applied.
 *
 *  Throws on an unknown or abstract id rather than substituting something
 *  plausible: a quietly wrong endpoint is the failure mode the specs exist to end. */
export function mediaSpec(id: string): WireSpec {
  const hit = resolved.get(id);
  if (hit) return hit;
  if (ABSTRACT.has(id)) {
    throw new Error(`${id} is a base spec and cannot build a request on its own`);
  }
  const spec = resolveSpec(id, DELTAS);
  resolved.set(id, spec);
  return spec;
}

/** Buildable media spec ids — asserted by the tests so this list and the shipped
 *  spec files cannot drift apart unnoticed. */
export const MEDIA_SPEC_IDS: readonly string[] = [...DELTAS.keys()]
  .filter((id) => !ABSTRACT.has(id))
  .sort();
