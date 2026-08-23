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

// ── batch ────────────────────────────────────────────────────────────────────
import batchAnthropicBase from './specs/batch/anthropic.base.json' with { type: 'json' };
import batchAnthropicSubmit from './specs/batch/anthropic.submit.json' with { type: 'json' };
import batchAnthropicStatus from './specs/batch/anthropic.getStatus.json' with { type: 'json' };
import batchAnthropicResults from './specs/batch/anthropic.getResults.json' with { type: 'json' };
import batchAnthropicCancel from './specs/batch/anthropic.cancel.json' with { type: 'json' };
import batchOpenaiBase from './specs/batch/openai.base.json' with { type: 'json' };
import batchOpenaiUpload from './specs/batch/openai.uploadJsonl.json' with { type: 'json' };
import batchOpenaiStatus from './specs/batch/openai.getStatus.json' with { type: 'json' };
import batchGoogleSubmit from './specs/batch/google.submit.json' with { type: 'json' };
import batchGoogleStatus from './specs/batch/google.getStatus.json' with { type: 'json' };
import batchGoogleCancel from './specs/batch/google.cancel.json' with { type: 'json' };
import batchXaiBase from './specs/batch/xai.base.json' with { type: 'json' };
import batchXaiCreate from './specs/batch/xai.create.json' with { type: 'json' };
import batchXaiAdd from './specs/batch/xai.addRequests.json' with { type: 'json' };
import batchXaiStatus from './specs/batch/xai.getStatus.json' with { type: 'json' };
import batchXaiResults from './specs/batch/xai.getResults.json' with { type: 'json' };
import batchOpenaiCancel from './specs/batch/openai.cancel.json' with { type: 'json' };
import batchOpenaiResults from './specs/batch/openai.getResults.json' with { type: 'json' };
import batchGoogleResults from './specs/batch/google.getResults.json' with { type: 'json' };

// ── files ────────────────────────────────────────────────────────────────────
import filesAnthropicBase from './specs/files/anthropic.base.json' with { type: 'json' };
import filesAnthropicUpload from './specs/files/anthropic.upload.json' with { type: 'json' };
import filesAnthropicDelete from './specs/files/anthropic.delete.json' with { type: 'json' };
import filesAnthropicGetInfo from './specs/files/anthropic.getInfo.json' with { type: 'json' };
import filesAnthropicList from './specs/files/anthropic.list.json' with { type: 'json' };
import filesOpenaiBase from './specs/files/openai.base.json' with { type: 'json' };
import filesOpenaiUpload from './specs/files/openai.upload.json' with { type: 'json' };
import filesOpenaiDelete from './specs/files/openai.delete.json' with { type: 'json' };
import filesOpenaiGetInfo from './specs/files/openai.getInfo.json' with { type: 'json' };
import filesOpenaiList from './specs/files/openai.list.json' with { type: 'json' };
import filesGoogleStartUpload from './specs/files/google.startUpload.json' with { type: 'json' };
import filesGoogleDelete from './specs/files/google.delete.json' with { type: 'json' };
import filesGoogleGetInfo from './specs/files/google.getInfo.json' with { type: 'json' };
import filesGoogleList from './specs/files/google.list.json' with { type: 'json' };
import filesXaiUpload from './specs/files/xai.upload.json' with { type: 'json' };

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
      batchAnthropicBase,
      batchAnthropicSubmit,
      batchAnthropicStatus,
      batchAnthropicResults,
      batchAnthropicCancel,
      batchOpenaiBase,
      batchOpenaiUpload,
      batchOpenaiStatus,
      batchGoogleSubmit,
      batchGoogleStatus,
      batchGoogleCancel,
      batchXaiBase,
      batchXaiCreate,
      batchXaiAdd,
      batchXaiStatus,
      batchXaiResults,
      batchOpenaiCancel,
      batchOpenaiResults,
      batchGoogleResults,
      filesAnthropicBase,
      filesAnthropicUpload,
      filesAnthropicDelete,
      filesAnthropicGetInfo,
      filesAnthropicList,
      filesOpenaiBase,
      filesOpenaiUpload,
      filesOpenaiDelete,
      filesOpenaiGetInfo,
      filesOpenaiList,
      filesGoogleStartUpload,
      filesGoogleDelete,
      filesGoogleGetInfo,
      filesGoogleList,
      filesXaiUpload,
    ] as unknown as SpecDelta[]
  ).map((s) => [s.id, s]),
);

const ABSTRACT = new Set([
  'xai/media.base',
  'xai/images.base',
  'openrouter/media.base',
  'anthropic/batch.base',
  'openai/batch.base',
  'xai/batch.base',
  'anthropic/files.base',
  'openai/files.base',
]);

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
