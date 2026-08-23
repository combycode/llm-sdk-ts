/** The remaining runtime spec families: embeddings, realtime, batch, files, and
 *  the media adapters that had no builder seam until now.
 *
 *  A sibling of `chat-specs.ts` and `media-specs.ts`, split for the same reason:
 *  the generated `registry.ts` imports all 71 specs, so an adapter reaching for it
 *  drags every family into the bundle whether or not anything executes them. Each
 *  file here loads exactly what its adapters run.
 *
 *  Only leaves are buildable. The `*.base` specs exist to be inherited from and
 *  produce no endpoint of their own, so naming one is a mistake to catch rather
 *  than a request to send.
 */

import { resolveSpec, type SpecDelta } from './inherit';
import type { WireSpec } from './interpreter';

// ── embeddings ───────────────────────────────────────────────────────────────
import embeddingsOpenai from './specs/embeddings/openai.json' with { type: 'json' };
import embeddingsOpenrouter from './specs/embeddings/openrouter.json' with { type: 'json' };
import embeddingsGoogle from './specs/embeddings/google.json' with { type: 'json' };

// ── realtime ─────────────────────────────────────────────────────────────────
import realtimeOpenai from './specs/realtime/openai.json' with { type: 'json' };
import realtimeGoogle from './specs/realtime/google.json' with { type: 'json' };

// ── xai media ────────────────────────────────────────────────────────────────
import xaiMediaBase from './specs/xai-media/base.json' with { type: 'json' };
import xaiImagesBase from './specs/xai-media/images.base.json' with { type: 'json' };
import xaiImagesGenerations from './specs/xai-media/images.generations.json' with { type: 'json' };
import xaiImagesEdits from './specs/xai-media/images.edits.json' with { type: 'json' };
import xaiTts from './specs/xai-media/tts.json' with { type: 'json' };
import xaiVideosGenerations from './specs/xai-media/videos.generations.json' with { type: 'json' };
import xaiVideosEdits from './specs/xai-media/videos.edits.json' with { type: 'json' };
import xaiVideosExtensions from './specs/xai-media/videos.extensions.json' with { type: 'json' };

// ── openrouter media ─────────────────────────────────────────────────────────
import orMediaBase from './specs/openrouter-media/base.json' with { type: 'json' };
import orMediaImage from './specs/openrouter-media/image.json' with { type: 'json' };
import orMediaImageEdit from './specs/openrouter-media/image.edit.json' with { type: 'json' };
import orMediaAudio from './specs/openrouter-media/audio.json' with { type: 'json' };

const DELTAS = new Map<string, SpecDelta>(
  (
    [
      embeddingsOpenai,
      embeddingsOpenrouter,
      embeddingsGoogle,
      realtimeOpenai,
      realtimeGoogle,
      xaiMediaBase,
      xaiImagesBase,
      xaiImagesGenerations,
      xaiImagesEdits,
      xaiTts,
      xaiVideosGenerations,
      xaiVideosEdits,
      xaiVideosExtensions,
      orMediaBase,
      orMediaImage,
      orMediaImageEdit,
      orMediaAudio,
    ] as unknown as SpecDelta[]
  ).map((s) => [s.id, s]),
);

const ABSTRACT = new Set(['xai/media.base', 'xai/images.base', 'openrouter/media.base']);

const resolved = new Map<string, WireSpec>();

/** The service spec for `id`, with its inheritance chain applied. Throws on an
 *  unknown or abstract id rather than substituting something plausible. */
export function serviceSpec(id: string): WireSpec {
  const hit = resolved.get(id);
  if (hit) return hit;
  if (ABSTRACT.has(id)) {
    throw new Error(`${id} is a base spec and cannot build a request on its own`);
  }
  const spec = resolveSpec(id, DELTAS);
  resolved.set(id, spec);
  return spec;
}

/** Buildable ids, asserted by the tests so this list cannot drift from the files. */
export const SERVICE_SPEC_IDS: readonly string[] = [...DELTAS.keys()]
  .filter((id) => !ABSTRACT.has(id))
  .sort();
